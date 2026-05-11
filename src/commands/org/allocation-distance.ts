/**
 * pop org allocation-distance — Jaccard + cosine on multi-option Snapshot votes.
 *
 * Closes the HB#680 Frax negative finding: binary co-vote metrics (Pattern δ /
 * ι) miss gauge-allocation coordination because every multi-option voter
 * trivially "co-votes" on every proposal. Real coordination shows up in
 * ALLOCATION VECTOR similarity — two voters who consistently weight the same
 * options high are coordinating; two voters with orthogonal allocations are
 * not, even if they "co-voted" on every proposal.
 *
 * For each pair of voters who participated in the same weighted/quadratic
 * proposal, compute:
 *   - cosine similarity on the normalized allocation vector (continuous,
 *     1.0 = identical allocation pattern, 0 = orthogonal)
 *   - jaccard distance on the support set (which options got nonzero
 *     weight) — coarse but interpretable
 *
 * Surfaces top-N pairs averaged across all eligible proposals. Use to find
 * gauge-allocation coordination clusters Pattern δ / ι would miss.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { snapshotGraphQL } from '../../lib/snapshot';
import * as output from '../../lib/output';

interface AllocationDistanceArgs {
  space: string | string[];
  limit?: number;
  topN?: number;
  minVp?: number;
  json?: boolean;
  proposalType?: string;
  hubDetection?: boolean;
  hubMinDegree?: number;
  hubMinCos?: number;
  hubScanTopN?: number;
  labelActors?: boolean;
  rpc?: string;
  actorsGraph?: string;
  maxSpaces?: number;
}

interface ActorLabel {
  ens: string | null;
  isContract: boolean;
  codeBytes: number;
}

interface HubVoter {
  voter: string;
  hubDegree: number;
  spokes: Array<{ voter: string; avgCosine: number; proposalsShared: number }>;
  label?: ActorLabel;
}

interface Vote {
  voter: string;
  vp: number;
  proposalId: string;
  choice: Record<string, number> | number[] | number; // Snapshot polymorphic shape
}

interface ProposalInfo {
  id: string;
  title: string;
  type: string;
  choicesCount: number;
}

interface PairScore {
  voterA: string;
  voterB: string;
  proposalsShared: number;
  avgCosine: number;
  avgJaccard: number;
  // HB#1006: deep-equal-choice count (votes where the raw `choice` field is
  // bit-for-bit identical, not just cosine-normalized identical). Distinguishes
  // single-entity coordination (deep-equal ≈ shared) from strategy-following
  // (deep-equal much less than shared).
  deepEqualCount: number;
  combinedVp: number; // sum across shared proposals
}

const SNAPSHOT_API = 'https://hub.snapshot.org/graphql';

/**
 * Normalize a Snapshot `choice` field for a weighted/quadratic vote into a
 * dense numeric vector of length `choicesCount`. Snapshot stores weighted/
 * quadratic choices as { "1": share1, "2": share2, ... } where keys are 1-
 * indexed option positions. Single-choice votes use plain integer (1-indexed).
 * Approval votes use number[] (1-indexed). Returns null when the shape is
 * unsupported.
 */
function toAllocationVector(choice: any, choicesCount: number): number[] | null {
  const v = new Array(choicesCount).fill(0);
  if (choice == null) return null;
  if (typeof choice === 'number') {
    if (choice < 1 || choice > choicesCount) return null;
    v[choice - 1] = 1;
    return v;
  }
  if (Array.isArray(choice)) {
    for (const idx of choice) {
      if (typeof idx !== 'number' || idx < 1 || idx > choicesCount) continue;
      v[idx - 1] = 1;
    }
    return v;
  }
  if (typeof choice === 'object') {
    for (const [k, share] of Object.entries(choice)) {
      const idx = parseInt(k, 10);
      if (!Number.isFinite(idx) || idx < 1 || idx > choicesCount) continue;
      v[idx - 1] = Number(share) || 0;
    }
    return v;
  }
  return null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Annotate each hub with ENS reverse-resolution + isContract flag.
 * Runs in parallel with bounded concurrency to be polite to public RPCs.
 * Failures-per-address are silent (label stays undefined on that hub).
 */
async function labelHubs(hubs: HubVoter[], provider: ethers.providers.Provider, concurrency = 4): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < hubs.length) {
      const i = cursor++;
      const h = hubs[i];
      try {
        const [code, ens] = await Promise.all([
          provider.getCode(h.voter).catch(() => '0x'),
          Promise.race([
            provider.lookupAddress(h.voter).catch(() => null),
            new Promise<null>((res) => setTimeout(() => res(null), 8000)),
          ]),
        ]);
        h.label = {
          ens: ens || null,
          isContract: code !== '0x',
          codeBytes: code === '0x' ? 0 : (code.length - 2) / 2,
        };
      } catch {
        // best-effort; leave label undefined
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hubs.length) }, () => worker()));
}

function computeHubs(
  ranked: PairScore[],
  scanTopN: number,
  minCos: number,
  minDegree: number,
): HubVoter[] {
  const scanned = ranked.slice(0, scanTopN).filter((p) => p.avgCosine >= minCos);
  const adjacency = new Map<string, Array<{ voter: string; avgCosine: number; proposalsShared: number }>>();
  for (const p of scanned) {
    const a = adjacency.get(p.voterA) || [];
    a.push({ voter: p.voterB, avgCosine: p.avgCosine, proposalsShared: p.proposalsShared });
    adjacency.set(p.voterA, a);
    const b = adjacency.get(p.voterB) || [];
    b.push({ voter: p.voterA, avgCosine: p.avgCosine, proposalsShared: p.proposalsShared });
    adjacency.set(p.voterB, b);
  }
  const hubs: HubVoter[] = [];
  for (const [voter, spokes] of adjacency) {
    if (spokes.length < minDegree) continue;
    spokes.sort((a, b) => b.avgCosine - a.avgCosine);
    hubs.push({ voter, hubDegree: spokes.length, spokes });
  }
  hubs.sort((a, b) => b.hubDegree - a.hubDegree);
  return hubs;
}

/**
 * Deterministic JSON serializer for Snapshot `choice` values. Object keys are
 * sorted alphabetically so `{"1":50,"2":50}` and `{"2":50,"1":50}` map to the
 * same string. Used for the deep-equal-choice metric.
 */
function canonicalJSON(v: any): string {
  if (v == null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(v[k])).join(',') + '}';
}

function jaccardSimilarity(a: number[], b: number[]): number {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const aOn = a[i] > 0;
    const bOn = b[i] > 0;
    if (aOn && bOn) intersection++;
    if (aOn || bOn) union++;
  }
  return union === 0 ? 0 : intersection / union;
}

/**
 * HB#637 (vigil) task #524: pure data-fetch + hub-detection for one space.
 * Used by both the original single-space handler and the new --actors-graph
 * multi-space driver. Returns the computed hubs + counts; rendering is
 * caller-side. Does NOT do label resolution — callers handle that to allow
 * cross-space label cache.
 */
interface OneSpaceOpts {
  spaceId: string;
  limit: number;
  minVp: number;
  typeFilter: string | undefined;
  hubMinDegree: number;
  hubMinCos: number;
  hubScanTopN: number;
}
interface OneSpaceResult {
  spaceId: string;
  proposalsAnalyzed: number;
  votersConsidered: number;
  pairsScored: number;
  ranked: PairScore[];
  hubs: HubVoter[];
  error?: string;
}

async function runOneSpace(opts: OneSpaceOpts): Promise<OneSpaceResult> {
  const { spaceId, limit, minVp, typeFilter, hubMinDegree, hubMinCos, hubScanTopN } = opts;
  const empty: OneSpaceResult = {
    spaceId,
    proposalsAnalyzed: 0,
    votersConsidered: 0,
    pairsScored: 0,
    ranked: [],
    hubs: [],
  };
  try {
    const proposalData = await snapshotGraphQL<any>(
      `query($space: String!, $first: Int!) {
        proposals(where: {space: $space}, first: $first, orderBy: "created", orderDirection: desc) {
          id title type choices
        }
      }`,
      { space: spaceId, first: limit },
      { endpoint: SNAPSHOT_API },
    );
    const eligible: ProposalInfo[] = (proposalData.proposals || [])
      .filter((p: any) => {
        if (!p || !p.type) return false;
        if (typeFilter) return p.type === typeFilter;
        return p.type === 'weighted' || p.type === 'quadratic' || p.type === 'approval';
      })
      .map((p: any) => ({ id: p.id, title: p.title, type: p.type, choicesCount: (p.choices || []).length }));
    if (eligible.length === 0) return empty;
    const proposalIds = eligible.map((p) => p.id);
    const voteData = await snapshotGraphQL<any>(
      `query($proposals: [String!]!) {
        votes(where: {proposal_in: $proposals}, first: 1000, orderBy: "vp", orderDirection: desc) {
          voter vp choice proposal { id }
        }
      }`,
      { proposals: proposalIds },
      { endpoint: SNAPSHOT_API },
    );
    const allVotes: Vote[] = (voteData.votes || [])
      .filter((v: any) => (v.vp || 0) >= minVp)
      .map((v: any) => ({
        voter: v.voter,
        vp: v.vp,
        proposalId: v.proposal?.id || '',
        choice: v.choice,
      }));

    const pairStats = new Map<
      string,
      { coSum: number; jaSum: number; n: number; deepEq: number; vpSum: number }
    >();
    for (const prop of eligible) {
      const propVotes = allVotes.filter((v) => v.proposalId === prop.id);
      const vectors = propVotes
        .map((v) => ({
          voter: v.voter,
          vp: v.vp,
          vec: toAllocationVector(v.choice, prop.choicesCount),
          canonChoice: canonicalJSON(v.choice),
        }))
        .filter((v) => v.vec !== null) as Array<{
          voter: string;
          vp: number;
          vec: number[];
          canonChoice: string;
        }>;
      for (let i = 0; i < vectors.length; i++) {
        for (let j = i + 1; j < vectors.length; j++) {
          const a = vectors[i];
          const b = vectors[j];
          const c = cosineSimilarity(a.vec, b.vec);
          const ja = jaccardSimilarity(a.vec, b.vec);
          const deepEq = a.canonChoice === b.canonChoice ? 1 : 0;
          const key = a.voter < b.voter ? `${a.voter}__${b.voter}` : `${b.voter}__${a.voter}`;
          const cur = pairStats.get(key) || { coSum: 0, jaSum: 0, n: 0, deepEq: 0, vpSum: 0 };
          cur.coSum += c;
          cur.jaSum += ja;
          cur.deepEq += deepEq;
          cur.n += 1;
          cur.vpSum += a.vp + b.vp;
          pairStats.set(key, cur);
        }
      }
    }
    const ranked: PairScore[] = Array.from(pairStats.entries())
      .filter(([, s]) => s.n >= 2)
      .map(([key, s]) => {
        const [voterA, voterB] = key.split('__');
        return {
          voterA,
          voterB,
          proposalsShared: s.n,
          avgCosine: s.coSum / s.n,
          avgJaccard: s.jaSum / s.n,
          deepEqualCount: s.deepEq,
          combinedVp: s.vpSum,
        };
      })
      .sort((a, b) => b.avgCosine - a.avgCosine);
    const hubs = computeHubs(ranked, hubScanTopN, hubMinCos, hubMinDegree);
    return {
      spaceId,
      proposalsAnalyzed: eligible.length,
      votersConsidered: new Set(allVotes.map((v) => v.voter)).size,
      pairsScored: pairStats.size,
      ranked,
      hubs,
    };
  } catch (err) {
    return { ...empty, error: (err as Error).message };
  }
}

/**
 * HB#637 task #524 driver: scan a set of actor addresses across a set of
 * Snapshot spaces, surface the cross-DAO hub-degree matrix. Reuses
 * runOneSpace() per space + computeHubs() pipeline. Label resolution runs
 * ONCE per unique actor (cached across spaces).
 */
async function runActorsGraph(opts: {
  actorsCsv: string;
  spaces: string[];
  maxSpaces: number;
  limit: number;
  minVp: number;
  typeFilter: string | undefined;
  hubMinDegree: number;
  hubMinCos: number;
  hubScanTopN: number;
  wantLabels: boolean;
  rpcUrl: string;
  wantJson: boolean;
}): Promise<void> {
  const actors = opts.actorsCsv
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (actors.length === 0) {
    output.error('--actors-graph: no valid 0x-prefixed 40-hex addresses parsed from input.');
    process.exit(1);
  }
  const spaces = opts.spaces.slice(0, opts.maxSpaces);
  if (opts.spaces.length > opts.maxSpaces) {
    if (!opts.wantJson) {
      console.warn(
        `[--actors-graph] --space list capped at ${opts.maxSpaces} (--max-spaces). Skipped: ${opts.spaces
          .slice(opts.maxSpaces)
          .join(', ')}`,
      );
    }
  }
  const spin = opts.wantJson
    ? null
    : output.spinner(`Scanning ${spaces.length} space(s) × ${actors.length} actor(s)...`);
  spin?.start();

  // Per-space analysis (sequential — Snapshot rate-limits aggressively).
  const perSpace: OneSpaceResult[] = [];
  for (const spaceId of spaces) {
    spin && (spin.text = `Analyzing ${spaceId} (${perSpace.length + 1}/${spaces.length})...`);
    const r = await runOneSpace({
      spaceId,
      limit: opts.limit,
      minVp: opts.minVp,
      typeFilter: opts.typeFilter,
      hubMinDegree: opts.hubMinDegree,
      hubMinCos: opts.hubMinCos,
      hubScanTopN: opts.hubScanTopN,
    });
    perSpace.push(r);
  }

  // Per-actor projection: for each actor, find their hub entry in each space.
  interface ActorRow {
    address: string;
    label?: ActorLabel;
    spaces: Array<{
      space: string;
      hubDegree: number;
      perfectCosinePairs: number;
      error?: string;
    }>;
  }
  const actorRows: ActorRow[] = actors.map((address) => {
    const spaceCells = perSpace.map((s) => {
      if (s.error) return { space: s.spaceId, hubDegree: 0, perfectCosinePairs: 0, error: s.error };
      const hub = s.hubs.find((h) => h.voter.toLowerCase() === address);
      if (!hub) return { space: s.spaceId, hubDegree: 0, perfectCosinePairs: 0 };
      const perfect = hub.spokes.filter((sp) => sp.avgCosine >= 0.999).length;
      return { space: s.spaceId, hubDegree: hub.hubDegree, perfectCosinePairs: perfect };
    });
    return { address, spaces: spaceCells };
  });

  // Label cache: one ENS/contract lookup per unique actor that appears as a hub anywhere.
  if (opts.wantLabels) {
    spin && (spin.text = `Labeling ${actors.length} actor(s) via ENS + isContract (one-shot)...`);
    try {
      const provider = new ethers.providers.StaticJsonRpcProvider(opts.rpcUrl);
      // Reuse labelHubs by wrapping each actor as a single-element pseudo-hub
      // input. This keeps the bounded-concurrency pattern + timeout behavior
      // consistent with the existing label path.
      const pseudoHubs: HubVoter[] = actors.map((address) => ({
        voter: address,
        hubDegree: 0,
        spokes: [],
      }));
      await labelHubs(pseudoHubs, provider);
      for (let i = 0; i < actors.length; i++) {
        if (pseudoHubs[i].label) actorRows[i].label = pseudoHubs[i].label;
      }
    } catch (e) {
      if (!opts.wantJson) {
        console.warn(`\n[--actors-graph label-actors] failed: ${(e as Error).message}. Continuing without labels.`);
      }
    }
  }

  // Aggregate summary.
  const actorsAcrossMultiple = actorRows.filter(
    (a) => a.spaces.filter((s) => s.hubDegree > 0).length >= 2,
  ).length;
  const maxHubDegree = actorRows.reduce(
    (m, a) => Math.max(m, ...a.spaces.map((s) => s.hubDegree)),
    0,
  );
  // crossDaoLinks: count of (actor, space) cells with hubDegree > 0 minus
  // the per-actor-first-space (so it counts "additional" presence).
  let crossDaoLinks = 0;
  for (const a of actorRows) {
    const hubsCount = a.spaces.filter((s) => s.hubDegree > 0).length;
    if (hubsCount > 1) crossDaoLinks += hubsCount - 1;
  }

  spin?.succeed(`Scanned ${spaces.length} space(s) × ${actors.length} actor(s) → ${actorsAcrossMultiple} cross-DAO actor(s)`);

  if (opts.wantJson) {
    console.log(
      JSON.stringify(
        {
          actors: actorRows,
          spaces: perSpace.map((s) => ({
            space: s.spaceId,
            proposalsAnalyzed: s.proposalsAnalyzed,
            votersConsidered: s.votersConsidered,
            pairsScored: s.pairsScored,
            error: s.error,
          })),
          summary: {
            actorsAcrossMultiple,
            maxHubDegree,
            crossDaoLinks,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  // Human-readable table: actors × spaces with hub-degree cells.
  console.log('');
  console.log(`Cross-DAO actor presence (hub-degree per space; "-" = not a hub):`);
  console.log('');
  const fmtAddr = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);
  const spaceCols = spaces;
  const header = ['Actor'.padEnd(28), ...spaceCols.map((s) => s.padEnd(18))].join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const a of actorRows) {
    const labelStr = a.label
      ? a.label.ens
        ? ` (${a.label.ens})`
        : a.label.isContract
          ? ' [CONTRACT]'
          : ''
      : '';
    const row = [(fmtAddr(a.address) + labelStr).padEnd(28)];
    for (const cell of a.spaces) {
      if (cell.error) row.push('ERR'.padEnd(18));
      else if (cell.hubDegree === 0) row.push('-'.padEnd(18));
      else
        row.push(
          `${cell.hubDegree}${cell.perfectCosinePairs > 0 ? `(${cell.perfectCosinePairs}@1.0)` : ''}`.padEnd(18),
        );
    }
    console.log(row.join(''));
  }
  console.log('');
  console.log(`Summary: ${actorsAcrossMultiple} actor(s) present in ≥2 spaces; max hub-degree ${maxHubDegree}; ${crossDaoLinks} cross-DAO link(s).`);
  console.log('Interpretation:');
  console.log('  Cell = hub-degree (count of high-cos spokes for this actor in this space).');
  console.log('  N(K@1.0) = K of N spokes are perfect-cosine matches (1.0).');
  console.log('  Actor present in ≥2 spaces with hub-degree > 0 = cross-DAO coordination signal.');
}

export const allocationDistanceHandler = {
  builder: (yargs: Argv) => yargs
    .option('space', {
      type: 'string',
      array: true,
      demandOption: true,
      describe: 'Snapshot space ID (e.g. fraxfinance.eth). Pass multiple times for multi-space scan with --actors-graph (HB#637 vigil HB#738/#739 kappa-H finding).',
    })
    .option('limit', { type: 'number', default: 30, describe: 'Max recent proposals to analyze' })
    .option('top-n', { type: 'number', default: 10, describe: 'Top-N pairs to surface in human output' })
    .option('min-vp', { type: 'number', default: 1, describe: 'Minimum vp threshold for voters considered' })
    .option('proposal-type', { type: 'string', describe: 'Filter to a specific Snapshot proposal type (weighted/quadratic/approval). Default: all multi-option types.' })
    .option('hub-detection', { type: 'boolean', default: false, describe: 'Surface hub-and-spoke coordination patterns (voters appearing in 2+ high-cos pairs). Strongest signal on gauge-allocation DAOs.' })
    .option('hub-min-degree', { type: 'number', default: 2, describe: 'Minimum number of cos-similar spokes for a voter to qualify as a hub (default 2)' })
    .option('hub-min-cos', { type: 'number', default: 0.99, describe: 'Minimum avg cosine for a pair to count toward hub-degree (default 0.99)' })
    .option('hub-scan-top-n', { type: 'number', default: 200, describe: 'Number of top pairs to scan when computing hub-degrees (default 200; larger catches looser hubs)' })
    .option('label-actors', { type: 'boolean', default: false, describe: 'Resolve ENS + isContract for each hub address. Surfaces protocol-level coordinators (e.g. Karpatkey) vs individual delegates.' })
    .option('rpc', { type: 'string', default: 'https://ethereum.publicnode.com', describe: 'Ethereum mainnet RPC for ENS + isContract lookups (only used with --label-actors)' })
    .option('json', { type: 'boolean', default: false, describe: 'Machine-readable JSON output' })
    .option('actors-graph', {
      type: 'string',
      describe:
        'HB#637 task #524 (vigil HB#738/#739 kappa-H finding): comma-separated actor addresses to track across multiple --space flags. Outputs a structured cross-DAO graph: which addresses appear as hubs in which spaces + their hub-degree per space.',
    })
    .option('max-spaces', {
      type: 'number',
      default: 10,
      describe: 'Cap on number of --space flags processed in --actors-graph mode (default 10). Prevents runaway scans on a long --space list.',
    }),

  handler: async (argv: ArgumentsCamelCase<AllocationDistanceArgs>) => {
    // --space is now `array: true` so yargs gives us string[]. Normalize.
    const spacesRaw = argv.space as string | string[];
    const spaces = Array.isArray(spacesRaw) ? spacesRaw : [spacesRaw];
    const spaceId = spaces[0];
    const limit = Number(argv.limit) || 30;
    const topN = Number(argv.topN ?? (argv as any)['top-n']) || 10;
    const minVp = Number(argv.minVp ?? (argv as any)['min-vp']) || 1;
    const typeFilter = (argv.proposalType ?? (argv as any)['proposal-type']) as string | undefined;
    const wantHubs = Boolean(argv.hubDetection ?? (argv as any)['hub-detection']);
    const hubMinDegree = Number(argv.hubMinDegree ?? (argv as any)['hub-min-degree']) || 2;
    const hubMinCos = Number(argv.hubMinCos ?? (argv as any)['hub-min-cos']) || 0.99;
    const hubScanTopN = Number(argv.hubScanTopN ?? (argv as any)['hub-scan-top-n']) || 200;
    const wantLabels = Boolean(argv.labelActors ?? (argv as any)['label-actors']);
    const rpcUrl = (argv.rpc as string) || 'https://ethereum.publicnode.com';
    const wantJson = Boolean(argv.json);
    const actorsGraphRaw = (argv.actorsGraph ?? (argv as any)['actors-graph']) as string | undefined;
    const maxSpaces = Number(argv.maxSpaces ?? (argv as any)['max-spaces']) || 10;

    // HB#637 task #524: --actors-graph branch. Loop over --space inputs,
    // compute hubs per space, project the requested actor list as a cross-DAO
    // matrix. Reuses the existing single-space analysis via runOneSpace().
    if (actorsGraphRaw) {
      await runActorsGraph({
        actorsCsv: actorsGraphRaw,
        spaces,
        maxSpaces,
        limit,
        minVp,
        typeFilter,
        hubMinDegree,
        hubMinCos,
        hubScanTopN,
        wantLabels,
        rpcUrl,
        wantJson,
      });
      return;
    }

    const spin = wantJson ? null : output.spinner(`Fetching multi-option proposals for ${spaceId}...`);
    spin?.start();

    try {
      // Step 1: fetch recent proposals + their type/choices
      const proposalData = await snapshotGraphQL<any>(
        `query($space: String!, $first: Int!) {
          proposals(where: {space: $space}, first: $first, orderBy: "created", orderDirection: desc) {
            id title type choices
          }
        }`,
        { space: spaceId, first: limit },
        { endpoint: SNAPSHOT_API },
      );

      const eligible: ProposalInfo[] = (proposalData.proposals || [])
        .filter((p: any) => {
          if (!p || !p.type) return false;
          if (typeFilter) return p.type === typeFilter;
          return p.type === 'weighted' || p.type === 'quadratic' || p.type === 'approval';
        })
        .map((p: any) => ({ id: p.id, title: p.title, type: p.type, choicesCount: (p.choices || []).length }));

      if (eligible.length === 0) {
        const msg = `No multi-option proposals found for "${spaceId}"${typeFilter ? ` (type=${typeFilter})` : ''}`;
        if (wantJson) {
          console.log(JSON.stringify({ space: spaceId, proposals: 0, pairs: [], reason: msg }, null, 2));
        } else {
          spin?.fail(msg);
        }
        return;
      }

      spin && (spin.text = `Fetching votes for ${eligible.length} multi-option proposals...`);

      // Step 2: fetch ALL votes for those proposals (Snapshot caps at 1000 per page)
      const proposalIds = eligible.map((p) => p.id);
      const voteData = await snapshotGraphQL<any>(
        `query($proposals: [String!]!) {
          votes(where: {proposal_in: $proposals}, first: 1000, orderBy: "vp", orderDirection: desc) {
            voter vp choice proposal { id }
          }
        }`,
        { proposals: proposalIds },
        { endpoint: SNAPSHOT_API },
      );

      const allVotes: Vote[] = (voteData.votes || [])
        .filter((v: any) => (v.vp || 0) >= minVp)
        .map((v: any) => ({
          voter: v.voter,
          vp: v.vp,
          proposalId: v.proposal?.id || '',
          choice: v.choice,
        }));

      spin && (spin.text = 'Computing pairwise allocation distance...');

      // Step 3: for each proposal, compute pairwise cosine + jaccard + deep-equal
      // Aggregate per pair across all eligible proposals
      const pairStats = new Map<
        string,
        { coSum: number; jaSum: number; n: number; deepEq: number; vpSum: number }
      >();

      for (const prop of eligible) {
        const propVotes = allVotes.filter((v) => v.proposalId === prop.id);
        if (propVotes.length < 2) continue;
        // Build vectors + canonical-JSON-choice once per voter on this proposal.
        // canonChoice: deterministic JSON string of the raw `choice` field; pair
        // matches deep-equal only when canonChoice strings are identical.
        const vectors = propVotes
          .map((v) => ({
            voter: v.voter,
            vp: v.vp,
            vec: toAllocationVector(v.choice, prop.choicesCount),
            canonChoice: canonicalJSON(v.choice),
          }))
          .filter((x) => x.vec !== null) as Array<{
            voter: string;
            vp: number;
            vec: number[];
            canonChoice: string;
          }>;

        for (let i = 0; i < vectors.length; i++) {
          for (let j = i + 1; j < vectors.length; j++) {
            const a = vectors[i];
            const b = vectors[j];
            const c = cosineSimilarity(a.vec, b.vec);
            const ja = jaccardSimilarity(a.vec, b.vec);
            const deepEq = a.canonChoice === b.canonChoice ? 1 : 0;
            const key = a.voter < b.voter ? `${a.voter}__${b.voter}` : `${b.voter}__${a.voter}`;
            const cur = pairStats.get(key) || { coSum: 0, jaSum: 0, n: 0, deepEq: 0, vpSum: 0 };
            cur.coSum += c;
            cur.jaSum += ja;
            cur.deepEq += deepEq;
            cur.n += 1;
            cur.vpSum += a.vp + b.vp;
            pairStats.set(key, cur);
          }
        }
      }

      // Step 4: rank pairs by avg cosine (with shared-count threshold)
      const ranked: PairScore[] = Array.from(pairStats.entries())
        .filter(([, s]) => s.n >= 2) // must share ≥2 proposals to count
        .map(([key, s]) => {
          const [voterA, voterB] = key.split('__');
          return {
            voterA,
            voterB,
            proposalsShared: s.n,
            avgCosine: s.coSum / s.n,
            avgJaccard: s.jaSum / s.n,
            deepEqualCount: s.deepEq,
            combinedVp: s.vpSum,
          };
        })
        .sort((a, b) => b.avgCosine - a.avgCosine);

      const top = ranked.slice(0, topN);

      // Hub detection: aggregate voter appearances across high-cos pairs (scan top-N).
      const hubs: HubVoter[] = wantHubs ? computeHubs(ranked, hubScanTopN, hubMinCos, hubMinDegree) : [];

      // Optional: ENS + isContract labeling per hub address.
      if (wantLabels && hubs.length > 0) {
        spin && (spin.text = `Labeling ${hubs.length} hub actors via ENS + isContract...`);
        try {
          const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl);
          await labelHubs(hubs, provider);
        } catch (e) {
          if (!wantJson) {
            console.warn(`\n[label-actors] failed: ${(e as Error).message}. Continuing without labels.`);
          }
        }
      }

      if (wantJson) {
        console.log(JSON.stringify({
          space: spaceId,
          proposalsAnalyzed: eligible.length,
          proposalTypes: Array.from(new Set(eligible.map((p) => p.type))),
          votersConsidered: new Set(allVotes.map((v) => v.voter)).size,
          pairsScored: pairStats.size,
          pairsAboveMinShared: ranked.length,
          top,
          hubs: wantHubs ? hubs : undefined,
          hubConfig: wantHubs
            ? { minDegree: hubMinDegree, minCos: hubMinCos, scanTopN: hubScanTopN, labeled: wantLabels }
            : undefined,
        }, null, 2));
      } else {
        spin?.succeed(`Analyzed ${eligible.length} multi-option proposals; ${ranked.length} qualifying pairs`);
        if (ranked.length === 0) {
          console.log('\nNo voter pairs shared ≥2 multi-option proposals. Try --limit higher.\n');
          return;
        }
        console.log('');
        console.log(`Top ${Math.min(topN, ranked.length)} voter pairs by avg cosine similarity on allocation:`);
        console.log('');
        const fmtAddr = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);
        for (const p of top) {
          console.log(
            `  cos=${p.avgCosine.toFixed(3)}  jac=${p.avgJaccard.toFixed(3)}  deepEq=${p.deepEqualCount}/${p.proposalsShared}  ` +
              `n=${p.proposalsShared}  vp=${Math.round(p.combinedVp)}  ` +
              `${fmtAddr(p.voterA)} ↔ ${fmtAddr(p.voterB)}`
          );
        }
        console.log('');
        console.log('Interpretation:');
        console.log('  cos ≥ 0.95 over n ≥ 3 proposals : strong allocation lockstep — investigate coordination');
        console.log('  cos 0.7-0.95                    : moderate alignment — could be common ideology, not coordination');
        console.log('  jac high + cos lower            : same options funded but with different weights');
        console.log('  cos ≈ 0 + n high                : orthogonal allocations (no shared preference)');
        console.log('  deepEq ≈ shared (ratio ≥ 0.9)   : single-entity coordination (one wallet or one signer)');
        console.log('  deepEq much < shared, cos high  : strategy-following (independent voters tracking shared guidance)');
        console.log('');
        console.log(`Closes HB#680 Frax negative finding gap: gauge-allocation DAOs need allocation-vector distance, not just binary co-voting.`);

        if (wantHubs) {
          console.log('');
          if (hubs.length === 0) {
            console.log(`Hub-detection (min-degree ${hubMinDegree}, min-cos ${hubMinCos}): no hubs found.`);
          } else {
            const fmtAddr = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);
            console.log(`Hub-detection (min-degree ${hubMinDegree}, min-cos ${hubMinCos}, scan top ${hubScanTopN} pairs):`);
            console.log('');
            for (const h of hubs) {
              const lbl = h.label
                ? `  [${h.label.isContract ? `CONTRACT/${h.label.codeBytes}B` : 'EOA'}${h.label.ens ? `, ENS: ${h.label.ens}` : ''}]`
                : '';
              console.log(`  ${fmtAddr(h.voter)}  hub-degree=${h.hubDegree}${lbl}`);
              for (const s of h.spokes.slice(0, 5)) {
                console.log(`    ↔ ${fmtAddr(s.voter)}  cos=${s.avgCosine.toFixed(3)}  n=${s.proposalsShared}`);
              }
              if (h.spokes.length > 5) {
                console.log(`    ... ${h.spokes.length - 5} more spokes`);
              }
            }
            console.log('');
            console.log('Hub-degree interpretation:');
            console.log('  degree ≥ 5  : strong coordination operator (likely bribery client / strategy vault)');
            console.log('  degree 2-4  : possible smaller coordination cell or natural-alignment cluster');
            console.log('  degree 1    : independent pair (not a hub); see top-N pairs output above');
          }
        }
      }
    } catch (err) {
      spin?.fail((err as Error).message);
      if (wantJson) {
        console.log(JSON.stringify({ error: (err as Error).message }, null, 2));
      }
      throw err;
    }
  },
};
