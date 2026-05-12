#!/usr/bin/env node
/**
 * E-direct lockstep analyzer — measures top-N voter coordination
 * on binary-choice proposals for a Snapshot space.
 *
 * Produces two metrics per v2.0.x tier diagnostic (sentinel HB#694):
 *   - all-agree rate: proposals where ALL top-N voted identically
 *   - pairwise-with-top-1 rate: per each top-k (k>=2), agreement with top-1
 *
 * Tier classification:
 *   - STRONG: all-agree ≥ 0.70
 *   - PAIRWISE-ONLY: majority pairwise ≥ 0.70 but all-agree < 0.70
 *   - None: majority pairwise < 0.70
 *
 * Usage:
 *   node agent/scripts/lockstep-analyzer.js <space.eth> [topN=5]
 */

const https = require('https');

const SNAPSHOT_URL = 'https://hub.snapshot.org/graphql';

// HB#792 Task #540: on-chain Governor data source (alternative to Snapshot).
// RPC endpoints by chain id — public/permissionless; override via
// LOCKSTEP_RPC_<chainId> env vars for higher rate limits (e.g.,
// LOCKSTEP_RPC_1=https://your-alchemy-key.infura.io).
const DEFAULT_RPC = {
  1: 'https://cloudflare-eth.com',        // Ethereum mainnet (Compound, ENS, Uniswap, AAVE, Maker)
  10: 'https://mainnet.optimism.io',      // Optimism (Velodrome, Optimism Citizens')
  137: 'https://polygon-rpc.com',         // Polygon
  8453: 'https://mainnet.base.org',       // Base (Aerodrome)
  42161: 'https://arb1.arbitrum.io/rpc',  // Arbitrum
  100: 'https://rpc.gnosischain.com',     // Gnosis (POP itself)
};
// Note: public endpoints rate-limit aggressively; for any serious analysis
// pass LOCKSTEP_RPC_<chainId> env var pointing at your own Alchemy/Infura/QuickNode key.

// Standard Governor ABI fragment — covers both GovernorBravo (Compound-derived)
// and OpenZeppelin Governor. Both emit identical ProposalCreated + VoteCast
// signatures; getReceipt is Bravo-only, so we read votes purely from event scan.
const GOVERNOR_ABI = [
  'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)',
  'event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason)',
];

// Governor support enum → lockstep choice index (1-indexed):
// support 0 = Against → choice 2 ; support 1 = For → choice 1 ; support 2 = Abstain → choice 3.
// This makes Governor results compatible with Snapshot's For-first convention
// (choices = ['For', 'Against', 'Abstain']) and lets the existing analysis core
// run unchanged. Abstain (3) is filtered downstream via abstainChoice mechanism.
const GOVERNOR_SUPPORT_TO_CHOICE = [2, 1, 3];

function getRpcUrl(chainId) {
  const override = process.env[`LOCKSTEP_RPC_${chainId}`];
  return override || DEFAULT_RPC[chainId];
}

// HB#567 Task #499: cosine-similarity helper for WEIGHTED pattern-mode.
// Snapshot weighted votes have choice as `{choice_idx: weight}` object
// (e.g. {"1": 50, "2": 50} for split 50/50 across choices 1 and 2).
// Two voters AGREE if either: (a) cosine_similarity > 0.7 across normalized
// weight vectors, OR (b) argmax of weights matches (same dominant choice).
function cosineSimilarity(weightsA, weightsB) {
  if (!weightsA || !weightsB || typeof weightsA !== 'object' || typeof weightsB !== 'object') return 0;
  const keys = new Set([...Object.keys(weightsA), ...Object.keys(weightsB)]);
  let dot = 0, magA = 0, magB = 0;
  for (const k of keys) {
    const a = Number(weightsA[k] || 0);
    const b = Number(weightsB[k] || 0);
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function argmaxKey(weights) {
  if (!weights || typeof weights !== 'object') return null;
  let bestKey = null, bestVal = -Infinity;
  for (const k of Object.keys(weights)) {
    const v = Number(weights[k] || 0);
    if (v > bestVal) { bestVal = v; bestKey = k; }
  }
  return bestKey;
}

// HB#553: Kendall-tau distance for RANKED-CHOICE mode (Task #497 + #499 follow-on).
// Snapshot ranked-choice ballots: choice is an array of 1-indexed candidate positions
// in preference order, e.g. [3,1,2] means candidate 3 first-preference, 1 second, 2 third.
// Normalized Kendall tau distance ∈ [0, 1]: 0 = identical ranking, 1 = reversed.
// For agreement threshold (consistent with weighted mode's cosine>0.7): tau ≤ 0.3.
// Only compare candidates ranked by BOTH voters (intersection). If intersection <2
// pairs, fall back to first-preference equality.
function kendallTauDistance(rankingA, rankingB) {
  if (!Array.isArray(rankingA) || !Array.isArray(rankingB)) return 1;
  const setA = new Set(rankingA);
  const setB = new Set(rankingB);
  const common = [...setA].filter(c => setB.has(c));
  if (common.length < 2) return 1;
  const idxA = new Map(rankingA.map((c, i) => [c, i]));
  const idxB = new Map(rankingB.map((c, i) => [c, i]));
  let discordant = 0, totalPairs = 0;
  for (let i = 0; i < common.length; i++) {
    for (let j = i + 1; j < common.length; j++) {
      totalPairs++;
      const a1 = idxA.get(common[i]);
      const a2 = idxA.get(common[j]);
      const b1 = idxB.get(common[i]);
      const b2 = idxB.get(common[j]);
      // Discordant if orders disagree: (a1<a2 && b1>b2) OR (a1>a2 && b1<b2)
      if ((a1 < a2 && b1 > b2) || (a1 > a2 && b1 < b2)) discordant++;
    }
  }
  return totalPairs === 0 ? 1 : discordant / totalPairs;
}

function firstPreference(ranking) {
  if (!Array.isArray(ranking) || ranking.length === 0) return null;
  return ranking[0];
}

// Pairwise-agree across pattern modes:
// - binary/categorical: integer choice equality
// - weighted: cosine_similarity > 0.7 OR same argmax (dominant choice match)
// - ranked (HB#553): normalized Kendall-tau ≤ 0.3 OR same first-preference
function agreeOn(choiceA, choiceB, patternMode) {
  if (choiceA === undefined || choiceB === undefined) return false;
  if (patternMode === 'weighted') {
    if (typeof choiceA !== 'object' || typeof choiceB !== 'object') {
      // Edge: if a vote in a 'weighted' proposal has integer choice (single-pref shorthand), treat as exact match
      return choiceA === choiceB;
    }
    if (cosineSimilarity(choiceA, choiceB) > 0.7) return true;
    return argmaxKey(choiceA) === argmaxKey(choiceB);
  }
  if (patternMode === 'ranked') {
    if (!Array.isArray(choiceA) || !Array.isArray(choiceB)) {
      // Edge: integer choice in ranked proposal (single-pref shorthand) → treat as exact match
      return choiceA === choiceB;
    }
    if (kendallTauDistance(choiceA, choiceB) <= 0.3) return true;
    return firstPreference(choiceA) === firstPreference(choiceB);
  }
  return choiceA === choiceB;
}

function gql(query, variables = {}) {
  // HB#531: surface Snapshot rate-limit + GraphQL error responses with
  // a clear message instead of silently resolving to undefined (which
  // then crashes downstream `d.proposals` access). Snapshot rate-limit
  // body is `{"error":"unauthorized","error_description":"too many requests..."}`;
  // GraphQL errors return `{errors:[{message:...}]}`.
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(
      SNAPSHOT_URL,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(out); }
          catch (e) { return reject(new Error(`Snapshot non-JSON response: ${out.slice(0, 200)}`)); }
          if (parsed && parsed.error) {
            return reject(new Error(`Snapshot ${parsed.error}: ${parsed.error_description || ''}`));
          }
          if (parsed && Array.isArray(parsed.errors) && parsed.errors.length) {
            return reject(new Error(`Snapshot GraphQL error: ${parsed.errors[0].message || JSON.stringify(parsed.errors[0])}`));
          }
          if (!parsed || parsed.data === undefined) {
            return reject(new Error(`Snapshot empty response: ${out.slice(0, 200)}`));
          }
          resolve(parsed.data);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// HB#531 Task #497 MVP (vigil): --pattern-mode flag supports CATEGORICAL >3-choice
// lockstep analysis. Categorical agreement = exact choice-index match (same logic as
// binary, just relaxes the length filter). WEIGHTED + RANKED modes deferred as
// follow-on (need cosine-similarity + Kendall-tau helpers + object/array vote.choice
// parsing).
async function fetchProposals(space, first = 1000, includeMultiChoice = false, patternMode = 'binary') {
  // Fetch closed proposals. By default restricted to choices.length === 2 (binary).
  // HB#507 multi-choice extension: if includeMultiChoice, also accept 3-choice
  // For/Against/Abstain proposals (treat Abstain as non-vote in lockstep analysis).
  // Per HB#505 Sprint 21 strategy pivot direction (b): unblocks Aave-class multi-choice
  // DAOs (cow.eth, makerdao, snapshot.eth, etc.) for Pattern ι classification.
  //
  // HB#530: also annotate gauge-allocation proposals (>3 choices, type='weighted'
  // or 'ranked-choice') as a separate stat so the caller knows when --multi-choice
  // is insufficient. Sprint 21 candidate: gauge-allocation lockstep variant
  // (Aerodrome/Velodrome/Pendle/Beethoven require lockstep over WEIGHT DISTRIBUTIONS,
  // not single choices). Currently emits a one-line stat for visibility.
  const q = `query($space: String!, $first: Int!) {
    proposals(first: $first, where: { space: $space, state: "closed" }, orderBy: "created", orderDirection: desc) {
      id type choices scores_total
    }
  }`;
  const d = await gql(q, { space, first });
  const all = d.proposals || [];
  // HB#530: count gauge-allocation candidates for stderr stat (visibility for
  // Sprint 21 gauge-allocation lockstep candidate)
  const gaugeAllocationCount = all.filter(p => {
    if (!p.choices) return false;
    if (p.choices.length <= 3) return false;
    return p.type === 'weighted' || p.type === 'ranked-choice' || p.type === 'quadratic';
  }).length;
  if (gaugeAllocationCount > 0) {
    console.warn(`  [lockstep] ${gaugeAllocationCount} gauge-allocation proposals (>3 choices, type=weighted/ranked-choice/quadratic) skipped — Sprint 21 candidate to handle weight-distribution lockstep`);
  }
  return all.filter(p => {
    if (!p.choices) return false;
    if (p.choices.length === 2) return true;
    if (includeMultiChoice && p.choices.length === 3) {
      // For/Against/Abstain pattern detection (case-insensitive third choice)
      return /abstain/i.test(p.choices[2]);
    }
    // HB#531 Task #497 MVP: CATEGORICAL mode accepts any single-choice >3 voting
    // (budget allocation / multi-candidate elections). Vote.choice is an integer
    // (1-indexed choice); agreement = exact match. Same pairwise-agreement logic
    // as binary; just relaxes the length filter.
    if (patternMode === 'categorical' && p.choices.length > 3) {
      // Accept single-choice types only (weighted/ranked-choice/quadratic are
      // deferred to follow-on implementation that needs cosine/Kendall-tau helpers)
      if (p.type && p.type !== 'single-choice' && p.type !== 'basic') return false;
      return true;
    }
    // HB#567 Task #499 follow-on: WEIGHTED mode accepts gauge-allocation proposals
    // (type='weighted'); vote.choice is an object {choice_idx: weight}; pairwise
    // agreement = cosine_similarity(weights_a, weights_b) > 0.7 OR argmax(a) === argmax(b).
    if (patternMode === 'weighted') {
      // Accept any choices count (typically >2); only weighted type
      if (p.type !== 'weighted') return false;
      return true;
    }
    // HB#553 Task #497/#499 follow-on: RANKED mode accepts ranked-choice proposals
    // (type='ranked-choice'); vote.choice is an array of 1-indexed candidate positions;
    // pairwise agreement = normalized Kendall-tau ≤ 0.3 OR first-preference match.
    if (patternMode === 'ranked') {
      if (p.type !== 'ranked-choice') return false;
      return true;
    }
    return false;
  }).map(p => {
    // Annotate proposals with abstain-choice index for downstream filtering
    if (p.choices.length === 3 && /abstain/i.test(p.choices[2])) {
      return { ...p, abstainChoice: 3 };
    }
    return p;
  });
}

// HB#792 Task #540: on-chain Governor adapter. Scans ProposalCreated +
// VoteCast events from the Governor contract via ethers v5 + a chain-specific
// RPC endpoint. Returns data shapes compatible with the Snapshot fetchers so
// the existing analysis core runs unchanged.
//
// LIMITATIONS (HB#792 MVP):
// - Event-scan window defaults to last 2M blocks (~9mo mainnet, ~1mo on L2s);
//   override via --scan-window flag in follow-on if needed for older Governors.
// - Auto top-N voter selection NOT implemented in governor mode; users must
//   pass --voters explicitly. HB#793 will add VoteCast-weight aggregation.
// - Reads weight as uint256 from event (works for both Bravo uint96 and OZ
//   uint256 emissions since uint96 fits in uint256).
async function fetchProposalsFromGovernor(governorAddr, chainId, first = 1000) {
  const { ethers } = require('ethers');
  const rpcUrl = getRpcUrl(chainId);
  if (!rpcUrl) {
    throw new Error(`No RPC URL for chain ${chainId}. Set LOCKSTEP_RPC_${chainId} env var or extend DEFAULT_RPC map.`);
  }
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, { name: `chain-${chainId}`, chainId });
  const governor = new ethers.Contract(governorAddr, GOVERNOR_ABI, provider);
  const currentBlock = await provider.getBlockNumber();
  const SCAN_WINDOW = Number(process.env.LOCKSTEP_SCAN_WINDOW) || 2_000_000;
  const fromBlock = Math.max(0, currentBlock - SCAN_WINDOW);
  const CHUNK = Number(process.env.LOCKSTEP_RPC_CHUNK) || 50_000;
  console.error(`  [lockstep] scanning ProposalCreated events: blocks ${fromBlock}..${currentBlock} (${CHUNK}-block chunks)`);
  const events = [];
  for (let b = fromBlock; b <= currentBlock; b += CHUNK) {
    const toB = Math.min(b + CHUNK - 1, currentBlock);
    try {
      const chunkEvents = await governor.queryFilter(governor.filters.ProposalCreated(), b, toB);
      if (chunkEvents.length > 0) {
        events.push(...chunkEvents);
      }
    } catch (err) {
      console.error(`  [lockstep] RPC error at blocks ${b}..${toB}: ${err.message} — try smaller LOCKSTEP_RPC_CHUNK`);
      throw err;
    }
  }
  console.error(`  [lockstep] found ${events.length} ProposalCreated events`);
  const proposals = [];
  for (const e of events.slice(-first)) {
    const propId = e.args.proposalId.toString();
    const endBlock = e.args.endBlock.toNumber();
    if (endBlock >= currentBlock) continue; // not closed yet
    proposals.push({
      id: propId,
      type: 'basic',
      choices: ['For', 'Against', 'Abstain'],
      scores_total: 0,
      abstainChoice: 3,
      _endBlock: endBlock,
      _startBlock: e.args.startBlock.toNumber(),
    });
  }
  console.error(`  [lockstep] ${proposals.length} closed proposals (filtered from ${events.length} total)`);
  return proposals;
}

async function fetchVotesFromGovernor(governorAddr, chainId, proposals, voterAddrs) {
  // proposals is the array returned by fetchProposalsFromGovernor (with _startBlock/_endBlock).
  // voterAddrs is a list of lowercased addresses to filter to.
  const { ethers } = require('ethers');
  const rpcUrl = getRpcUrl(chainId);
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, { name: `chain-${chainId}`, chainId });
  const governor = new ethers.Contract(governorAddr, GOVERNOR_ABI, provider);
  const voterSet = new Set(voterAddrs.map(a => a.toLowerCase()));
  // Compute global VoteCast scan window across all proposals: min(_startBlock) to max(_endBlock).
  if (proposals.length === 0) return [];
  let minBlock = proposals[0]._startBlock, maxBlock = proposals[0]._endBlock;
  for (const p of proposals) {
    if (p._startBlock < minBlock) minBlock = p._startBlock;
    if (p._endBlock > maxBlock) maxBlock = p._endBlock;
  }
  const CHUNK = Number(process.env.LOCKSTEP_RPC_CHUNK) || 50_000;
  console.error(`  [lockstep] scanning VoteCast events: blocks ${minBlock}..${maxBlock} for ${voterSet.size} voters`);
  const allVoteCast = [];
  for (let b = minBlock; b <= maxBlock; b += CHUNK) {
    const toB = Math.min(b + CHUNK - 1, maxBlock);
    try {
      const chunk = await governor.queryFilter(governor.filters.VoteCast(), b, toB);
      allVoteCast.push(...chunk);
    } catch (err) {
      console.error(`  [lockstep] RPC error at blocks ${b}..${toB}: ${err.message}`);
      throw err;
    }
  }
  console.error(`  [lockstep] found ${allVoteCast.length} total VoteCast events`);
  const propIds = new Set(proposals.map(p => p.id));
  const votes = [];
  for (const e of allVoteCast) {
    const voter = e.args.voter.toLowerCase();
    if (!voterSet.has(voter)) continue;
    const pid = e.args.proposalId.toString();
    if (!propIds.has(pid)) continue;
    const support = Number(e.args.support);
    const choice = GOVERNOR_SUPPORT_TO_CHOICE[support];
    if (!choice) continue; // unknown support enum
    votes.push({
      proposal: { id: pid },
      voter,
      choice,
      vp: Number(ethers.utils.formatUnits(e.args.weight, 18)), // Governor weight typically 18-decimal token
    });
  }
  console.error(`  [lockstep] ${votes.length} votes matched (filtered to ${voterSet.size} voters × ${proposals.length} proposals)`);
  return votes;
}

async function fetchVotes(proposalIds, voterAddrs) {
  // HB#543: batched fetch via Snapshot proposal_in filter. Previously
  // fired N sequential gql() calls (one per proposal); for high-volume
  // DAOs (sushigov 140 props × HB#538/#541/#543 attempts) this consistently
  // hit Snapshot 401 'too many requests' at fetchVotes phase. Batching
  // 50 proposals per call (5 voters per proposal × 50 = 250 max votes,
  // well under Snapshot's first:1000 limit) reduces 140 calls → 3 calls.
  const q = `query($pids: [String!]!, $voters: [String!]!) {
    votes(first: 1000, where: { proposal_in: $pids, voter_in: $voters }) {
      proposal { id }
      voter
      choice
      vp
    }
  }`;
  const all = [];
  const BATCH = 50;
  for (let i = 0; i < proposalIds.length; i += BATCH) {
    const pids = proposalIds.slice(i, i + BATCH);
    const d = await gql(q, { pids, voters: voterAddrs });
    if (d && d.votes) all.push(...d.votes);
  }
  return all;
}

// HB#566 Task #503: module-level diagnostic state. Tracks per-page vote counts
// from most recent fetchTopVoters call so JSON output can include it without
// changing the function signature. Reset at each fetchTopVoters entry.
let lastFetchPageCounts = [];

async function fetchTopVoters(space, topN, selection) {
  // v2.1 methodology (vigil HB#423): two top-voter selection methods:
  //   - 'cumulative-vp' (default): sum each voter's VP across all their votes in
  //     recent history (4K vote pages). Selects FREQUENT-moderate voters.
  //   - 'active-share': per-proposal VP share averaged across ALL proposals in
  //     recent history. Selects INFREQUENT-large-VP voters who dominate the few
  //     proposals they vote on.
  //
  // These can select DIFFERENT top-N at the same DAO. Sentinel's E-direct STRONG
  // findings (HB#682/684/690/696/698) use active-share selection; my default was
  // cumulative-vp. Both valid; caller should specify which.
  const q = `query($space: String!, $first: Int!, $skip: Int!) {
    votes(first: $first, skip: $skip, where: { space: $space }, orderBy: "vp", orderDirection: desc) {
      voter vp proposal { id }
    }
  }`;
  const byVoter = new Map(); // cumulative-VP accumulator
  const perProposalVoters = new Map(); // active-share: proposal -> sum of VP
  const perVoterPerProposal = new Map(); // active-share: `voter:proposal` -> vp
  // HB#566 Task #503: per-page assertion + retry. fetchTopVoters loop terminates
  // on votes.length===0 (true end) OR votes.length<1000 (assumed end). Snapshot
  // GraphQL can return transient short pages mid-stream that are NOT end-of-data;
  // if that happens between a 1000-vote page and eventual 1000-vote page, the
  // resulting 4K window is a partial-fetch that flips borderline classifications
  // across sessions (cvx.eth cross-agent divergence HB#619/#921/#623).
  // Fix: if page N returns <1000 AND previous page was exactly 1000, retry once
  // with same skip offset. Only terminate if the retry also returns <1000.
  const pageCounts = [];
  for (let page = 0; page < 4; page++) {
    let d = await gql(q, { space, first: 1000, skip: page * 1000 });
    let votes = (d && d.votes) || [];
    // Retry-on-mid-stream-short-page: prior page was full (1000) + this page is short.
    // Pure end-of-data looks like: prior=1000 + this=<1000 OR prior=<1000 + this=0.
    // Transient short looks like: prior=1000 + this=<1000 but genuine data exists past this skip.
    if (page > 0 && pageCounts[page - 1] === 1000 && votes.length < 1000 && votes.length > 0) {
      console.warn(`  [lockstep] fetchTopVoters page ${page} short (${votes.length} < 1000) after full prior page; retrying once (Task #503 robustness guard)`);
      const retry = await gql(q, { space, first: 1000, skip: page * 1000 });
      const retryVotes = (retry && retry.votes) || [];
      if (retryVotes.length > votes.length) {
        console.warn(`  [lockstep] retry returned ${retryVotes.length} votes (up from ${votes.length}) — transient short page confirmed, using retry data`);
        votes = retryVotes;
      }
    }
    pageCounts.push(votes.length);
    if (votes.length === 0) break;
    for (const v of votes) {
      const addr = v.voter.toLowerCase();
      const vp = Number(v.vp || 0);
      byVoter.set(addr, (byVoter.get(addr) || 0) + vp);
      const pid = v.proposal && v.proposal.id;
      if (pid) {
        perProposalVoters.set(pid, (perProposalVoters.get(pid) || 0) + vp);
        perVoterPerProposal.set(`${addr}:${pid}`, vp);
      }
    }
    if (votes.length < 1000) break;
  }
  // Stash page counts for JSON diagnostic output. Module-level state avoids
  // changing the fetchTopVoters return signature; caller reads via getLastFetchPageCounts().
  lastFetchPageCounts = pageCounts.slice();

  if (selection === 'active-share') {
    // Compute each voter's per-proposal share, average over proposals they voted on
    const avgShareByVoter = new Map();
    const countByVoter = new Map();
    for (const [key, vp] of perVoterPerProposal.entries()) {
      const [addr, pid] = key.split(':');
      const propTotal = perProposalVoters.get(pid) || 0;
      if (propTotal > 0) {
        const share = vp / propTotal;
        avgShareByVoter.set(addr, (avgShareByVoter.get(addr) || 0) + share);
        countByVoter.set(addr, (countByVoter.get(addr) || 0) + 1);
      }
    }
    const ranked = Array.from(avgShareByVoter.entries()).map(([addr, sumShare]) => {
      const n = countByVoter.get(addr) || 1;
      return { addr, avgShare: sumShare / n };
    });
    ranked.sort((a, b) => b.avgShare - a.avgShare);
    return ranked.slice(0, topN).map(r => ({ address: r.addr, avgShare: r.avgShare, cumulativeVP: byVoter.get(r.addr) || 0 }));
  }

  // Default: cumulative-vp
  const sorted = Array.from(byVoter.entries()).sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, topN).map(([addr, vp]) => ({ address: addr, cumulativeVP: vp }));
}

async function main() {
  // args: space [topN=5] [--voters addr1,addr2,...] [--selection cum-vp|active-share] [--multi-choice]
  // HB#791 Task #540: on-chain Governor mode via --governor-address + --governor-chain.
  // When governor flags present, `space` is ignored; data sourced from on-chain Governor
  // (Compound/OZ Bravo/standard) via VoteCast event scan + getReceipt() rather than Snapshot.
  const args = process.argv.slice(2);
  // HB#791: only treat args[0] as positional space if it isn't a flag (don't
  // consume `--governor-address` as the Snapshot space name).
  const space = (args[0] && !args[0].startsWith('--')) ? args[0] : null;
  const loopStart = space === null ? 0 : 1;
  let topN = 5;
  let explicitVoters = null;
  let selection = 'cum-vp';
  let includeMultiChoice = false;
  let patternMode = 'binary';
  let governorAddress = null;
  let governorChain = null;
  let tallyApiKey = process.env.TALLY_API_KEY || null;
  for (let i = loopStart; i < args.length; i++) {
    if (args[i] === '--voters' && args[i + 1]) {
      explicitVoters = args[i + 1].split(',').map(s => s.trim().toLowerCase());
      i++;
    } else if (args[i] === '--selection' && args[i + 1]) {
      selection = args[i + 1];
      i++;
    } else if (args[i] === '--multi-choice') {
      includeMultiChoice = true;
    } else if (args[i] === '--pattern-mode' && args[i + 1]) {
      patternMode = args[i + 1];
      i++;
    } else if (args[i] === '--governor-address' && args[i + 1]) {
      governorAddress = args[i + 1].toLowerCase();
      i++;
    } else if (args[i] === '--governor-chain' && args[i + 1]) {
      governorChain = Number(args[i + 1]);
      i++;
    } else if (args[i] === '--tally-api-key' && args[i + 1]) {
      tallyApiKey = args[i + 1];
      i++;
    } else if (/^\d+$/.test(args[i])) {
      topN = Number(args[i]);
    }
  }
  const governorMode = !!governorAddress;
  if (governorMode) {
    if (!/^0x[0-9a-f]{40}$/i.test(governorAddress)) {
      console.error(`--governor-address must be 0x-prefixed 40-hex; got: ${governorAddress}`);
      process.exit(1);
    }
    if (!governorChain || !Number.isFinite(governorChain)) {
      console.error('--governor-chain <chain-id> required when --governor-address is set');
      process.exit(1);
    }
    if (!explicitVoters) {
      console.error('--voters required in governor mode (HB#792 MVP); auto top-N selection lands HB#793. Pass --voters 0xaddr1,0xaddr2,...');
      process.exit(1);
    }
    if (!getRpcUrl(governorChain)) {
      console.error(`No RPC URL for chain ${governorChain}. Set LOCKSTEP_RPC_${governorChain} env var or add to DEFAULT_RPC map.`);
      process.exit(1);
    }
  }
  if (!governorMode && !space) {
    console.error('Usage: node lockstep-analyzer.js <space.eth> [topN=5] [--voters addr1,...] [--selection cum-vp|active-share] [--multi-choice] [--pattern-mode binary|categorical|weighted|ranked]');
    console.error('       OR on-chain Governor: node lockstep-analyzer.js --governor-address <0x...> --governor-chain <id> --voters addr1,addr2,... [--tally-api-key <key>]');
    process.exit(1);
  }
  if (!['cum-vp', 'active-share'].includes(selection)) { console.error('--selection must be cum-vp or active-share'); process.exit(1); }
  if (!['binary', 'categorical', 'weighted', 'ranked'].includes(patternMode)) {
    // HB#531 Task #497 MVP: binary + categorical. HB#567 Task #499: weighted. HB#553: ranked (Kendall-tau).
    console.error(`--pattern-mode must be binary | categorical | weighted | ranked; got: ${patternMode}`);
    process.exit(1);
  }

  const dataSource = governorMode
    ? `Governor ${governorAddress} on chain ${governorChain}`
    : space;
  const selectionLabel = explicitVoters ? 'explicit voters' : `auto-selected by ${selection}`;
  console.log(`\nLockstep analysis: ${dataSource} (top-${topN}, ${selectionLabel})\n`);

  let topVoters;
  if (explicitVoters) {
    topVoters = explicitVoters.map(a => ({ address: a, cumulativeVP: null }));
    topN = topVoters.length;
    console.log('Explicit voters (from --voters arg):');
    topVoters.forEach((v, i) => console.log(`  ${i + 1}. ${v.address}`));
  } else {
    topVoters = await fetchTopVoters(space, topN, selection);
    console.log(`Top voters by ${selection} (from last 4K votes):`);
    topVoters.forEach((v, i) => {
      const extra = v.avgShare !== undefined
        ? `avg-share=${(v.avgShare * 100).toFixed(2)}%`
        : `cum-VP=${(v.cumulativeVP || 0).toLocaleString()}`;
      console.log(`  ${i + 1}. ${v.address}  ${extra}`);
    });
  }

  const binaryProposals = governorMode
    ? await fetchProposalsFromGovernor(governorAddress, governorChain, 1000)
    : await fetchProposals(space, 1000, includeMultiChoice, patternMode);
  const multiChoiceCount = binaryProposals.filter(p => p.abstainChoice).length;
  const categoricalCount = patternMode === 'categorical' ? binaryProposals.filter(p => p.choices && p.choices.length > 3).length : 0;
  const propLabel = patternMode === 'categorical' ? 'Classifiable proposals (binary + categorical)' : 'Binary proposals';
  console.log(`\n${propLabel} found: ${binaryProposals.length}${includeMultiChoice && multiChoiceCount > 0 ? ` (${binaryProposals.length - multiChoiceCount - categoricalCount} pure-binary + ${multiChoiceCount} 3-choice w/ Abstain ignored${categoricalCount > 0 ? ` + ${categoricalCount} categorical >3-choice` : ''})` : ''}\n`);
  if (binaryProposals.length === 0) {
    console.log(`No classifiable proposals available.${includeMultiChoice ? '' : ' Space may use multi-choice or gauge-allocation voting (try --multi-choice flag).'}${patternMode === 'binary' ? ' For budget-allocation / multi-candidate elections, try --pattern-mode categorical.' : ''}`);
    return;
  }

  // Build proposal → abstainChoice map for vote-filtering
  const propAbstain = new Map();
  for (const p of binaryProposals) {
    if (p.abstainChoice) propAbstain.set(p.id, p.abstainChoice);
  }

  const voterAddrs = topVoters.map(v => v.address);
  const proposalIds = binaryProposals.map(p => p.id);
  const allVotes = governorMode
    ? await fetchVotesFromGovernor(governorAddress, governorChain, binaryProposals, voterAddrs)
    : await fetchVotes(proposalIds, voterAddrs);
  // HB#507 multi-choice handling: filter out votes where choice === Abstain index
  const votes = allVotes.filter(v => {
    const abstainIdx = propAbstain.get(v.proposal.id);
    return !abstainIdx || v.choice !== abstainIdx;
  });
  const filteredCount = allVotes.length - votes.length;
  console.log(`Binary-proposal votes by top-${topN}: ${votes.length}${filteredCount > 0 ? ` (${filteredCount} Abstain votes excluded)` : ''}\n`);

  // Index: proposal → { voter → choice }
  const byProposal = new Map();
  for (const v of votes) {
    const pid = v.proposal.id;
    if (!byProposal.has(pid)) byProposal.set(pid, {});
    byProposal.get(pid)[v.voter.toLowerCase()] = v.choice;
  }

  // Metric 1: ALL-AGREE across proposals where ALL top-N voted
  let allAgreed = 0, allCoparticipated = 0;
  const perPair = new Map(); // top-k → { coVoted, agreed }
  for (let k = 1; k < topN; k++) perPair.set(k, { coVoted: 0, agreed: 0 });

  // HB#519 (vigil Task proposed in HB#518): individual-activity counters
  // for top-1 and top-2 — used in DISJOINT-vs-artifact disambiguation when
  // top-2 co-voted count is 0. If BOTH voters individually active in ≥10
  // proposals with 0 co-votes → DISJOINT-DUAL-WHALE (structural avoidance).
  // If either has <10 individual activity, 0 co-votes is sparse-overlap
  // artifact, not signal.
  let top1Active = 0;
  let top2Active = 0;

  for (const [pid, choices] of byProposal.entries()) {
    const top1Choice = choices[voterAddrs[0]];
    if (top1Choice !== undefined) top1Active++;
    if (voterAddrs.length >= 2 && choices[voterAddrs[1]] !== undefined) top2Active++;
    if (top1Choice === undefined) continue;
    // Pairwise-with-top-1 (HB#567: agreeOn() abstracts equality across pattern modes)
    for (let k = 1; k < topN; k++) {
      const cho = choices[voterAddrs[k]];
      if (cho !== undefined) {
        perPair.get(k).coVoted++;
        if (agreeOn(cho, top1Choice, patternMode)) perPair.get(k).agreed++;
      }
    }
    // All-agree
    const allPresent = voterAddrs.every(a => choices[a] !== undefined);
    if (allPresent) {
      allCoparticipated++;
      const all = voterAddrs.map(a => choices[a]);
      // HB#567: weighted-mode all-agree = all pairwise agree with first; else integer equality.
      const allMatch = patternMode === 'weighted'
        ? all.every(c => agreeOn(c, all[0], 'weighted'))
        : all.every(c => c === all[0]);
      if (allMatch) allAgreed++;
    }
  }

  const allAgreeRate = allCoparticipated ? allAgreed / allCoparticipated : 0;
  console.log(`ALL-AGREE rate: ${allAgreed}/${allCoparticipated} = ${(allAgreeRate * 100).toFixed(1)}%`);
  console.log('Pairwise-with-top-1 rates:');
  const pairwiseRates = [];
  for (let k = 1; k < topN; k++) {
    const { coVoted, agreed } = perPair.get(k);
    const rate = coVoted ? agreed / coVoted : 0;
    pairwiseRates.push(rate);
    console.log(`  top-${k + 1}: ${agreed}/${coVoted} = ${(rate * 100).toFixed(1)}% (vs top-1)`);
  }
  const majorityPairwise = pairwiseRates.filter(r => r >= 0.70).length;

  // v2.x refinement (argus HB#404 methodology request): dual-whale is a TOP-2
  // phenomenon. Output separate top-2-specific diagnostic independent of broader
  // top-N tier. Applies when caller is investigating Rule A-dual-whale
  // (top-1 + top-2 ≥ 50% per audit-snapshot) rather than full-cohort E-direct.
  const top2 = perPair.get(1) || { coVoted: 0, agreed: 0 };
  const top2PairwiseRate = top2.coVoted ? top2.agreed / top2.coVoted : 0;
  // HB#519 DISJOINT disambiguation: when top-2 co-voted is 0, distinguish
  // structural avoidance (DISJOINT) from sparse-overlap artifact. Threshold:
  // both top-1 and top-2 must have ≥10 individual-activity for 0-coincidence
  // to be meaningful (vigil HB#518 proposal).
  const DISJOINT_ACTIVITY_THRESHOLD = 10;
  let dualWhaleVariant = 'N/A';
  if (top2.coVoted === 0 && top1Active >= DISJOINT_ACTIVITY_THRESHOLD && top2Active >= DISJOINT_ACTIVITY_THRESHOLD) {
    dualWhaleVariant = `DISJOINT (top-2 active=${top2Active}, top-1 active=${top1Active}, 0 co-votes — structural avoidance, per vigil HB#518)`;
  } else if (top2.coVoted >= 3) {
    if (top2PairwiseRate >= 0.70) dualWhaleVariant = 'COORDINATED (top-2 pairwise ≥70%)';
    else dualWhaleVariant = 'INDEPENDENT (top-2 pairwise <70%)';
  } else {
    dualWhaleVariant = `INSUFFICIENT-DATA (top-2 co-voted <3; top-1 active=${top1Active}, top-2 active=${top2Active})`;
  }
  console.log(`\nDual-whale top-2 diagnostic (argus HB#404 refinement + vigil HB#519 DISJOINT):`);
  console.log(`  top-1 individual activity: ${top1Active} proposals`);
  console.log(`  top-2 individual activity: ${top2Active} proposals`);
  console.log(`  top-2 pairwise: ${top2.agreed}/${top2.coVoted} = ${(top2PairwiseRate * 100).toFixed(1)}%`);
  console.log(`  Variant: ${dualWhaleVariant}`);

  let tier = 'None';
  if (allAgreeRate >= 0.70) tier = 'STRONG';
  else if (majorityPairwise > pairwiseRates.length / 2) tier = 'PAIRWISE-ONLY';

  console.log(`\n=== E-direct tier: ${tier} ===`);
  console.log(`(all-agree ${(allAgreeRate * 100).toFixed(1)}%; pairwise≥70% in ${majorityPairwise}/${pairwiseRates.length} pairs)\n`);

  // v1.3-prototype summary: Pattern ι vs coordinated-dual-whale (vigil HB#459 + HB#466 fix)
  // Computes top-1/top-2 ratio + applies v2.1.4 classification workflow.
  // HB#466 fix: under --selection active-share, ratio must use avgShare not cumulativeVP
  // (Frax case shipped 0.00× misleading result because active-share top voters have
  // tiny cum-VP but large per-proposal dominance).
  let patternSummary = 'n/a';
  const metric0 = selection === 'active-share' ? topVoters[0].avgShare : topVoters[0].cumulativeVP;
  const metric1 = topVoters.length >= 2 ? (selection === 'active-share' ? topVoters[1].avgShare : topVoters[1].cumulativeVP) : null;
  // HB#523 active-share saturation detection (per HB#499/521 methodology insight):
  // when top-1+top-2 both have avgShare > 0.95, active-share metric mechanically
  // produces ratio ~1.00× regardless of true cum-vp dominance. Sub-tier band
  // assignment under active-share is then a methodology artifact, not population truth.
  // Detected cases empirically: stakewise (HB#496), gnosis (HB#499), ApeCoin (HB#502),
  // fei.eth (HB#521) — all ι-strong cum-vp → ι-moderate active-share via this artifact.
  const isActiveShareSaturated = selection === 'active-share' && metric0 > 0.95 && metric1 > 0.95;
  if (metric0 && metric1) {
    const ratio = metric0 / metric1;
    const subTier = ratio >= 3 ? 'ι-extreme' : ratio >= 1.5 ? 'ι-strong' : ratio >= 1.0 ? 'ι-moderate' : 'no-dominance';
    const saturationCaveat = isActiveShareSaturated
      ? ` ⚠ ACTIVE-SHARE SATURATION (top-1+top-2 both avgShare>0.95): sub-tier band ${subTier} is methodology artifact; cum-vp re-test recommended for true sub-tier`
      : '';
    if (subTier === 'no-dominance') {
      patternSummary = `ratio ${ratio.toFixed(2)}× — top-1 NOT dominant; neither Pattern ι nor dual-whale${saturationCaveat}`;
    } else if (top2.coVoted === 0 && top1Active >= DISJOINT_ACTIVITY_THRESHOLD && top2Active >= DISJOINT_ACTIVITY_THRESHOLD) {
      // HB#519 DISJOINT signal — both active, 0 co-votes, structural avoidance
      patternSummary = `ratio ${ratio.toFixed(2)}× (${subTier} band) + top-2 co-vote=0 WITH BOTH ACTIVE (top-1=${top1Active}, top-2=${top2Active}) → DISJOINT DUAL-WHALE candidate (structural avoidance, per vigil HB#518 heuristic)${saturationCaveat}`;
    } else if (top2.coVoted < 3) {
      patternSummary = `ratio ${ratio.toFixed(2)}× (${subTier} band) + top-2 co-vote INSUFFICIENT (${top2.coVoted}; top-1 active=${top1Active}, top-2 active=${top2Active}) → Pattern ι candidate (PENDING larger sample per v2.1.3 caveat; too sparse for DISJOINT per HB#518 threshold)${saturationCaveat}`;
    } else if (top2PairwiseRate >= 0.70) {
      patternSummary = `ratio ${ratio.toFixed(2)}× (${subTier} band) + top-2 pairwise ${(top2PairwiseRate * 100).toFixed(0)}% ≥ 70% → COORDINATED DUAL-WHALE (per v2.1.2 disqualifier — NOT Pattern ι)${saturationCaveat}`;
    } else {
      patternSummary = `ratio ${ratio.toFixed(2)}× (${subTier} band) + top-2 pairwise ${(top2PairwiseRate * 100).toFixed(0)}% < 70% → Pattern ι ${subTier} (co-vote LOW)${saturationCaveat}`;
    }
  }
  console.log(`\n=== Pattern ι vs dual-whale (v1.3-prototype per vigil HB#459) ===`);
  console.log(`  ${patternSummary}\n`);

  console.log('JSON:');
  console.log(JSON.stringify({
    space, topN, binaryProposals: binaryProposals.length, allCoparticipated, allAgreed, allAgreeRate,
    pairwiseRates, majorityPairwise, tier, topVoters,
    dualWhale: { top2CoVoted: top2.coVoted, top2Agreed: top2.agreed, top2PairwiseRate, top1Active, top2Active, variant: dualWhaleVariant },
    patternSummary,
    // HB#566 Task #503: diagnostic field — per-page vote counts for fetchTopVoters.
    // Surfaces partial-fetch issues (e.g., [1000, 1000, 847, 0] may indicate transient
    // short page at page 2). Retry logic guards against the case; this field lets
    // callers verify whether the retry fired.
    fetchPageCounts: lastFetchPageCounts,
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
