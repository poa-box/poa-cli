/**
 * Vote/governance reads — typed wrappers over the voting graph documents for
 * the entities the CLI's `pop vote list / results / execute / classes show`
 * commands read, plus the pure selection helpers those commands share
 * (fuzzy --proposal resolution, announce-all candidate selection, the
 * execute state gate, results tallying, class-snapshot normalization).
 *
 * Raw subgraph entity shapes only — scalars arrive as strings.
 */

import { ethers } from 'ethers';
import type { GraphClient } from '../graph/client';
import {
  FETCH_VOTING_DATA,
  FETCH_VOTING_DATA_LEGACY,
  RECENT_PROPOSALS_FOR_RESOLVE,
} from '../graph/documents/voting';
import {
  FETCH_VOTING_CLASS_CONFIG,
  FETCH_VOTING_CLASS_CONFIG_LEGACY,
  FETCH_PROPOSAL_VOTING_CLASSES,
  selectClassSnapshot,
  SubgraphVotingClass,
} from '../graph/documents/voting-classes';
import { resolveOrgId } from './resolve';
import { bestMatches } from '../similarity';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';

// ────────────────────────── raw entity shapes ──────────────────────────

/** One ballot as indexed by the subgraph (FETCH_VOTING_DATA field set). */
export interface SubgraphProposalVote {
  voter: string;
  voterUsername?: string | null;
  optionIndexes: string[];
  optionWeights: string[];
  classRawPowers?: string[] | null;
  votedAt?: string | null;
}

/**
 * One proposal row (hybrid `proposals` or DD `ddvProposals`). Fields absent on
 * the legacy (pre-#195) tier — proposer/proposerUsername/creatorUsername/
 * classesVersion — arrive as undefined when that tier served the request.
 */
export interface SubgraphProposal {
  id?: string;
  proposalId: string;
  title?: string | null;
  descriptionHash?: string;
  metadata?: {
    id?: string;
    description?: string | null;
    optionNames?: string[] | null;
  } | null;
  numOptions?: string | number;
  startTimestamp?: string;
  endTimestamp?: string | null;
  status: string;
  winningOption?: string | null;
  isValid?: boolean | null;
  wasExecuted?: boolean | null;
  executionFailed?: boolean | null;
  executionError?: string | null;
  isHatRestricted?: boolean | null;
  restrictedHatIds?: string[] | null;
  proposer?: string | null;
  proposerUsername?: string | null;
  creatorUsername?: string | null;
  classesVersion?: string | null;
  votes?: SubgraphProposalVote[];
}

export interface SubgraphHybridVoting {
  id: string;
  thresholdPct?: string | number | null;
  quorum?: string | number | null;
  classVersion?: string | null;
  votingClasses?: SubgraphVotingClass[];
  proposals?: SubgraphProposal[];
}

export interface SubgraphDirectDemocracyVoting {
  id: string;
  thresholdPct?: string | number | null;
  quorum?: string | number | null;
  ddvProposals?: SubgraphProposal[];
}

/** Organization root of FETCH_VOTING_DATA — null means the org is not indexed. */
export interface VotingOrgData {
  id: string;
  hybridVoting?: SubgraphHybridVoting | null;
  directDemocracyVoting?: SubgraphDirectDemocracyVoting | null;
}

// ────────────────────────── proposals list ──────────────────────────

/**
 * Port of the `pop vote list` / `pop vote announce-all` data fetch
 * (src/commands/vote/list.ts, src/commands/vote/announce-all.ts):
 * FETCH_VOTING_DATA with the pre-#195 legacy tier as fallback.
 *
 * A GraphQL document validates as a whole, so one unknown field fails the
 * entire query — the legacy tier keeps listing (and announcing) working
 * against a pre-#195 subgraph deployment.
 */
export async function fetchVotingData(
  client: GraphClient,
  orgIdOrName: string,
  chainId?: number
): Promise<VotingOrgData | null> {
  const orgId = await resolveOrgId(client, orgIdOrName, chainId);
  const { data } = await client.queryWithFieldFallback<{ organization: VotingOrgData | null }>(
    [
      { query: FETCH_VOTING_DATA, variables: { orgId } },
      { query: FETCH_VOTING_DATA_LEGACY, variables: { orgId } },
    ],
    { chainId }
  );
  return data.organization ?? null;
}

// ────────────────────────── fuzzy proposal resolution ──────────────────────────

export interface ProposalCandidate {
  proposalId: string;
  title: string;
  status: string;
  endTimestamp?: string;
}

/**
 * Port of `fetchRecentProposals` (src/commands/vote/helpers.ts): recent
 * proposal titles for ONE voting contract, addressed by contract address —
 * works for both Hybrid and DD (whichever entity matches answers, the other
 * root field returns null).
 */
export async function fetchRecentProposals(
  client: GraphClient,
  contractAddr: string,
  chainId?: number,
  first = 50
): Promise<ProposalCandidate[]> {
  const data = await client.query<any>(
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
 * Port of `resolveProposalId` (src/commands/vote/helpers.ts): resolve a
 * user-supplied proposal argument to a numeric proposal ID.
 *
 * - Numeric input → returned as-is (no network round-trip).
 * - Anything else → fuzzy title query against the voting contract's recent
 *   proposals, scored with Jaccard bestMatches at threshold 0.5.
 *     - exactly one match → resolved
 *     - multiple matches  → CliError listing the candidates (the CLI's
 *       non-TTY behavior; the interactive picker is CLI UX and not ported)
 *     - zero matches      → CliError listing the 5 most recent titles
 *
 * opts.preferActive (used by `vote cast`): when several proposals match but
 * exactly ONE is still Active, that one wins — you can only cast on an open
 * proposal, so ended homonyms are not ambiguity.
 */
export async function resolveProposalId(
  client: GraphClient,
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

  const candidates = await fetchRecentProposals(client, contractAddr, chainId);
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
    return Number(matches[0].item.proposalId);
  }

  if (matches.length > 1) {
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

// ────────────────────────── announce-all candidates ──────────────────────────

export interface AnnounceCandidate {
  id: string;
  type: 'hybrid' | 'dd';
  title: string;
  /** True when this is an H-05 retry of a failed execution. */
  retry: boolean;
}

/**
 * Pure port of the `pop vote announce-all` candidate filter
 * (src/commands/vote/announce-all.ts): proposals ready to announce are
 *   - status "Ended" (subgraph updated), OR
 *   - status "Active" but endTimestamp has passed (subgraph hasn't updated)
 * excluding already-announced ones — EXCEPT the H-05 retry case: a FAILED
 * execution is not "done". Audit H-05 releases the in-flight `executed` lock
 * in the catch branch, so the proposal is re-announceable — but it already
 * has a winningOption (Winner is emitted regardless), so the plain
 * already-announced test would skip it forever and silently.
 *
 * Callers should still per-proposal callStatic-probe announceWinner before
 * broadcasting (the CLI skips would-revert candidates without burning gas).
 *
 * @param nowSeconds unix seconds "now" — pass chain time when available.
 */
export function selectAnnounceCandidates(
  org: VotingOrgData,
  nowSeconds: number
): AnnounceCandidate[] {
  const toAnnounce: AnnounceCandidate[] = [];

  const isEnded = (p: SubgraphProposal): boolean =>
    p.status === 'Ended' ||
    (p.status === 'Active' && !!p.endTimestamp && parseInt(p.endTimestamp) < nowSeconds);

  for (const p of org.hybridVoting?.proposals ?? []) {
    const alreadyDone = (p.status === 'Executed' || p.winningOption != null) && !p.executionFailed;
    if (alreadyDone) continue;
    if (isEnded(p)) {
      toAnnounce.push({
        id: p.proposalId,
        type: 'hybrid',
        title: p.title || `Proposal #${p.proposalId}`,
        retry: Boolean(p.executionFailed),
      });
    }
  }

  for (const p of org.directDemocracyVoting?.ddvProposals ?? []) {
    // Same H-05 retry case as hybrid above.
    const alreadyDone = (p.status === 'Executed' || p.winningOption != null) && !p.executionFailed;
    if (alreadyDone) continue;
    if (isEnded(p)) {
      toAnnounce.push({
        id: p.proposalId,
        type: 'dd',
        title: p.title || `DD Proposal #${p.proposalId}`,
        retry: Boolean(p.executionFailed),
      });
    }
  }

  return toAnnounce;
}

// ────────────────────────── execute state gate ──────────────────────────

/** Pre-broadcast finalization state machine row (pop vote execute). */
export interface ProposalExecutionState {
  proposalId: string;
  status: string;
  winningOption?: string | null;
  wasExecuted?: boolean | null;
  executionFailed?: boolean | null;
  isValid?: boolean | null;
  winnerAnnouncedAt?: string | null;
}

/** The `pop vote execute` state-gate document (src/commands/vote/execute.ts). */
export const GET_PROPOSAL_EXECUTION_STATE = `
  query GetProposal($votingId: String!, $proposalId: String!) {
    proposals(where: { hybridVoting: $votingId, proposalId: $proposalId }, first: 1) {
      proposalId
      status
      winningOption
      wasExecuted
      executionFailed
      isValid
      winnerAnnouncedAt
    }
  }
`;

/**
 * Port of the `pop vote execute` subgraph state gate: fetch the one proposal
 * row the finalize decision is made from. Null row means the proposal is not
 * indexed (the CLI treats that as not found).
 */
export async function fetchProposalExecutionState(
  client: GraphClient,
  hybridVotingAddress: string,
  proposalId: number | string,
  chainId?: number
): Promise<ProposalExecutionState | null> {
  const result = await client.query<{ proposals: ProposalExecutionState[] }>(
    GET_PROPOSAL_EXECUTION_STATE,
    { votingId: hybridVotingAddress, proposalId: proposalId.toString() },
    chainId
  );
  return result.proposals?.[0] ?? null;
}

export type ExecuteGateDecision =
  /** wasExecuted — nothing to do (the CLI info-returns). */
  | { kind: 'already-executed' }
  /** Announced and execution did NOT fail — nothing to do. */
  | { kind: 'already-announced'; isValid?: boolean | null }
  /** Still Active/etc. — the CLI throws PRECONDITION here. */
  | { kind: 'not-ended'; status: string }
  /**
   * Proceed to the callStatic probe + announceWinner. When
   * retryingFailedExecution is true this is the H-05 retry path: the
   * announce succeeded, the execution reverted, and re-running
   * announceWinner is the intended fix (the callStatic probe arbitrates —
   * a pre-#185 contract reverts AlreadyExecuted there).
   */
  | { kind: 'ready'; retryingFailedExecution: boolean };

/**
 * Pure port of the `pop vote execute` decision ladder over the subgraph row
 * (same evaluation order as src/commands/vote/execute.ts). The caller maps
 * 'not-ended' to the CLI's PRECONDITION error and the two "nothing to do"
 * kinds to graceful no-ops.
 */
export function evaluateExecuteGate(proposal: ProposalExecutionState): ExecuteGateDecision {
  if (proposal.wasExecuted) return { kind: 'already-executed' };
  // executionFailed proposals ARE announced — the announce succeeded and the
  // execution reverted. Audit H-05 made that retryable, so it must NOT be
  // treated as already-announced.
  if (proposal.winnerAnnouncedAt && !proposal.executionFailed) {
    return { kind: 'already-announced', isValid: proposal.isValid };
  }
  if (proposal.status !== 'Ended') return { kind: 'not-ended', status: proposal.status };
  return { kind: 'ready', retryingFailedExecution: Boolean(proposal.executionFailed) };
}

// ────────────────────────── results ──────────────────────────

export interface ProposalResultsRankEntry {
  rank: number;
  option: number;
  name: string;
  score: number;
}

export interface ProposalResultsVoter {
  voter: string;
  allocations: Record<string, number>;
}

/** The `pop vote results --json` report shape (an output contract — do not reshape). */
export interface ProposalResults {
  proposalId: string;
  title?: string | null;
  status: string;
  /** IDENTITY or null — deliberately never an address (see fetch doc comment). */
  proposedBy: string | null;
  proposerAddress: string | null;
  classVersionAtCreation: string | null;
  liveClassVersion: string | null;
  classConfigDrifted: boolean;
  winnerAnnouncedAt: number | null;
  executedAt: number | null;
  executedCallsCount: number | null;
  actionSummaries: string[];
  promotedFrom: string | null;
  totalVoters: number;
  supportThresholdPct?: number;
  quorumVoterCount?: number;
  ranking: ProposalResultsRankEntry[];
  voters: ProposalResultsVoter[];
  winner?: ProposalResultsRankEntry;
}

/**
 * The `pop vote results` proposal document (src/commands/vote/results.ts).
 * Two tiers: the #195 attribution/provenance fields, then the pre-#195 field
 * set. A GraphQL document validates as a whole, so without the fallback an
 * endpoint that predates #195 would lose the rankings and voter breakdown
 * this read exists to serve. The legacy tier is spelled out rather than
 * derived so a reformat cannot silently turn it into a copy of the modern one.
 */
export function buildProposalResultsQuery(orgId: string, proposalId: number, modern: boolean): string {
  const proposalCore = 'proposalId title status';
  return `{
    organization(id: "${orgId}") {
      hybridVoting {
        thresholdPct
        quorum
        ${modern ? 'classVersion' : ''}
        proposals(where: {proposalId: ${proposalId}}) {
          ${proposalCore}
          ${modern ? 'proposer proposerUsername creatorUsername' : ''}
          ${modern ? 'classesVersion winnerAnnouncedAt executedAt executedCallsCount' : ''}
          metadata { description optionNames${modern ? ' actionSummaries promotedFrom' : ''} }
          votes { voterUsername optionIndexes optionWeights }
        }
      }
    }
  }`;
}

/**
 * Pure port of the `pop vote results` tally/ranking/attribution computation
 * (src/commands/vote/results.ts) over the fetched hybridVoting row.
 *
 * Attribution: subgraph #195. proposer* are the current names; creator* the
 * older aliases populated identically from transaction.from. proposedBy is an
 * IDENTITY or null — never an address: most proposers are Executor or
 * smart-account addresses with no username, and returning the address here
 * would make `proposedBy === 'someone'` silently false for them while looking
 * like a resolved name. The address is always available as proposerAddress.
 */
export function computeProposalResults(hybridVoting: {
  thresholdPct?: string | number | null;
  quorum?: string | number | null;
  classVersion?: string | null;
  proposals?: Array<SubgraphProposal & {
    winnerAnnouncedAt?: string | null;
    executedAt?: string | null;
    executedCallsCount?: string | number | null;
    metadata?: {
      description?: string | null;
      optionNames?: string[] | null;
      actionSummaries?: string[] | null;
      promotedFrom?: string | null;
    } | null;
  }>;
}): ProposalResults | null {
  const proposal = hybridVoting.proposals?.[0];
  if (!proposal) return null;

  // Two DISTINCT validity parameters — threshold is a % of weighted power,
  // quorum is a raw voter count. Never conflate them.
  const supportThresholdPct = hybridVoting.thresholdPct !== undefined ? Number(hybridVoting.thresholdPct) : undefined;
  const quorumVoterCount = hybridVoting.quorum !== undefined ? Number(hybridVoting.quorum) : undefined;

  const optionNames = proposal.metadata?.optionNames || [];
  const votes = proposal.votes || [];

  // Tally weighted votes per option
  const tallies: number[] = new Array(Math.max(optionNames.length, 1)).fill(0);
  for (const v of votes) {
    for (let i = 0; i < (v.optionIndexes || []).length; i++) {
      const idx = parseInt(v.optionIndexes[i]);
      const weight = parseInt(v.optionWeights[i]);
      if (idx < tallies.length) tallies[idx] += weight;
    }
  }

  // Rank options
  const ranked: ProposalResultsRankEntry[] = optionNames
    .map((name: string, i: number) => ({ rank: 0, option: i, name, score: tallies[i] || 0 }))
    .sort((a, b) => b.score - a.score);
  ranked.forEach((r, i) => { r.rank = i + 1; });

  // Per-voter breakdown
  const voterBreakdown: ProposalResultsVoter[] = votes.map((v) => {
    const allocations: Record<string, number> = {};
    for (let i = 0; i < (v.optionIndexes || []).length; i++) {
      const idx = parseInt(v.optionIndexes[i]);
      const name = optionNames[idx] || `Option ${idx}`;
      allocations[name] = parseInt(v.optionWeights[i]);
    }
    return { voter: v.voterUsername || 'unknown', allocations };
  });

  const proposedBy = proposal.proposerUsername || proposal.creatorUsername || null;
  // A proposal is tallied against the voting-class config in force when it was
  // CREATED, so a live config change mid-flight makes the org-level
  // threshold/quorum shown here stale.
  const classVersionAtCreation = proposal.classesVersion != null ? String(proposal.classesVersion) : null;
  const liveClassVersion = hybridVoting.classVersion != null ? String(hybridVoting.classVersion) : null;
  const classConfigDrifted = Boolean(
    classVersionAtCreation && liveClassVersion && classVersionAtCreation !== liveClassVersion
  );

  return {
    proposalId: proposal.proposalId,
    title: proposal.title,
    status: proposal.status,
    proposedBy,
    proposerAddress: proposal.proposer || null,
    classVersionAtCreation,
    liveClassVersion,
    classConfigDrifted,
    winnerAnnouncedAt: proposal.winnerAnnouncedAt ? Number(proposal.winnerAnnouncedAt) : null,
    executedAt: proposal.executedAt ? Number(proposal.executedAt) : null,
    executedCallsCount: proposal.executedCallsCount != null ? Number(proposal.executedCallsCount) : null,
    actionSummaries: proposal.metadata?.actionSummaries || [],
    promotedFrom: proposal.metadata?.promotedFrom || null,
    totalVoters: votes.length,
    supportThresholdPct,
    quorumVoterCount,
    ranking: ranked,
    voters: voterBreakdown,
    winner: ranked[0],
  };
}

/**
 * Port of `pop vote results` (src/commands/vote/results.ts): rankings +
 * per-voter breakdown for one proposal. Throws the CLI's not-found error when
 * the proposal is not indexed.
 */
export async function fetchProposalResults(
  client: GraphClient,
  orgIdOrName: string,
  proposalId: number,
  chainId?: number
): Promise<ProposalResults> {
  const orgId = await resolveOrgId(client, orgIdOrName, chainId);
  const { data } = await client.queryWithFieldFallback<any>(
    [
      { query: buildProposalResultsQuery(orgId, proposalId, true) },
      { query: buildProposalResultsQuery(orgId, proposalId, false) },
    ],
    { chainId }
  );
  const hybridVoting = data.organization?.hybridVoting;
  const report = hybridVoting ? computeProposalResults(hybridVoting) : null;
  if (!report) throw new CliError(`Proposal #${proposalId} not found`, EXIT.USAGE);
  return report;
}

// ────────────────────────── classes snapshot ──────────────────────────

/** Normalized class row — identical shape from the subgraph and the contract. */
export interface NormalizedClass {
  classIndex: number;
  strategy: string;
  slicePct: number;
  quadratic: boolean;
  minBalance: string;
  asset: string;
  hatIds: string[];
}

export interface ClassConfigSnapshot {
  classes: NormalizedClass[];
  supportThresholdPct: number;
  quorumVoterCount: number;
}

/**
 * Subgraph rows → the exact shape the contract path produces. `asset` is
 * checksummed because ethers returns a checksummed address and the subgraph
 * returns lowercase Bytes; without this the `asset` value would change casing
 * depending on which source answered.
 */
export function normalizeSubgraphClasses(rows: SubgraphVotingClass[]): NormalizedClass[] {
  return rows.map((c, i) => ({
    classIndex: i,
    strategy: String(c.strategy),
    slicePct: Number(c.slicePct),
    quadratic: Boolean(c.quadratic),
    minBalance: ethers.BigNumber.from(String(c.minBalance ?? '0')).toString(),
    asset: ethers.utils.getAddress(String(c.asset)),
    hatIds: (c.hatIds ?? []).map(h => String(h)),
  }));
}

/**
 * Port of `pop vote classes show`'s subgraph read
 * (fetchClassConfigFromSubgraph, src/commands/vote/classes.ts): the class
 * table + both validity parameters. Returns null whenever the subgraph cannot
 * answer authoritatively (contract not indexed, no rows for the requested
 * version, missing schema fields, network error) so the caller falls back to
 * the contract (getClasses()/getProposalClasses()/thresholdPct()/quorum())
 * instead of showing an empty table.
 */
export async function fetchClassConfig(
  client: GraphClient,
  hybridVotingAddress: string,
  proposalId?: number,
  chainId?: number
): Promise<ClassConfigSnapshot | null> {
  try {
    const hybridVoting = hybridVotingAddress.toLowerCase();
    // The proposal-snapshot query has a single tier on purpose: a deployment
    // without Proposal.classesVersion cannot identify the frozen snapshot, and
    // guessing the newest version would silently misreport an old proposal.
    const tiers = proposalId === undefined
      ? [
          { query: FETCH_VOTING_CLASS_CONFIG, variables: { hybridVoting } },
          { query: FETCH_VOTING_CLASS_CONFIG_LEGACY, variables: { hybridVoting } },
        ]
      : [
          { query: FETCH_PROPOSAL_VOTING_CLASSES, variables: { hybridVoting, proposalId: String(proposalId) } },
        ];

    const { data } = await client.queryWithFieldFallback<any>(tiers, { chainId });
    const contract = data?.hybridVotingContract;
    if (!contract) return null;

    const version = proposalId === undefined
      ? contract.classVersion
      : contract.proposals?.[0]?.classesVersion;
    // For a proposal we must know its frozen version — no version, no answer.
    if (proposalId !== undefined && (version === null || version === undefined)) return null;

    const rows = selectClassSnapshot(contract.votingClasses, version);
    if (rows.length === 0) return null;
    if (contract.thresholdPct === null || contract.thresholdPct === undefined) return null;
    if (contract.quorum === null || contract.quorum === undefined) return null;

    return {
      classes: normalizeSubgraphClasses(rows),
      supportThresholdPct: Number(contract.thresholdPct),
      quorumVoterCount: Number(contract.quorum),
    };
  } catch {
    // Any subgraph problem (unknown field on an old deployment, lag, HTTP) —
    // the contract is authoritative anyway, so just fall back.
    return null;
  }
}
