/**
 * pop org boundary-score — capture-cluster boundary scoring per argus v0.5 spec.
 *
 * Task #489 (argus HB#491). Sprint 20 P3-tied follow-through.
 *
 * Computes BS_total per boundary-heuristic-spec-hb451.md v0.5 (HB#451-469):
 *
 *   BS_total = w_ε·BS_substrate + w_ζ·BS_cohort + w_η·BS_dimension + {flags}
 *
 * Where:
 *   - BS_substrate: Euclidean distance from substrate-band centroid (Gini, top-5%, pass rate)
 *   - BS_cohort: 1 - min(|N-15|, |N-50|)/17.5
 *   - BS_dimension: max(0, full_membership_count - 1) / 7 (post v2.1.4 disqualifier)
 *   - Flags: isPatternIota + isMigrating per v0.4 Option C / vigil HB#462
 *   - Default weights: 1/3 each (HB#451 v0.1) OR 0.5/0.2/0.3 (HB#467 recalibration recommendation)
 *
 * Classification per HB#469 v0.5 calibrated thresholds:
 *   HIGH: BS_total ≥ 0.4
 *   MEDIUM: 0.2 ≤ BS_total < 0.4
 *   LOW: BS_total < 0.2
 *
 * MVP scope (HB#491):
 *   - Pure helpers exported for tests
 *   - Substrate-band centroids hardcoded per HB#467 prototype values
 *   - Snapshot data fetch via reused snapshotGraphQL pattern
 *   - --dimension-flags accepts comma-separated dimension membership (A,B2e,C,etc.)
 *   - Future v2: auto-derive dimensions from audit-snapshot output
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import * as output from '../../lib/output';
import { snapshotGraphQL } from '../../lib/snapshot';

const SNAPSHOT_API = 'https://hub.snapshot.org/graphql';

/**
 * Task #498 (retro-Sprint-21 idea-6, HB#892 v0.2): auto-fetch boundary-score
 * inputs (gini / top5pct / passRate / N) directly from Snapshot for the given
 * space. Mirrors the metric-computation logic in audit-snapshot.ts (lines
 * ~320-390): fetch closed proposals + votes, aggregate voter VP, compute
 * Gini via mean-abs-difference, top-5 cumulative share, and pass rate by
 * first-choice-wins heuristic.
 *
 * Returns { gini, top5pct, passRate, N } where N is unique-voter count.
 * Throws if Snapshot returns no closed proposals.
 *
 * Exported for unit testing.
 */
export async function autoFetchMetricsFromSnapshot(
  space: string,
  proposalSampleSize: number = 100,
): Promise<{ gini: number; top5pct: number; passRate: number; N: number; proposalsAnalyzed: number }> {
  // Snapshot limit: `proposal_in` argument ≤ 100 items. Keep sample at 100 max.
  if (proposalSampleSize > 100) proposalSampleSize = 100;
  // Fetch last N closed proposals
  const propQuery = `
    query($space: String!, $first: Int!) {
      proposals(where: {space: $space, state: "closed"}, first: $first, orderBy: "created", orderDirection: desc) {
        id
        state
        scores
      }
    }
  `;
  // Note: lib/snapshot.ts snapshotGraphQL already unwraps .data, returns the inner object directly
  const propJson = await snapshotGraphQL(propQuery, { space, first: proposalSampleSize });
  const closed = (propJson.proposals || []).filter((p: any) => p && Array.isArray(p.scores));
  if (closed.length === 0) {
    throw new Error(`No closed proposals for Snapshot space "${space}" (auto-fetch requires at least 1 closed proposal)`);
  }

  // Fetch all votes for those proposals
  const proposalIds: string[] = closed.map((p: any) => p.id);
  // Snapshot enforces first ≤ 1000 per query. Fetch up to 1000 highest-VP votes
  // across the proposal set. Note: this samples the top-VP slice which is what
  // matters for Gini + top-5 metrics; lower-VP votes would only reduce top-5
  // share (bounded by denominator) without changing the tail characteristic.
  const votesQuery = `
    query($proposals: [String!]!) {
      votes(where: {proposal_in: $proposals}, first: 1000, orderBy: "vp", orderDirection: desc) {
        voter
        vp
      }
    }
  `;
  const votesJson = await snapshotGraphQL(votesQuery, { proposals: proposalIds });
  const votes = votesJson.votes || [];

  // Aggregate VP per voter
  const voterPower: Record<string, number> = {};
  for (const v of votes) {
    voterPower[v.voter] = (voterPower[v.voter] || 0) + (v.vp || 0);
  }
  const sortedVoters = Object.entries(voterPower).sort((a, b) => b[1] - a[1]);
  const totalVP = sortedVoters.reduce((sum, [, vp]) => sum + vp, 0);
  const N = sortedVoters.length;

  if (N === 0 || totalVP === 0) {
    throw new Error(`No votes found for Snapshot space "${space}" across ${closed.length} closed proposals`);
  }

  // Compute Gini via mean-abs-difference (matches audit-snapshot formula)
  const vpValues = sortedVoters.map(([, vp]) => vp).sort((a, b) => a - b);
  let gini = 0;
  if (vpValues.length > 1 && totalVP > 0) {
    let sumDiffs = 0;
    for (let i = 0; i < vpValues.length; i++) {
      for (let j = 0; j < vpValues.length; j++) {
        sumDiffs += Math.abs(vpValues[i] - vpValues[j]);
      }
    }
    gini = sumDiffs / (2 * vpValues.length * totalVP);
  }

  // Top-5 cumulative share (fraction, 0-1)
  const top5vp = sortedVoters.slice(0, 5).reduce((sum, [, vp]) => sum + vp, 0);
  const top5pct = totalVP > 0 ? top5vp / totalVP : 0;

  // Pass rate: first-choice-wins heuristic (matches audit-snapshot line 349-352)
  const passedCount = closed.filter((p: any) => {
    if (!p.scores || p.scores.length < 2) return true;
    return p.scores[0] > p.scores[1];
  }).length;
  const passRate = closed.length > 0 ? passedCount / closed.length : 0;

  return {
    gini: parseFloat(gini.toFixed(3)),
    top5pct: parseFloat(top5pct.toFixed(3)),
    passRate: parseFloat(passRate.toFixed(3)),
    N,
    proposalsAnalyzed: closed.length,
  };
}

export type SubstrateBand = 'pure-token' | 'snapshot-signaling' | 'nft-participation' | 'conviction-locked' | 'unknown';

/**
 * Substrate-band centroids per HB#467 prototype (corpus-derived approximations).
 * Format: [Gini, top5pct, passRate]
 * conviction-locked is n=1 (Polkadot only) so centroid undefined; BS_substrate
 * skipped for that band per v0.3 open-question #3.
 */
export const SUBSTRATE_CENTROIDS: Record<SubstrateBand, [number, number, number] | null> = {
  'pure-token': [0.82, 0.92, 0.90],
  'snapshot-signaling': [0.74, 0.80, 0.95],
  'nft-participation': [0.68, 0.72, 0.85],
  'conviction-locked': null,
  unknown: null,
};

/**
 * Max distance within band for BS_substrate normalization.
 * Approximated from HB#467 worked examples (Spark 0.186 max in pure-token band).
 *
 * HB#897 refinement (Option B per HB#896 analysis): per-substrate MAX_DIST.
 * Snapshot-signaling band has wider natural cluster dispersion (more governance-
 * model diversity: DAO-wide + dev proposals + gauge votes). HB#896 empirical
 * sweep of n=5 snapshot-signaling DAOs (ens/opcollective/arb-fdn/gitcoin/safe)
 * showed distances 0.34-0.48 from centroid, all max-clamping to 1.0 at
 * MAX_DIST=0.20. Per-substrate max-dist preserves pure-token tightness while
 * allowing snapshot-signaling dispersion without loss of discriminating power.
 */
const MAX_DIST_IN_BAND: Record<SubstrateBand, number> = {
  'pure-token': 0.20,
  'snapshot-signaling': 0.50,
  'nft-participation': 0.30,
  'conviction-locked': 0.20,
  unknown: 0.20,
};

/**
 * Default weights per HB#467 recalibration recommendation.
 * Equal 1/3 placeholder per v0.1, but worked examples suggest substrate dominates
 * for extreme-cluster cases (Spark 0.99 BS_substrate).
 */
export const DEFAULT_WEIGHTS = { substrate: 0.5, cohort: 0.2, dimension: 0.3 } as const;

/**
 * Classified-boundary thresholds per HB#469 v0.5 calibration.
 * Original HB#451 expectations were over-optimistic; v0.5 empirical thresholds:
 */
export const BS_THRESHOLDS = { high: 0.4, medium: 0.2 } as const;

interface BoundaryScoreArgs {
  org?: string;
  space?: string;
  gini?: number;
  top5pct?: number;
  passRate?: number;
  patternThetaPassRate?: number; // Task #500 (vigil HB#536): Pattern θ integration
  cohortN?: number;
  substrateBand?: SubstrateBand;
  dimensionFlags?: string;
  isPatternIota?: boolean;
  isMigrating?: boolean;
  weights?: string;
  json?: boolean;
}

export interface BoundaryScoreResult {
  space?: string;
  inputs: {
    gini?: number;
    top5pct?: number;
    passRate?: number;
    cohortN?: number;
    substrateBand?: SubstrateBand;
    dimensionFlags?: string[];
    isPatternIota?: boolean;
    isMigrating?: boolean;
  };
  weights: { substrate: number; cohort: number; dimension: number };
  components: {
    bsSubstrate: number | null;
    bsCohort: number | null;
    bsDimension: number | null;
  };
  bsTotal: number | null;
  classification: 'HIGH' | 'MEDIUM' | 'LOW' | 'PARTIAL' | 'UNKNOWN';
  flags: string[];
  notes: string[];
}

/**
 * BS_substrate: Euclidean distance from substrate-band centroid (Gini, top5pct, passRate).
 * Returns 0 (band centroid) to 1 (band extreme); null if band has no centroid.
 */
export function computeBSSubstrate(
  band: SubstrateBand,
  gini: number,
  top5pct: number,
  passRate: number,
): number | null {
  const centroid = SUBSTRATE_CENTROIDS[band];
  if (!centroid) return null;
  const [cGini, cTop5, cPass] = centroid;
  const dist = Math.sqrt(
    (gini - cGini) ** 2 + (top5pct - cTop5) ** 2 + (passRate - cPass) ** 2,
  );
  const maxDist = MAX_DIST_IN_BAND[band] ?? 0.20;
  return Math.min(1, dist / maxDist);
}

/**
 * BS_cohort: distance from regime-boundary thresholds (N=15, N=50).
 * Returns 1 at boundary (N=15 or N=50), 0 deep inside regime.
 * max_window = 17.5 (half-distance between thresholds).
 */
export function computeBSCohort(N: number): number {
  if (N <= 0) return 0;
  const distFrom15 = Math.abs(N - 15);
  const distFrom50 = Math.abs(N - 50);
  const minDist = Math.min(distFrom15, distFrom50);
  return Math.max(0, 1 - minDist / 17.5);
}

/**
 * BS_dimension: full_membership count minus 1, divided by 7 per v0.4 Option C.
 * Pattern ι treated as separate axis (annotation flag), excluded from count.
 * Per v2.1.4 disqualifier: if coordinated-dual-whale, BS_dimension = 0 (skip).
 */
export function computeBSDimension(
  fullMembershipCount: number,
  isCoordinatedDualWhale: boolean = false,
): number {
  if (isCoordinatedDualWhale) return 0;
  return Math.max(0, fullMembershipCount - 1) / 7;
}

/**
 * Classify BS_total per v0.5 calibrated thresholds.
 */
export function classifyBSTotal(bsTotal: number | null): 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' {
  if (bsTotal === null) return 'UNKNOWN';
  if (bsTotal >= BS_THRESHOLDS.high) return 'HIGH';
  if (bsTotal >= BS_THRESHOLDS.medium) return 'MEDIUM';
  return 'LOW';
}

/**
 * Parse dimension-flags arg (comma-separated dimension labels) into count.
 * Excludes ι (Pattern ι separate axis per v0.4 Option C).
 * Excludes D (anti-cluster floor per v0.2 spec).
 */
export function parseDimensionFlags(flagsArg: string | undefined): { dims: string[]; count: number } {
  if (!flagsArg) return { dims: [], count: 0 };
  const dims = flagsArg.split(',').map(s => s.trim()).filter(Boolean);
  // Exclude ι (separate axis) and D (anti-cluster floor) from count
  const counted = dims.filter(d => d !== 'ι' && d !== 'iota' && d !== 'D');
  return { dims, count: counted.length };
}

/**
 * Parse weights arg (comma-separated w_substrate,w_cohort,w_dimension).
 */
function parseWeights(weightsArg: string | undefined): { substrate: number; cohort: number; dimension: number } {
  if (!weightsArg) return { ...DEFAULT_WEIGHTS };
  const parts = weightsArg.split(',').map(s => Number(s.trim()));
  if (parts.length !== 3 || parts.some(n => isNaN(n))) {
    throw new Error(`Invalid --weights: expected "w_substrate,w_cohort,w_dimension" got "${weightsArg}"`);
  }
  const [substrate, cohort, dimension] = parts;
  return { substrate, cohort, dimension };
}

/**
 * Compute BS_total + classification + flags per v0.5 spec.
 */
export function computeBoundaryScore(args: {
  band?: SubstrateBand;
  gini?: number;
  top5pct?: number;
  passRate?: number;
  N?: number;
  fullMembershipCount?: number;
  isCoordinatedDualWhale?: boolean;
  isPatternIota?: boolean;
  isMigrating?: boolean;
  weights?: { substrate: number; cohort: number; dimension: number };
}): { components: { bsSubstrate: number | null; bsCohort: number | null; bsDimension: number | null }; bsTotal: number | null; classification: 'HIGH' | 'MEDIUM' | 'LOW' | 'PARTIAL' | 'UNKNOWN'; flags: string[]; notes: string[] } {
  const w = args.weights ?? DEFAULT_WEIGHTS;
  const flags: string[] = [];
  const notes: string[] = [];

  const bsSubstrate = (args.band && args.gini !== undefined && args.top5pct !== undefined && args.passRate !== undefined)
    ? computeBSSubstrate(args.band, args.gini, args.top5pct, args.passRate)
    : null;
  if (bsSubstrate === null && args.band) {
    notes.push(`BS_substrate undefined: substrate band "${args.band}" has no centroid (n=1 band)`);
  }

  const bsCohort = (args.N !== undefined && args.N > 0) ? computeBSCohort(args.N) : null;

  const bsDimension = (args.fullMembershipCount !== undefined)
    ? computeBSDimension(args.fullMembershipCount, args.isCoordinatedDualWhale ?? false)
    : null;
  if (args.isCoordinatedDualWhale) {
    notes.push('Coordinated-dual-whale disqualifier applied: BS_dimension = 0 (v2.1.4)');
  }

  if (args.isPatternIota) flags.push('isPatternIota — interpret BS components per-proposal-subset, not aggregate');
  if (args.isMigrating) flags.push('isMigrating — substrate-migration in progress, distance may shift');

  // Compute BS_total only if all components available; else PARTIAL
  let bsTotal: number | null = null;
  let classification: 'HIGH' | 'MEDIUM' | 'LOW' | 'PARTIAL' | 'UNKNOWN' = 'UNKNOWN';
  if (bsSubstrate !== null && bsCohort !== null && bsDimension !== null) {
    bsTotal = w.substrate * bsSubstrate + w.cohort * bsCohort + w.dimension * bsDimension;
    classification = classifyBSTotal(bsTotal);
  } else {
    // Partial sum from available components (zero-weight missing components)
    const availableTotal = (w.substrate * (bsSubstrate ?? 0)) + (w.cohort * (bsCohort ?? 0)) + (w.dimension * (bsDimension ?? 0));
    bsTotal = availableTotal;
    classification = 'PARTIAL';
    notes.push(`Partial BS_total: missing ${[bsSubstrate === null && 'substrate', bsCohort === null && 'cohort', bsDimension === null && 'dimension'].filter(Boolean).join(', ')} component(s)`);
  }

  return { components: { bsSubstrate, bsCohort, bsDimension }, bsTotal, classification, flags, notes };
}

async function handlerImpl(argv: ArgumentsCamelCase<BoundaryScoreArgs>): Promise<void> {
  const weights = parseWeights(argv.weights);
  const dimParse = parseDimensionFlags(argv.dimensionFlags);

  // Task #498 v0.2: auto-fetch mode. If --space is supplied AND one-or-more
  // of gini/top5pct/passRate are missing, fetch from Snapshot. Manual args
  // still override — e.g. --space curve.eth --gini 0.85 uses 0.85 not fetched.
  let effectiveGini = argv.gini;
  let effectiveTop5pct = argv.top5pct;
  let effectivePassRate = argv.passRate;
  let effectiveCohortN = argv.cohortN;
  let autoFetched = false;
  let autoFetchedNotes: string[] = [];

  const needsFetch = argv.space && (
    argv.gini === undefined ||
    argv.top5pct === undefined ||
    argv.passRate === undefined
  );
  if (needsFetch) {
    try {
      const metrics = await autoFetchMetricsFromSnapshot(argv.space!);
      // Only fill in missing values; manual args override fetched
      if (effectiveGini === undefined) effectiveGini = metrics.gini;
      if (effectiveTop5pct === undefined) effectiveTop5pct = metrics.top5pct;
      if (effectivePassRate === undefined) effectivePassRate = metrics.passRate;
      if (effectiveCohortN === undefined) effectiveCohortN = metrics.N;
      autoFetched = true;
      autoFetchedNotes.push(
        `Auto-derived from Snapshot: gini=${metrics.gini}, top5=${(metrics.top5pct * 100).toFixed(1)}%, passRate=${(metrics.passRate * 100).toFixed(1)}%, N=${metrics.N} (${metrics.proposalsAnalyzed} proposals analyzed)`,
      );
    } catch (err: any) {
      autoFetchedNotes.push(`Auto-fetch failed: ${err?.message || err}. Using manual args only.`);
    }
  }

  // Task #500 (HB#536 vigil): Pattern θ integration. When --pattern-theta-pass-rate
  // is supplied, it OVERRIDES the empirical passRate used in BS_substrate. Also
  // emit a divergence warning if |theta - empirical| > 0.10 so operators notice
  // cases where θ and empirical disagree materially (typically Rule-A captured
  // DAOs where empirical is inflated by automatic-pass flow).
  let empiricalPassRateForRecord: number | undefined;
  if (argv.patternThetaPassRate !== undefined) {
    empiricalPassRateForRecord = effectivePassRate;
    const theta = argv.patternThetaPassRate;
    if (effectivePassRate !== undefined && Math.abs(theta - effectivePassRate) > 0.10) {
      autoFetchedNotes.push(
        `⚠ Pattern θ prediction diverges from empirical: θ=${theta.toFixed(2)} vs empirical=${effectivePassRate.toFixed(2)} (diff=${Math.abs(theta - effectivePassRate).toFixed(2)}). Pattern θ accounts for proposal type + Rule-A capture + noise filter; consider this a more reliable substrate-distance input.`,
      );
    }
    autoFetchedNotes.push(
      `Pattern θ override applied: BS_substrate uses predictedPassRate=${theta.toFixed(3)} instead of empirical=${(effectivePassRate ?? 0).toFixed(3)}.`,
    );
    effectivePassRate = theta;
  }

  const result: BoundaryScoreResult = {
    space: argv.space,
    inputs: {
      gini: effectiveGini,
      top5pct: effectiveTop5pct,
      passRate: effectivePassRate,
      cohortN: effectiveCohortN,
      substrateBand: argv.substrateBand as SubstrateBand,
      dimensionFlags: dimParse.dims,
      isPatternIota: argv.isPatternIota,
      isMigrating: argv.isMigrating,
    },
    weights,
    components: { bsSubstrate: null, bsCohort: null, bsDimension: null },
    bsTotal: null,
    classification: 'UNKNOWN',
    flags: [],
    notes: [],
  };

  const computed = computeBoundaryScore({
    band: argv.substrateBand as SubstrateBand,
    gini: effectiveGini,
    top5pct: effectiveTop5pct,
    passRate: effectivePassRate,
    N: effectiveCohortN,
    fullMembershipCount: dimParse.count,
    isCoordinatedDualWhale: false, // future: derive from audit data
    isPatternIota: argv.isPatternIota,
    isMigrating: argv.isMigrating,
    weights,
  });

  result.components = computed.components;
  result.bsTotal = computed.bsTotal;
  result.classification = computed.classification;
  result.flags = computed.flags;
  result.notes = [...autoFetchedNotes, ...computed.notes];
  if (autoFetched) (result as any).autoFetched = true;

  if (argv.json) {
    output.json(result);
  } else {
    output.info(`boundary-score (${result.classification}): BS_total=${result.bsTotal?.toFixed(3) ?? 'n/a'} | substrate=${result.components.bsSubstrate?.toFixed(3) ?? 'n/a'} cohort=${result.components.bsCohort?.toFixed(3) ?? 'n/a'} dim=${result.components.bsDimension?.toFixed(3) ?? 'n/a'} | flags=[${result.flags.join('; ') || 'none'}]${result.notes.length > 0 ? ' | notes: ' + result.notes.join('; ') : ''}`);
  }
}

export const boundaryScoreHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('space', { type: 'string', describe: 'Snapshot space ID (e.g. curve.eth)' })
      .option('gini', { type: 'number', describe: 'Gini coefficient (0-1)' })
      .option('top5pct', { type: 'number', describe: 'Top-5 voter concentration (0-1)' })
      .option('pass-rate', { type: 'number', describe: 'Pass rate (0-1; empirical: fraction of closed proposals that passed)' })
      .option('pattern-theta-pass-rate', {
        type: 'number',
        describe: 'Pattern θ predicted pass rate (0-1). When supplied, USED INSTEAD OF empirical --pass-rate in BS_substrate. Pattern θ accounts for decision-type weighted-mix + Rule-A adjustment + noise filter; more reliable than empirical for capture-adjusted cases. Task #500 (HB#536 vigil). Run `pop org audit-snapshot --space X --classify-proposals --json` and pass its predictedPassRate here.',
      })
      .option('cohort-n', { type: 'number', describe: 'Voter cohort size N' })
      .option('substrate-band', { type: 'string', choices: ['pure-token', 'snapshot-signaling', 'nft-participation', 'conviction-locked', 'unknown'] as const, describe: 'Substrate band' })
      .option('dimension-flags', { type: 'string', describe: 'Comma-separated dimension memberships (e.g. "A,C,B2e")' })
      .option('is-pattern-iota', { type: 'boolean', describe: 'DAO exhibits Pattern ι (annotation flag)', default: false })
      .option('is-migrating', { type: 'boolean', describe: 'DAO mid-substrate-migration (annotation flag)', default: false })
      .option('weights', { type: 'string', describe: 'Custom weights "w_substrate,w_cohort,w_dimension" (default 0.5,0.2,0.3)' })
      .option('json', { type: 'boolean', describe: 'JSON output' }),
  handler: handlerImpl,
};
