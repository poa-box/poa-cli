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

const SNAPSHOT_API = 'https://hub.snapshot.org/graphql';

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
 */
const MAX_DIST_IN_BAND = 0.20;

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
  return Math.min(1, dist / MAX_DIST_IN_BAND);
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

  const result: BoundaryScoreResult = {
    space: argv.space,
    inputs: {
      gini: argv.gini,
      top5pct: argv.top5pct,
      passRate: argv.passRate,
      cohortN: argv.cohortN,
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
    gini: argv.gini,
    top5pct: argv.top5pct,
    passRate: argv.passRate,
    N: argv.cohortN,
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
  result.notes = computed.notes;

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
      .option('pass-rate', { type: 'number', describe: 'Pass rate (0-1)' })
      .option('cohort-n', { type: 'number', describe: 'Voter cohort size N' })
      .option('substrate-band', { type: 'string', choices: ['pure-token', 'snapshot-signaling', 'nft-participation', 'conviction-locked', 'unknown'] as const, describe: 'Substrate band' })
      .option('dimension-flags', { type: 'string', describe: 'Comma-separated dimension memberships (e.g. "A,C,B2e")' })
      .option('is-pattern-iota', { type: 'boolean', describe: 'DAO exhibits Pattern ι (annotation flag)', default: false })
      .option('is-migrating', { type: 'boolean', describe: 'DAO mid-substrate-migration (annotation flag)', default: false })
      .option('weights', { type: 'string', describe: 'Custom weights "w_substrate,w_cohort,w_dimension" (default 0.5,0.2,0.3)' })
      .option('json', { type: 'boolean', describe: 'JSON output' }),
  handler: handlerImpl,
};
