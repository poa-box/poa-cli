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

async function fetchProposals(space, first = 1000, includeMultiChoice = false) {
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
    return false;
  }).map(p => {
    // Annotate proposals with abstain-choice index for downstream filtering
    if (p.choices.length === 3 && /abstain/i.test(p.choices[2])) {
      return { ...p, abstainChoice: 3 };
    }
    return p;
  });
}

async function fetchVotes(proposalIds, voterAddrs) {
  // Snapshot's votes API has 1000 limit per page. Batch by proposal to stay
  // under the limit. For each proposal, query votes filtered to voterAddrs.
  const q = `query($pid: String!, $voters: [String!]!) {
    votes(first: 1000, where: { proposal: $pid, voter_in: $voters }) {
      proposal { id }
      voter
      choice
      vp
    }
  }`;
  const all = [];
  for (const pid of proposalIds) {
    const d = await gql(q, { pid, voters: voterAddrs });
    if (d && d.votes) all.push(...d.votes);
  }
  return all;
}

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
  for (let page = 0; page < 4; page++) {
    const d = await gql(q, { space, first: 1000, skip: page * 1000 });
    const votes = (d && d.votes) || [];
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
  const args = process.argv.slice(2);
  const space = args[0];
  let topN = 5;
  let explicitVoters = null;
  let selection = 'cum-vp';
  let includeMultiChoice = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--voters' && args[i + 1]) {
      explicitVoters = args[i + 1].split(',').map(s => s.trim().toLowerCase());
      i++;
    } else if (args[i] === '--selection' && args[i + 1]) {
      selection = args[i + 1];
      i++;
    } else if (args[i] === '--multi-choice') {
      includeMultiChoice = true;
    } else if (/^\d+$/.test(args[i])) {
      topN = Number(args[i]);
    }
  }
  if (!space) { console.error('Usage: node lockstep-analyzer.js <space.eth> [topN=5] [--voters addr1,...] [--selection cum-vp|active-share] [--multi-choice]'); process.exit(1); }
  if (!['cum-vp', 'active-share'].includes(selection)) { console.error('--selection must be cum-vp or active-share'); process.exit(1); }

  const selectionLabel = explicitVoters ? 'explicit voters' : `auto-selected by ${selection}`;
  console.log(`\nLockstep analysis: ${space} (top-${topN}, ${selectionLabel})\n`);

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

  const binaryProposals = await fetchProposals(space, 1000, includeMultiChoice);
  const multiChoiceCount = binaryProposals.filter(p => p.abstainChoice).length;
  console.log(`\nBinary proposals found: ${binaryProposals.length}${includeMultiChoice && multiChoiceCount > 0 ? ` (${binaryProposals.length - multiChoiceCount} pure-binary + ${multiChoiceCount} 3-choice w/ Abstain ignored)` : ''}\n`);
  if (binaryProposals.length === 0) {
    console.log(`No binary proposals available.${includeMultiChoice ? '' : ' Space may use multi-choice or gauge-allocation voting (try --multi-choice flag).'}`);
    return;
  }

  // Build proposal → abstainChoice map for vote-filtering
  const propAbstain = new Map();
  for (const p of binaryProposals) {
    if (p.abstainChoice) propAbstain.set(p.id, p.abstainChoice);
  }

  const voterAddrs = topVoters.map(v => v.address);
  const proposalIds = binaryProposals.map(p => p.id);
  const allVotes = await fetchVotes(proposalIds, voterAddrs);
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

  for (const [pid, choices] of byProposal.entries()) {
    const top1Choice = choices[voterAddrs[0]];
    if (top1Choice === undefined) continue;
    // Pairwise-with-top-1
    for (let k = 1; k < topN; k++) {
      const cho = choices[voterAddrs[k]];
      if (cho !== undefined) {
        perPair.get(k).coVoted++;
        if (cho === top1Choice) perPair.get(k).agreed++;
      }
    }
    // All-agree
    const allPresent = voterAddrs.every(a => choices[a] !== undefined);
    if (allPresent) {
      allCoparticipated++;
      const all = voterAddrs.map(a => choices[a]);
      if (all.every(c => c === all[0])) allAgreed++;
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
  let dualWhaleVariant = 'N/A';
  if (top2.coVoted >= 3) {
    if (top2PairwiseRate >= 0.70) dualWhaleVariant = 'COORDINATED (top-2 pairwise ≥70%)';
    else dualWhaleVariant = 'INDEPENDENT (top-2 pairwise <70%)';
  } else {
    dualWhaleVariant = 'INSUFFICIENT-DATA (top-2 co-voted <3 binary props)';
  }
  console.log(`\nDual-whale top-2 diagnostic (argus HB#404 refinement):`);
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
    } else if (top2.coVoted < 3) {
      patternSummary = `ratio ${ratio.toFixed(2)}× (${subTier} band) + top-2 co-vote INSUFFICIENT (${top2.coVoted}) → Pattern ι candidate (PENDING larger sample per v2.1.3 caveat)${saturationCaveat}`;
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
    dualWhale: { top2CoVoted: top2.coVoted, top2Agreed: top2.agreed, top2PairwiseRate, variant: dualWhaleVariant },
    patternSummary,
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
