/**
 * Shared helpers for voting commands.
 */

import { ethers } from 'ethers';
import { resolveOrgModules, OrgModules } from '../../lib/resolve';
import { loadAbi } from '../../lib/contracts';
import { formatAddress } from '../../lib/encoding';
import { formatToken } from '../../lib/format';
import { bestMatches } from '../../lib/similarity';
import { isInteractive, select } from '../../lib/prompt';
import { query } from '../../lib/subgraph';
import { RECENT_PROPOSALS_FOR_RESOLVE } from '../../queries/voting';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import type { TxResult } from '../../lib/tx';
import * as output from '../../lib/output';

export interface VotingContracts {
  orgId: string;
  hybridVotingAddress: string | null;
  ddVotingAddress: string | null;
}

export async function resolveVotingContracts(orgIdOrName: string, chainId?: number): Promise<VotingContracts> {
  const modules = await resolveOrgModules(orgIdOrName, chainId);
  return {
    orgId: modules.orgId,
    hybridVotingAddress: modules.hybridVotingAddress,
    ddVotingAddress: modules.ddVotingAddress,
  };
}

interface ProposalCandidate {
  proposalId: string;
  title: string;
  status: string;
  endTimestamp?: string;
}

/** Test seam: fetch recent proposal titles for one voting contract. */
export async function fetchRecentProposals(
  contractAddr: string,
  chainId?: number,
  first = 50
): Promise<ProposalCandidate[]> {
  const data = await query<any>(
    RECENT_PROPOSALS_FOR_RESOLVE,
    { votingId: contractAddr.toLowerCase(), first },
    chainId
  );
  const raw = [
    ...(data?.hybridVotingContract?.proposals ?? []),
    ...(data?.directDemocracyVotingContract?.ddvProposals ?? []),
  ];
  return raw.map((p: any) => ({
    proposalId: String(p.proposalId),
    title: String(p.title ?? ''),
    status: String(p.status ?? ''),
    endTimestamp: p.endTimestamp !== undefined && p.endTimestamp !== null ? String(p.endTimestamp) : undefined,
  }));
}

function candidateLine(c: ProposalCandidate): string {
  return `#${c.proposalId} '${c.title}' (${c.status})`;
}

/**
 * Resolve a user-supplied --proposal argument to a numeric proposal ID.
 *
 * - Numeric input → returned as-is (no network round-trip).
 * - Anything else → fuzzy title query: the voting contract's recent
 *   proposals are fetched from the subgraph and their (already decoded)
 *   titles scored with Jaccard bestMatches at threshold 0.5.
 *     - exactly one match → resolved with an info line
 *     - multiple matches  → interactive TTY: pick from the top 5;
 *                           non-TTY: CliError listing the candidates (exit 1)
 *     - zero matches      → CliError listing the 5 most recent titles
 *
 * opts.preferActive (used by `vote cast`): when several proposals match
 * but exactly ONE of them is still Active, that one wins — you can only
 * cast on an open proposal, so the ended homonyms are not ambiguity.
 */
export async function resolveProposalId(
  input: string,
  contractAddr: string,
  chainId?: number,
  opts?: { preferActive?: boolean }
): Promise<number> {
  const trimmed = input.trim();
  const n = Number(trimmed);
  if (Number.isFinite(n) && Number.isInteger(n) && n >= 0 && String(n) === trimmed) {
    return n;
  }

  const candidates = await fetchRecentProposals(contractAddr, chainId);
  if (candidates.length === 0) {
    throw new CliError(
      `Cannot resolve proposal '${input}': no proposals are indexed for this voting contract yet.`,
      EXIT.USAGE,
      'Check the org/--type, or pass the numeric proposal ID (pop vote list).'
    );
  }

  let matches = bestMatches(trimmed, candidates, c => c.title, { threshold: 0.5, topN: 5 });

  if (matches.length > 1 && opts?.preferActive) {
    const active = matches.filter(m => m.item.status === 'Active');
    if (active.length === 1) matches = active;
  }

  if (matches.length === 1) {
    const hit = matches[0].item;
    output.info(`Resolved '${input}' → proposal #${hit.proposalId} '${hit.title}'`);
    return Number(hit.proposalId);
  }

  if (matches.length > 1) {
    if (isInteractive()) {
      return select(
        `Multiple proposals match '${input}':`,
        matches.map(m => ({
          label: `#${m.item.proposalId} '${m.item.title}'`,
          hint: m.item.status,
          value: Number(m.item.proposalId),
        }))
      );
    }
    throw new CliError(
      `Proposal query '${input}' is ambiguous — ${matches.length} proposals match:\n` +
      matches.map(m => `  ${candidateLine(m.item)}`).join('\n'),
      EXIT.USAGE,
      `Pass the numeric ID instead, e.g. --proposal ${matches[0].item.proposalId}`
    );
  }

  const recent = candidates.slice(0, 5);
  throw new CliError(
    `No proposal title matches '${input}'. The ${recent.length} most recent proposals are:\n` +
    recent.map(c => `  ${candidateLine(c)}`).join('\n'),
    EXIT.USAGE,
    'Pass a numeric proposal ID from pop vote list, or refine the title query.'
  );
}

/**
 * Org-module address → human name map for decoding proposal execution
 * targets. Order matters only for display; keys come from resolveOrgModules.
 */
const MODULE_LABELS: Array<{ key: keyof OrgModules; label: string; abi: string }> = [
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
    const iface = new ethers.utils.Interface(loadAbi(abiName));
    const fn = iface.getFunction(selector);
    return `${fn.name}(${fn.inputs.map(i => i.type).join(',')})`;
  } catch {
    return null;
  }
}

export interface ExecutionCallInput {
  target: string;
  value?: string | number | ethers.BigNumber;
  data?: string;
}

/**
 * Governance-safety decode of proposal execution calls for the confirm
 * summary: each Call's target is resolved against the org's known module
 * addresses (named when recognized) and its calldata selector is decoded
 * to a function signature via the known ABIs. Never throws — undecodable
 * calls degrade to the raw selector so the human still sees SOMETHING.
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

/**
 * Parse an announceWinner receipt. The Executor catches failed sub-calls
 * and emits CallFailed / ProposalExecutionFailed while the OUTER tx still
 * succeeds — callers must treat innerFailure as an execution failure even
 * though result.success is true.
 */
export function parseAnnounceReceipt(result: TxResult): {
  winningOption?: string;
  valid?: boolean;
  executed: boolean;
  innerFailure: boolean;
  failedCalls: Array<{ index?: string; data?: string }>;
} {
  const logs = result.logs ?? [];
  const winnerEvent = logs.find(l => l.name === 'Winner');
  const executedEvent = logs.find(l => l.name === 'ProposalExecuted');
  const callFailedEvents = logs.filter(l => l.name === 'CallFailed');
  const execFailedEvent = logs.find(l => l.name === 'ProposalExecutionFailed');
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
 * callStatic probe shared by announce/execute pre-flights: would
 * announceWinner(id) revert right now (voting still open, already
 * executed, quorum edge...)? Returns the decoded reason on failure.
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
