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
  space: string;
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

export const allocationDistanceHandler = {
  builder: (yargs: Argv) => yargs
    .option('space', { type: 'string', demandOption: true, describe: 'Snapshot space ID (e.g. fraxfinance.eth)' })
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
    .option('json', { type: 'boolean', default: false, describe: 'Machine-readable JSON output' }),

  handler: async (argv: ArgumentsCamelCase<AllocationDistanceArgs>) => {
    const spaceId = argv.space as string;
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

      // Step 3: for each proposal, compute pairwise cosine + jaccard
      // Aggregate per pair across all eligible proposals
      const pairStats = new Map<string, { coSum: number; jaSum: number; n: number; vpSum: number }>();

      for (const prop of eligible) {
        const propVotes = allVotes.filter((v) => v.proposalId === prop.id);
        if (propVotes.length < 2) continue;
        // Build vectors once per voter on this proposal
        const vectors = propVotes
          .map((v) => ({ voter: v.voter, vp: v.vp, vec: toAllocationVector(v.choice, prop.choicesCount) }))
          .filter((x) => x.vec !== null) as Array<{ voter: string; vp: number; vec: number[] }>;

        for (let i = 0; i < vectors.length; i++) {
          for (let j = i + 1; j < vectors.length; j++) {
            const a = vectors[i];
            const b = vectors[j];
            const c = cosineSimilarity(a.vec, b.vec);
            const ja = jaccardSimilarity(a.vec, b.vec);
            const key = a.voter < b.voter ? `${a.voter}__${b.voter}` : `${b.voter}__${a.voter}`;
            const cur = pairStats.get(key) || { coSum: 0, jaSum: 0, n: 0, vpSum: 0 };
            cur.coSum += c;
            cur.jaSum += ja;
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
            `  cos=${p.avgCosine.toFixed(3)}  jac=${p.avgJaccard.toFixed(3)}  ` +
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
