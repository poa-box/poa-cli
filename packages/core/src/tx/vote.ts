/**
 * Vote domain tx builders — ports of the `pop vote *` write commands.
 *
 * Level 1 (pure, sync): buildVote, buildAnnounceWinner — plus
 * buildGovernanceProposal in ./governance (the Level-1 builder for
 * createProposal itself).
 *
 * Level 2 (resolved, async): createProposalIntent, castVoteIntent,
 * announceWinnerIntent, executeProposalIntent, and the three governance-wrap
 * consumers proposeQuorumIntent / proposeConfigIntent / proposeClassesIntent.
 *
 * Receipt parsing (parseProposalCreatedLogs lives in ./governance;
 * parseAnnounceReceiptLogs here) and the callStatic announce probe are
 * exported because "tx mined" is NOT success for announceWinner — the
 * Executor swallows failed sub-calls.
 */

import { ethers } from 'ethers';
import type { TxIntent } from './intent';
import {
  buildGovernanceProposal,
  encodeExecutorCall,
  ExecutionCall,
} from './governance';
import { getAbi } from '../contracts';
import { ipfsCidToBytes32, formatAddress } from '../encoding';
import { formatToken } from '../format';
import { pinJson } from '../ipfs';
import type { PopContext } from '../context';
import { resolveOrgModules, OrgModules } from '../reads/resolve';
import { resolveProposalId } from '../reads/vote';
import {
  buildProposalMetadata,
  serializeProposalMetadata,
  ProposalMetadata,
} from '../metadata/proposal';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';

export type VotingType = 'hybrid' | 'dd';
export type VotingAbiName = 'HybridVotingNew' | 'DirectDemocracyVotingNew';

// ────────────────────────── Level 1 — pure builders ──────────────────────────

export interface VoteArgs {
  votingAddress: string;
  votingAbiName: VotingAbiName;
  proposalId: ethers.BigNumberish;
  /** Option indices voted for (must pair with weights). */
  optionIndices: number[];
  /** Percentage weights — the contract requires them to sum to exactly 100. */
  weights: number[];
  orgId?: string;
}

/**
 * Port of `pop vote cast` — src/commands/vote/cast.ts:
 * HybridVotingNew|DirectDemocracyVotingNew.vote(proposalId, optionIndices, weights).
 */
export function buildVote(a: VoteArgs): TxIntent {
  return {
    to: a.votingAddress,
    abi: getAbi(a.votingAbiName),
    method: 'vote',
    args: [a.proposalId, a.optionIndices, a.weights],
    meta: {
      domain: 'vote',
      action: 'cast',
      orgId: a.orgId,
      summary: {
        proposalId: String(a.proposalId),
        options: a.optionIndices.join(','),
        weights: a.weights.join(','),
      },
    },
  };
}

export interface AnnounceWinnerArgs {
  votingAddress: string;
  votingAbiName: VotingAbiName;
  proposalId: ethers.BigNumberish;
  orgId?: string;
  /** meta.action override — 'announce' (default) | 'execute' | 'announce-all'. */
  action?: string;
}

/**
 * Port of `pop vote announce` / `pop vote announce-all` / `pop vote execute`
 * — src/commands/vote/announce.ts, announce-all.ts, execute.ts:
 * HybridVotingNew|DirectDemocracyVotingNew.announceWinner(proposalId).
 *
 * DESTRUCTIVE: irreversibly finalizes the vote and executes the winning
 * option's calls through the Executor. Hosts should (a) callStatic-probe
 * first (announceWinnerProbe) and (b) scan the receipt with
 * parseAnnounceReceiptLogs — the outer tx can succeed while the proposal's
 * calls reverted.
 */
export function buildAnnounceWinner(a: AnnounceWinnerArgs): TxIntent {
  return {
    to: a.votingAddress,
    abi: getAbi(a.votingAbiName),
    method: 'announceWinner',
    args: [a.proposalId],
    meta: {
      domain: 'vote',
      action: a.action ?? 'announce',
      orgId: a.orgId,
      summary: { proposalId: String(a.proposalId) },
    },
  };
}

// ────────────────────── receipt parsing + announce probe ──────────────────────

/**
 * Port of `parseAnnounceReceipt` (src/commands/vote/helpers.ts), decoupled
 * from TxResult: takes the parsed receipt logs. The Executor catches failed
 * sub-calls and emits CallFailed / ProposalExecutionFailed while the OUTER tx
 * still succeeds — callers MUST treat innerFailure as an execution failure
 * even though the transaction mined successfully.
 */
export function parseAnnounceReceiptLogs(
  logs: Array<{ name: string; args?: any }> | undefined | null
): {
  winningOption?: string;
  valid?: boolean;
  executed: boolean;
  innerFailure: boolean;
  failedCalls: Array<{ index?: string; data?: string }>;
} {
  const parsed = logs ?? [];
  const winnerEvent = parsed.find(l => l.name === 'Winner');
  const executedEvent = parsed.find(l => l.name === 'ProposalExecuted');
  const callFailedEvents = parsed.filter(l => l.name === 'CallFailed');
  const execFailedEvent = parsed.find(l => l.name === 'ProposalExecutionFailed');
  return {
    winningOption: winnerEvent?.args?.winningIdx?.toString(),
    valid: winnerEvent?.args?.valid,
    executed: Boolean(executedEvent) || Boolean(winnerEvent?.args?.executed),
    innerFailure: callFailedEvents.length > 0 || Boolean(execFailedEvent),
    failedCalls: callFailedEvents.map(e => ({
      index: e.args?.index?.toString(),
      data: e.args?.lowLevelData || e.args?.data,
    })),
  };
}

/**
 * Port of `announceWinnerProbe` (src/commands/vote/helpers.ts): callStatic
 * probe shared by announce/execute pre-flights — would announceWinner(id)
 * revert right now (voting still open, already executed, quorum edge...)?
 * Returns the decoded reason on failure. This is an RPC revert predictor:
 * per the architecture rules it must stay RPC, never subgraph.
 */
export async function announceWinnerProbe(
  contract: ethers.Contract,
  proposalId: number | string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await contract.callStatic.announceWinner(proposalId);
    return { ok: true };
  } catch (err: any) {
    const reason = err?.errorName || err?.reason || err?.error?.reason || err?.message || 'unknown';
    return { ok: false, reason: String(reason) };
  }
}

// ────────────────── execution-call description (confirm UIs) ──────────────────

/**
 * Org-module address → human name map for decoding proposal execution
 * targets (src/commands/vote/helpers.ts MODULE_LABELS). Order matters only
 * for display; keys come from resolveOrgModules.
 */
export const MODULE_LABELS: Array<{ key: keyof OrgModules; label: string; abi: string }> = [
  { key: 'taskManagerAddress', label: 'TaskManager', abi: 'TaskManagerNew' },
  { key: 'hybridVotingAddress', label: 'HybridVoting', abi: 'HybridVotingNew' },
  { key: 'ddVotingAddress', label: 'DirectDemocracyVoting', abi: 'DirectDemocracyVotingNew' },
  { key: 'participationTokenAddress', label: 'ParticipationToken', abi: 'ParticipationToken' },
  { key: 'educationHubAddress', label: 'EducationHub', abi: 'EducationHubNew' },
  { key: 'executorAddress', label: 'Executor', abi: 'Executor' },
  { key: 'quickJoinAddress', label: 'QuickJoin', abi: 'QuickJoinNew' },
  { key: 'eligibilityModuleAddress', label: 'EligibilityModule', abi: 'EligibilityModuleNew' },
  { key: 'paymentManagerAddress', label: 'PaymentManager', abi: 'PaymentManager' },
  { key: 'zkEmailInvitesAddress', label: 'ZkEmailInvites', abi: 'ZkEmailInvites' },
];

/** Fallback ABIs scanned when the target is not a known org module. */
const FALLBACK_ABIS = ['ERC20', 'UniversalAccountRegistry'];

function tryGetFunction(abiName: string, selector: string): string | null {
  try {
    const iface = new ethers.utils.Interface(getAbi(abiName));
    const fn = iface.getFunction(selector);
    return `${fn.name}(${fn.inputs.map(i => i.type).join(',')})`;
  } catch {
    return null;
  }
}

/** Raw execution-call input as the CLI accepts it in --calls JSON. */
export interface ExecutionCallInput {
  target: string;
  value?: string | number | ethers.BigNumber;
  data?: string;
}

/**
 * Port of `describeExecutionCalls` (src/commands/vote/helpers.ts) —
 * governance-safety decode of proposal execution calls for confirm UIs:
 * each call's target is resolved against the org's known module addresses
 * (named when recognized) and its calldata selector is decoded to a function
 * signature via the known ABIs. Never throws — undecodable calls degrade to
 * the raw selector so the human still sees SOMETHING.
 */
export function describeExecutionCalls(
  calls: ExecutionCallInput[],
  modules: Partial<OrgModules> | null | undefined
): string[] {
  return calls.map((call) => {
    const target = String(call.target ?? '');
    const targetLower = target.toLowerCase();
    const known = MODULE_LABELS.find(m => {
      const addr = modules?.[m.key];
      return typeof addr === 'string' && addr.toLowerCase() === targetLower;
    });
    const name = known ? `${known.label} (${formatAddress(target)})` : `unknown contract ${target}`;

    const data = String(call.data ?? '0x');
    let action: string;
    if (!data || data === '0x') {
      action = 'plain native-token transfer (no calldata)';
    } else {
      const selector = data.slice(0, 10);
      let signature: string | null = known ? tryGetFunction(known.abi, selector) : null;
      if (!signature) {
        for (const m of MODULE_LABELS) {
          signature = tryGetFunction(m.abi, selector);
          if (signature) break;
        }
      }
      if (!signature) {
        for (const abiName of FALLBACK_ABIS) {
          signature = tryGetFunction(abiName, selector);
          if (signature) break;
        }
      }
      action = signature ? `${signature} [${selector}]` : `UNDECODABLE call [selector ${selector}]`;
    }

    let valueSuffix = '';
    try {
      const value = ethers.BigNumber.from(call.value ?? 0);
      if (!value.isZero()) valueSuffix = ` + ${formatToken(value)} native`;
    } catch { /* unparseable value — omit */ }

    return `${name} → ${action}${valueSuffix}`;
  });
}

// ────────────────────────── shared Level-2 plumbing ──────────────────────────

/**
 * Resolve the org's hybrid or DD voting module with the CLI's exact
 * missing-module error (`pop vote create/cast/announce`).
 */
async function resolveVotingModule(
  ctx: PopContext,
  org: string,
  type: VotingType
): Promise<{ modules: OrgModules; votingAddress: string; votingAbiName: VotingAbiName }> {
  const modules = await resolveOrgModules(ctx.client, org, ctx.chainId);
  const isHybrid = type === 'hybrid';
  const votingAddress = isHybrid ? modules.hybridVotingAddress : modules.ddVotingAddress;
  if (!votingAddress) {
    throw new CliError(
      `${isHybrid ? 'HybridVoting' : 'DirectDemocracyVoting'} not deployed for this org`,
      EXIT.PRECONDITION
    );
  }
  return {
    modules,
    votingAddress,
    votingAbiName: isHybrid ? 'HybridVotingNew' : 'DirectDemocracyVotingNew',
  };
}

/** Pin proposal metadata exactly as every CLI wrap does (JSON.stringify → pinJson). */
async function pinProposalMetadata(
  ctx: PopContext,
  metadata: ProposalMetadata
): Promise<{ cid: string; descriptionHash: string }> {
  const cid = await pinJson(serializeProposalMetadata(metadata), ctx.ipfs);
  return { cid, descriptionHash: ipfsCidToBytes32(cid) };
}

// ────────────────────────── Level 2 — vote create ──────────────────────────

export interface CreateProposalParams {
  org: string;
  type: VotingType;
  /** Proposal title. */
  name: string;
  description: string;
  durationMinutes: number;
  optionNames: string[];
  /**
   * Restricted-voting hat IDs, as raw strings/BigNumbers. Hat IDs are uint256
   * with high bits set — Number loses precision above 2^53, so entries are
   * parsed as BigNumbers from the raw values.
   */
  hatIds?: Array<string | ethers.BigNumberish>;
  /** Execution calls for option 0 ({target, value, data} — the --calls shape). */
  calls?: ExecutionCallInput[];
  /** Metadata createdAt override (default Date.now()). */
  createdAt?: number;
}

/**
 * Port of `pop vote create` — src/commands/vote/create.ts.
 *
 * Resolves the org's voting module, validates the option count, parses hat
 * IDs as BigNumbers, applies the MAX_POLL_HATS cap check (only when
 * ctx.provider is supplied — best-effort, exactly like the CLI: an older
 * contract has no getter and no cap, so a failing read means the check does
 * not apply), builds the option-0 execution batch, pins the proposal
 * metadata {description, optionNames, createdAt}, and delegates to
 * buildGovernanceProposal.
 *
 * Batch quirk preserved: with calls OMITTED the batches argument is the
 * EMPTY array [], while calls GIVEN (even as an empty list) build per-option
 * batches [[…], [], …] — matching the CLI's `if (argv.calls)` branch exactly.
 */
export async function createProposalIntent(
  ctx: PopContext,
  params: CreateProposalParams
): Promise<TxIntent> {
  const { modules, votingAddress, votingAbiName } = await resolveVotingModule(ctx, params.org, params.type);

  const optionNames = params.optionNames;
  const numOptions = optionNames.length;
  if (numOptions < 2) {
    throw new CliError('At least 2 options are required', EXIT.USAGE);
  }

  const hatIds = (params.hatIds ?? []).map(h =>
    ethers.BigNumber.from(typeof h === 'string' ? h.trim() : h)
  );

  // Hat-restriction cap: both voting contracts reject more than MAX_POLL_HATS
  // restricted hats. Read the live constant — an older contract has no getter
  // and no cap, so the check simply does not apply there.
  if (hatIds.length > 0 && ctx.provider) {
    try {
      const hv = new ethers.Contract(
        votingAddress, ['function MAX_POLL_HATS() view returns (uint16)'], ctx.provider
      );
      const cap = Number(await hv.MAX_POLL_HATS());
      if (cap > 0 && hatIds.length > cap) {
        throw new CliError(
          `${hatIds.length} restricted hats supplied but the contract allows at most ${cap}.`,
          EXIT.USAGE,
          'Reduce --hat-ids, or omit it entirely to let every eligible member vote.'
        );
      }
    } catch (err: any) {
      if (err instanceof CliError) throw err;
      // Cap check skipped — no getter on this deployment.
    }
  }

  // Build execution batches: calls go to option 0, other options get empty
  // batches. Keyed on calls being GIVEN, not non-empty — the CLI branches on
  // `if (argv.calls)`, so `--calls '[]'` encodes [[], [], …] while an omitted
  // flag encodes [] entirely. Both are valid on-chain but the bytes differ,
  // and calldata parity is the contract here.
  const batches: ExecutionCall[][] = [];
  if (params.calls !== undefined) {
    batches.push(params.calls.map(c => ({
      target: c.target,
      value: ethers.BigNumber.from(c.value || '0'),
      calldata: c.data as string,
    })));
    for (let i = 1; i < numOptions; i++) {
      batches.push([]);
    }
  }

  // Proposal metadata (key order matches the frontend).
  const metadata = buildProposalMetadata({
    description: params.description,
    optionNames,
    createdAt: params.createdAt,
  });
  const { cid, descriptionHash } = await pinProposalMetadata(ctx, metadata);

  const summary: Record<string, unknown> = {
    type: params.type,
    title: params.name,
    options: optionNames.join(', '),
    duration: `${params.durationMinutes} minutes`,
  };
  if (params.calls && params.calls.length > 0) {
    describeExecutionCalls(params.calls, modules).forEach((line, i) => {
      summary[`call ${i + 1}/${params.calls!.length}`] = line;
    });
  }

  return buildGovernanceProposal({
    votingAddress,
    votingAbiName,
    title: params.name,
    descriptionHash,
    durationMinutes: params.durationMinutes,
    numOptions,
    batches,
    hatIds,
    orgId: modules.orgId,
    action: 'create',
    summary,
    ipfs: { cid, metadata },
  });
}

// ────────────────────────── Level 2 — vote cast ──────────────────────────

export interface CastVoteParams {
  org: string;
  type: VotingType;
  /** Proposal ID (number) or fuzzy title query. */
  proposal: string | number;
  optionIndices: number[];
  weights: number[];
}

/**
 * Port of `pop vote cast` — src/commands/vote/cast.ts.
 *
 * Input safety kept from the CLI: option/weight counts must match, weights
 * must be non-negative and sum to exactly 100 (the contract's invariant) —
 * all validated before any network traffic. The proposal argument accepts a
 * numeric ID or fuzzy title query (resolved with preferActive: an ended
 * homonym never shadows the one still-open match).
 */
export async function castVoteIntent(ctx: PopContext, params: CastVoteParams): Promise<TxIntent> {
  const { optionIndices, weights } = params;

  if (optionIndices.length !== weights.length) {
    throw new CliError('Number of options must match number of weights', EXIT.USAGE);
  }
  if (weights.some(w => w < 0)) {
    throw new CliError('Weights must be non-negative', EXIT.USAGE);
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum !== 100) {
    throw new CliError(`Weights must sum to 100, got ${weightSum}`, EXIT.USAGE);
  }

  const { modules, votingAddress, votingAbiName } = await resolveVotingModule(ctx, params.org, params.type);

  const proposalId = await resolveProposalId(
    ctx.client,
    String(params.proposal),
    votingAddress,
    ctx.chainId,
    { preferActive: true }
  );

  return buildVote({
    votingAddress,
    votingAbiName,
    proposalId,
    optionIndices,
    weights,
    orgId: modules.orgId,
  });
}

// ─────────────────── Level 2 — vote announce / execute ───────────────────

export interface AnnounceWinnerParams {
  org: string;
  type: VotingType;
  /** Proposal ID (number) or fuzzy title query. */
  proposal: string | number;
}

/**
 * Port of `pop vote announce` — src/commands/vote/announce.ts (also the
 * per-proposal intent of `pop vote announce-all`).
 *
 * DESTRUCTIVE. This builder only resolves and encodes; the CLI's safety
 * layers stay host-side: (1) announceWinnerProbe before broadcasting,
 * (2) parseAnnounceReceiptLogs after — outer success + innerFailure means
 * the proposal finalized but its execution reverted.
 */
export async function announceWinnerIntent(
  ctx: PopContext,
  params: AnnounceWinnerParams
): Promise<TxIntent> {
  const { modules, votingAddress, votingAbiName } = await resolveVotingModule(ctx, params.org, params.type);
  const proposalId = await resolveProposalId(ctx.client, String(params.proposal), votingAddress, ctx.chainId);
  return buildAnnounceWinner({ votingAddress, votingAbiName, proposalId, orgId: modules.orgId, action: 'announce' });
}

export interface ExecuteProposalParams {
  org: string;
  /** Proposal ID (number) or fuzzy title query. */
  proposal: string | number;
}

/**
 * Port of `pop vote execute` — src/commands/vote/execute.ts. Hybrid-only:
 * announceWinner is the one canonical finalize path (the Executor is
 * allowedCaller-gated, so proposal calls cannot be executed directly).
 *
 * The CLI's subgraph state gate is NOT run here — hosts replicate it with
 * reads/vote fetchProposalExecutionState + evaluateExecuteGate, then probe
 * with announceWinnerProbe, then scan the receipt with
 * parseAnnounceReceiptLogs (executionFailed proposals are retryable since
 * audit H-05; the callStatic probe is the arbiter on older deployments).
 */
export async function executeProposalIntent(
  ctx: PopContext,
  params: ExecuteProposalParams
): Promise<TxIntent> {
  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const hybridVotingAddress = modules.hybridVotingAddress;
  if (!hybridVotingAddress) {
    throw new CliError('No HybridVoting contract found for this org', EXIT.PRECONDITION);
  }
  const proposalId = await resolveProposalId(ctx.client, String(params.proposal), hybridVotingAddress, ctx.chainId);
  return buildAnnounceWinner({
    votingAddress: hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    proposalId,
    orgId: modules.orgId,
    action: 'execute',
  });
}

// ───────────────────── Level 2 — vote propose-quorum ─────────────────────

/**
 * setConfig keys for quorum (contracts origin/main, v6):
 *   HybridVoting: key 3 (QUORUM)
 *   DirectDemocracyVoting: key 4 (QUORUM)
 *
 * The voting contracts use setConfig(uint8, bytes) instead of a direct
 * setter, and decode the value as uint32. Since PR #119 quorum is a minimum
 * voter COUNT (0 disables), not a percentage.
 */
export const HYBRID_QUORUM_KEY = 3;
export const DD_QUORUM_KEY = 4;

export interface ProposeQuorumParams {
  org: string;
  /** New quorum value (minimum voter COUNT, not a percentage). */
  quorum: number;
  /** Vote duration in minutes (CLI default 60). */
  durationMinutes?: number;
  /** Metadata createdAt override (default Date.now()). */
  createdAt?: number;
}

/**
 * Port of `pop vote propose-quorum` — src/commands/vote/propose-quorum.ts.
 *
 * Governance wrap: createProposal on HybridVoting with an option-0 batch of
 * setConfig(3, abi.encode(uint32 quorum)) on HybridVoting plus
 * setConfig(4, same) on DD when the org has one; option 1 (keep current) has
 * no calls; hatIds [].
 */
export async function proposeQuorumIntent(
  ctx: PopContext,
  params: ProposeQuorumParams
): Promise<TxIntent> {
  const newQuorum = params.quorum;
  const durationMinutes = params.durationMinutes ?? 60;
  if (newQuorum < 1) throw new CliError('Quorum must be at least 1', EXIT.USAGE);

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  if (!modules.hybridVotingAddress) throw new CliError('HybridVoting not deployed', EXIT.USAGE);

  // Encode setConfig calls for both voting contracts. Both ABIs carry exactly
  // one setConfig(uint8,bytes) fragment, so this matches the CLI's inline
  // `['function setConfig(uint8 key, bytes value)']` encoding byte-for-byte.
  const encodedValue = ethers.utils.defaultAbiCoder.encode(['uint32'], [newQuorum]);
  const option0Batch: ExecutionCall[] = [
    encodeExecutorCall('HybridVotingNew', modules.hybridVotingAddress, 'setConfig', [HYBRID_QUORUM_KEY, encodedValue]),
  ];
  if (modules.ddVotingAddress) {
    option0Batch.push(
      encodeExecutorCall('DirectDemocracyVotingNew', modules.ddVotingAddress, 'setConfig', [DD_QUORUM_KEY, encodedValue])
    );
  }
  const batches: ExecutionCall[][] = [option0Batch, []]; // option 1 (keep current) has no calls

  const metadata = buildProposalMetadata({
    description: `Change voting quorum to ${newQuorum}. Updates both Hybrid (setConfig key ${HYBRID_QUORUM_KEY}) and DD (setConfig key ${DD_QUORUM_KEY}) voting contracts via execution calls.`,
    optionNames: [`Set quorum to ${newQuorum}`, 'Keep current quorum'],
    createdAt: params.createdAt,
  });
  const { cid, descriptionHash } = await pinProposalMetadata(ctx, metadata);
  const contractList = modules.ddVotingAddress ? 'Hybrid + DD' : 'Hybrid only';

  return buildGovernanceProposal({
    votingAddress: modules.hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    title: `Set voting quorum to ${newQuorum}`,
    descriptionHash,
    durationMinutes,
    numOptions: 2,
    batches,
    hatIds: [],
    orgId: modules.orgId,
    action: 'propose-quorum',
    summary: { newQuorum, duration: `${durationMinutes} minutes`, contracts: contractList },
    ipfs: { cid, metadata },
  });
}

// ───────────────────── Level 2 — vote propose-config ─────────────────────

/**
 * ConfigKey mapping for HybridVoting (contracts origin/main, v6):
 *   0: THRESHOLD (uint8 — support threshold percentage, 1-100)
 *   1: TARGET_ALLOWED (deprecated — setConfig silently ignores this branch)
 *   2: EXECUTOR (address — change the executor contract)
 *   3: QUORUM (uint32 — minimum voter count for validity, 0 disables)
 *
 * ConfigKey mapping for DirectDemocracyVoting (v6):
 *   0: THRESHOLD (uint8 — support threshold percentage, 1-100)
 *   1: EXECUTOR (address)
 *   2: TARGET_ALLOWED (address, bool — whitelist execution targets)
 *   3: HAT_ALLOWED (uint256, bool — restrict voting to specific hats)
 *   4: QUORUM (uint32 — minimum voter count for validity, 0 disables)
 *
 * Note: since PR #119 quorum is a voter COUNT, not a percentage.
 */
export interface ConfigParam {
  name: string;
  hybridKey: number; // -1 = not applicable to Hybrid
  ddKey: number | null; // null = not applicable to DD
  valueType: string;
  description: string;
  encode: (value: string) => string;
  validate: (value: string) => void;
  hybridUnavailableReason?: string; // shown when hybridKey < 0 and no DD contract exists
}

/** Port of CONFIG_PARAMS (src/commands/vote/propose-config.ts) — verbatim. */
export const CONFIG_PARAMS: Record<string, ConfigParam> = {
  threshold: {
    name: 'threshold',
    hybridKey: 0,
    ddKey: 0,
    valueType: 'uint8',
    description: 'Support threshold percentage (1-100)',
    encode: (v) => ethers.utils.defaultAbiCoder.encode(['uint8'], [parseInt(v, 10)]),
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1 || n > 100) throw new Error('Threshold must be 1-100');
    },
  },
  quorum: {
    name: 'quorum',
    hybridKey: 3,
    ddKey: 4,
    valueType: 'uint32',
    description: 'Minimum voter count for validity (0 disables)',
    encode: (v) => ethers.utils.defaultAbiCoder.encode(['uint32'], [parseInt(v, 10)]),
    validate: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 4294967295) {
        throw new Error('Quorum must be an integer >= 0 (uint32 voter count, 0 disables)');
      }
    },
  },
  'target-allowed': {
    name: 'target-allowed',
    hybridKey: -1, // deprecated no-op on HybridVoting v6 — setConfig silently ignores it
    ddKey: 2,
    valueType: 'address,bool',
    description: 'Allow/disallow an execution target address on DD voting (format: 0xaddr,true/false)',
    hybridUnavailableReason:
      'TARGET_ALLOWED is a deprecated no-op on HybridVoting (setConfig silently ignores it); this key only applies to DirectDemocracyVoting',
    encode: (v) => {
      const [addr, allowed] = v.split(',');
      return ethers.utils.defaultAbiCoder.encode(['address', 'bool'], [addr.trim(), allowed.trim() === 'true']);
    },
    validate: (v) => {
      const parts = v.split(',');
      if (parts.length !== 2) throw new Error('Format: 0xaddress,true/false');
      if (!ethers.utils.isAddress(parts[0].trim())) throw new Error('Invalid address');
      if (!['true', 'false'].includes(parts[1].trim())) throw new Error('Second value must be true or false');
    },
  },
  executor: {
    name: 'executor',
    hybridKey: 2,
    ddKey: 1,
    valueType: 'address',
    description: 'Change the executor contract address',
    encode: (v) => ethers.utils.defaultAbiCoder.encode(['address'], [v.trim()]),
    validate: (v) => {
      if (!ethers.utils.isAddress(v.trim())) throw new Error('Invalid address');
      if (v.trim() === ethers.constants.AddressZero) throw new Error('Cannot set executor to zero address');
    },
  },
  'hat-allowed': {
    name: 'hat-allowed',
    hybridKey: -1, // not available on Hybrid
    ddKey: 3,
    hybridUnavailableReason:
      'HAT_ALLOWED is not a HybridVoting config key; this key only applies to DirectDemocracyVoting',
    valueType: 'uint256,bool',
    description: 'Allow/disallow a hat ID for DD voting (format: hatId,true/false)',
    encode: (v) => {
      const [hatId, allowed] = v.split(',');
      return ethers.utils.defaultAbiCoder.encode(['uint256', 'bool'], [hatId.trim(), allowed.trim() === 'true']);
    },
    validate: (v) => {
      const parts = v.split(',');
      if (parts.length !== 2) throw new Error('Format: hatId,true/false');
      if (!['true', 'false'].includes(parts[1].trim())) throw new Error('Second value must be true or false');
    },
  },
};

export interface ProposeConfigParams {
  org: string;
  /** Configuration parameter name (a CONFIG_PARAMS key). */
  key: string;
  /** New value, in the key's string format. */
  value: string;
  /** Vote duration in minutes (CLI default 60). */
  durationMinutes?: number;
  /** Metadata createdAt override (default Date.now()). */
  createdAt?: number;
}

/**
 * Port of `pop vote propose-config` — src/commands/vote/propose-config.ts.
 *
 * Governance wrap: createProposal on HybridVoting whose option-0 batch calls
 * setConfig(key, encodedValue) on the applicable voting contract(s) per the
 * CONFIG_PARAMS table. Validation errors are the CLI's own (plain Error,
 * verbatim messages).
 */
export async function proposeConfigIntent(
  ctx: PopContext,
  params: ProposeConfigParams
): Promise<TxIntent> {
  const paramName = params.key;
  const durationMinutes = params.durationMinutes ?? 60;
  const param = CONFIG_PARAMS[paramName];
  if (!param) throw new Error(`Unknown config key: ${paramName}. Available: ${Object.keys(CONFIG_PARAMS).join(', ')}`);

  param.validate(params.value);

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  if (!modules.hybridVotingAddress) throw new Error('HybridVoting not deployed');

  const encodedValue = param.encode(params.value);

  const option0Batch: ExecutionCall[] = [];

  // Add Hybrid call if applicable
  if (param.hybridKey >= 0) {
    option0Batch.push(
      encodeExecutorCall('HybridVotingNew', modules.hybridVotingAddress, 'setConfig', [param.hybridKey, encodedValue])
    );
  }

  // Add DD call if applicable and contract exists
  if (param.ddKey !== null && modules.ddVotingAddress) {
    option0Batch.push(
      encodeExecutorCall('DirectDemocracyVotingNew', modules.ddVotingAddress, 'setConfig', [param.ddKey, encodedValue])
    );
  }

  if (option0Batch.length === 0) {
    const reason = param.hybridKey < 0 && param.hybridUnavailableReason
      ? ` ${param.hybridUnavailableReason}.`
      : '';
    throw new Error(
      `Config key "${paramName}" has no applicable voting contracts.${reason}` +
      (param.ddKey !== null && !modules.ddVotingAddress
        ? ' No DirectDemocracyVoting contract is deployed for this org.'
        : '')
    );
  }

  const batches: ExecutionCall[][] = [option0Batch, []]; // option 0 = change, option 1 = keep current

  const contractList = option0Batch.length > 1 ? 'Hybrid + DD' : (param.hybridKey >= 0 ? 'Hybrid' : 'DD');
  const metadata = buildProposalMetadata({
    description: `Change ${paramName} to ${params.value}. Updates ${contractList} voting contract(s) via setConfig execution calls.`,
    optionNames: [`Set ${paramName} to ${params.value}`, 'Keep current value'],
    createdAt: params.createdAt,
  });
  const { cid, descriptionHash } = await pinProposalMetadata(ctx, metadata);

  return buildGovernanceProposal({
    votingAddress: modules.hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    title: `Set ${paramName} to ${params.value}`,
    descriptionHash,
    durationMinutes,
    numOptions: 2,
    batches,
    hatIds: [],
    orgId: modules.orgId,
    action: 'propose-config',
    summary: { key: paramName, value: params.value, contracts: contractList, duration: `${durationMinutes} minutes` },
    ipfs: { cid, metadata },
  });
}

// ──────────────────── Level 2 — vote classes propose ────────────────────

/** ClassStrategy enum — verified origin/main src/HybridVoting.sol. */
export const CLASS_STRATEGY = { DIRECT: 0, ERC20_BAL: 1 } as const;
const STRATEGY_NAMES = ['DIRECT', 'ERC20_BAL'] as const;

/** Contract constant MAX_CLASSES (origin/main src/HybridVoting.sol). */
export const MAX_CLASSES = 8;

export interface ParsedClassConfig {
  strategy: number;
  slicePct: number;
  quadratic: boolean;
  minBalance: ethers.BigNumber;
  asset: string;
  hatIds: ethers.BigNumber[];
}

function usageError(message: string): CliError {
  return new CliError(message, EXIT.USAGE,
    'Expected a JSON array of ClassConfig objects: ' +
    '[{"strategy":"DIRECT"|"ERC20_BAL"|0|1,"slicePct":n,"quadratic":bool,"minBalance":"0","asset":"0x…","hatIds":["…"]}] ' +
    'with slicePct values summing to 100.');
}

function parseStrategy(value: any, index: number): number {
  if (value === 0 || value === 1) return value;
  if (typeof value === 'string') {
    const upper = value.trim().toUpperCase();
    if (upper === 'DIRECT' || upper === '0') return CLASS_STRATEGY.DIRECT;
    if (upper === 'ERC20_BAL' || upper === '1') return CLASS_STRATEGY.ERC20_BAL;
  }
  throw usageError(`Class ${index}: invalid strategy ${JSON.stringify(value)} — use 'DIRECT'|'ERC20_BAL'|0|1.`);
}

/**
 * Port of `parseClassConfigs` (src/commands/vote/classes.ts): validate +
 * normalize a ClassConfig[] JSON document. Mirrors HybridVotingConfig
 * setClasses validation so bad configs fail locally with a pointer to the
 * offending class instead of a generic on-chain revert: 1..MAX_CLASSES(8)
 * classes, each slicePct 1..100 and summing to exactly 100, ERC20_BAL needs a
 * non-zero asset. Hat IDs are parsed as BigNumbers straight from their raw
 * strings — real Hats IDs exceed 2^53 and would be mangled by Number.
 */
export function parseClassConfigs(doc: any): ParsedClassConfig[] {
  if (!Array.isArray(doc)) throw usageError('Classes file must contain a JSON array of ClassConfig objects.');
  if (doc.length === 0) throw usageError('At least one voting class is required.');
  if (doc.length > MAX_CLASSES) {
    throw usageError(`Too many classes: ${doc.length} (the contract allows at most ${MAX_CLASSES}).`);
  }

  const classes = doc.map((entry: any, i: number): ParsedClassConfig => {
    if (typeof entry !== 'object' || entry === null) throw usageError(`Class ${i}: expected an object.`);

    const strategy = parseStrategy(entry.strategy, i);

    const slicePct = Number(entry.slicePct);
    if (!Number.isInteger(slicePct) || slicePct < 1 || slicePct > 100) {
      throw usageError(`Class ${i}: slicePct must be an integer 1-100 (got ${JSON.stringify(entry.slicePct)}).`);
    }

    let minBalance: ethers.BigNumber;
    try {
      minBalance = ethers.BigNumber.from(String(entry.minBalance ?? 0));
    } catch {
      throw usageError(`Class ${i}: invalid minBalance ${JSON.stringify(entry.minBalance)} — pass a base-unit integer string.`);
    }

    const asset = String(entry.asset ?? ethers.constants.AddressZero);
    if (!ethers.utils.isAddress(asset)) {
      throw usageError(`Class ${i}: invalid asset address ${JSON.stringify(entry.asset)}.`);
    }
    if (strategy === CLASS_STRATEGY.ERC20_BAL && asset === ethers.constants.AddressZero) {
      throw usageError(`Class ${i}: ERC20_BAL strategy requires a non-zero asset address (the contract reverts ZeroAddress).`);
    }

    const rawHatIds = entry.hatIds ?? [];
    if (!Array.isArray(rawHatIds)) throw usageError(`Class ${i}: hatIds must be an array.`);
    const hatIds = rawHatIds.map((h: any) => {
      try {
        return ethers.BigNumber.from(String(h).trim());
      } catch {
        throw usageError(`Class ${i}: invalid hat ID ${JSON.stringify(h)}.`);
      }
    });

    return { strategy, slicePct, quadratic: Boolean(entry.quadratic), minBalance, asset, hatIds };
  });

  const sliceSum = classes.reduce((sum, c) => sum + c.slicePct, 0);
  if (sliceSum !== 100) {
    throw new CliError(
      `Class slice percentages must sum to exactly 100 — got ${sliceSum} ` +
      `(${classes.map(c => `${c.slicePct}%`).join(' + ')}). The contract reverts InvalidSliceSum otherwise.`,
      EXIT.USAGE,
      'Adjust the slicePct values in the classes file so they total 100.'
    );
  }

  return classes;
}

/**
 * Port of `describeClass` (src/commands/vote/classes.ts): one-line human
 * description of a class (confirm summary + metadata description).
 */
export function describeClass(c: ParsedClassConfig): string {
  const name = STRATEGY_NAMES[c.strategy] ?? String(c.strategy);
  const parts = [`${name} ${c.slicePct}%`];
  if (c.quadratic) parts.push('quadratic');
  if (!c.minBalance.isZero()) parts.push(`min balance ${formatToken(c.minBalance)}`);
  if (c.asset !== ethers.constants.AddressZero) parts.push(`asset ${formatAddress(c.asset)}`);
  if (c.hatIds.length > 0) parts.push(`hats ${c.hatIds.map(h => h.toString()).join(',')}`);
  return parts.join(', ');
}

export interface ProposeClassesParams {
  org: string;
  /**
   * The ClassConfig[] document — either the raw parsed-JSON array (host reads
   * the file; core validates via parseClassConfigs) or an already-parsed
   * ParsedClassConfig[].
   */
  classes: unknown | ParsedClassConfig[];
  /** Vote duration in minutes (CLI default 60). */
  durationMinutes?: number;
  /** Metadata createdAt override (default Date.now()). */
  createdAt?: number;
}

function isParsedClassConfigs(value: unknown): value is ParsedClassConfig[] {
  return Array.isArray(value) && value.every(
    (c: any) => c && typeof c === 'object' && ethers.BigNumber.isBigNumber(c.minBalance)
  );
}

/**
 * Port of `pop vote classes propose` — src/commands/vote/classes.ts
 * (classesProposeHandler).
 *
 * setClasses(ClassConfig[]) is executor-gated on HybridVoting (verified:
 * `function setClasses(ClassConfig[] calldata) external onlyExecutor`), so it
 * ships as a governance proposal whose option-0 execution batch calls the
 * voting contract through the Executor (propose-config pattern). ClassConfig
 * tuple order: [strategy, slicePct, quadratic, minBalance, asset, hatIds].
 */
export async function proposeClassesIntent(
  ctx: PopContext,
  params: ProposeClassesParams
): Promise<TxIntent> {
  const durationMinutes = params.durationMinutes ?? 60;
  const classes = isParsedClassConfigs(params.classes)
    ? params.classes
    : parseClassConfigs(params.classes);

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const hybridVotingAddress = modules.hybridVotingAddress;
  if (!hybridVotingAddress) {
    throw new CliError(
      'HybridVoting not deployed for this org — voting classes only apply to hybrid voting.',
      EXIT.PRECONDITION
    );
  }

  const setClassesCall = encodeExecutorCall('HybridVotingNew', hybridVotingAddress, 'setClasses', [
    classes.map(c => [c.strategy, c.slicePct, c.quadratic, c.minBalance, c.asset, c.hatIds]),
  ]);
  const batches: ExecutionCall[][] = [
    [setClassesCall], // option 0: apply
    [], // option 1: keep current
  ];

  const classLines = classes.map(describeClass);
  const title = `Update hybrid voting classes (${classes.length} class${classes.length === 1 ? '' : 'es'})`;
  const metadata = buildProposalMetadata({
    description:
      `Replace the hybrid voting class configuration via HybridVoting.setClasses (executor-gated). ` +
      `New classes: ${classLines.map((line, i) => `[${i}] ${line}`).join('; ')}.`,
    optionNames: [title, 'Keep current classes'],
    createdAt: params.createdAt,
  });
  const { cid, descriptionHash } = await pinProposalMetadata(ctx, metadata);

  const summary: Record<string, unknown> = {
    classes: classes.length,
    target: `HybridVoting ${formatAddress(hybridVotingAddress)}`,
    via: `governance proposal (${durationMinutes} min vote)`,
  };
  classLines.forEach((line, i) => { summary[`class ${i}`] = line; });

  return buildGovernanceProposal({
    votingAddress: hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    title,
    descriptionHash,
    durationMinutes,
    numOptions: 2,
    batches,
    hatIds: [],
    orgId: modules.orgId,
    action: 'classes-propose',
    summary,
    ipfs: { cid, metadata },
  });
}
