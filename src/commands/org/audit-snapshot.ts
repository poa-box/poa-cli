import type { Argv, ArgumentsCamelCase } from 'yargs';
import * as output from '../../lib/output';

const SNAPSHOT_API = 'https://hub.snapshot.org/graphql';

interface AuditSnapshotArgs {
  org: string;
  space: string;
  pin?: boolean;
  chain?: number;
  rpc?: string;
  classifyProposals?: boolean;
  protocolProfile?: string;
  noRuleAAdjustment?: boolean;
}

export type DecisionType = 'ratification' | 'allocation' | 'policy' | 'tokenomics' | 'deployment' | 'signaling' | 'unclassified';

const DECISION_KEYWORDS: Record<Exclude<DecisionType, 'unclassified'>, string[]> = {
  ratification: [
    'arfc', 'risk param', 'ltv', 'lltv', ' cap ', 'cap adjustment',
    'oracle', 'gauntlet', 'llama', 'chaos labs', 'aave chan',
    'parameter', 'interest rate', 'liquidation', 'collateral factor',
    'kink', 'reserve factor', 'utilization', 'curator', 'list ',
    'add market', 'add collateral', 'onboard', 'temp check',
    'adapter', 'registry', 'v3 core', 'credit manager', 'pool param',
    'morpho', 'metamorpho', 'vault configuration',
  ],
  allocation: [
    'budget', 'grant', 'funding request', 'mission', 'workstream',
    'treasury allocation', 'retropgf', 'retro pgf', 'bounty',
    'incentive', 'reward allocation', 'distribute to',
    'slc budget', 'stream', 'payment', 'contributor grant',
    'development funding',
  ],
  policy: [
    'disclosure', 'conflict of interest', 'code of conduct',
    'governance policy', 'quorum', 'voting process', 'constitution',
    'bylaws', 'rules of engagement', 'charter', 'mandate',
    'deprecation', 'review of',
  ],
  tokenomics: [
    'token alignment', 'emission', 'reward schedule',
    'distribution phase', 'vesting', 'buyback', 'inflation',
    'tokenomic', 'supply change', 'mint cap', 'burn', 'airdrop',
    'staking reward',
  ],
  deployment: [
    'deploy to', 'deploy v', 'strategic partnership', 'megaeth',
    'new chain', 'add chain', 'cross-chain launch', 'bridge to',
    'new instance', 'expand to', 'mainnet launch',
  ],
  signaling: [
    'signaling', 'sentiment', 'poll', 'survey', 'opinion',
    'straw poll', 'discussion', 'urgency signaling',
    'preference', 'feedback on', 'gauge interest',
  ],
};

// v0.7 (Task #475): protocol-specific keyword profiles. Keys are Snapshot space IDs
// (or their lowercased form). Values augment DECISION_KEYWORDS at classification time.
// Catches protocol-specific title conventions that the generic keyword list misses.
export const PROTOCOL_PROFILES: Record<string, Partial<Record<Exclude<DecisionType, 'unclassified'>, string[]>>> = {
  'opcollective.eth': {
    allocation: ['mission request', 'season budget', 'citizens house ballot', 'grants council', 'retro funding', 'growth experiments', 'builders'],
    policy: ['intent', 'special voting cycle', 'badgeholder nomination', 'token house'],
    deployment: ['upgrade x', 'op stack'],
  },
  'arbitrumfoundation.eth': {
    ratification: ['aip', 'arbitrum improvement proposal'],
    allocation: ['stip', 'ltipp', 'short-term incentive', 'long-term incentive', 'grant program'],
    policy: ['council election', 'security council'],
  },
  'gearbox.eth': {
    ratification: ['credit manager', 'credit account', 'pool parameter', 'leverage ratio', 'risk tier', 'collateral type'],
    tokenomics: ['gear emission', 'vote-locked gear'],
  },
  'morpho.eth': {
    ratification: ['mip ', 'morpho market', 'metamorpho vault', 'curator', 'adapter', 'market registry', 'list '],
    allocation: ['contributor grant'],
    policy: ['deprecation', 'external grants'],
  },
  'uniswapgovernance.eth': {
    ratification: ['ugp', 'temperature check', 'consensus check', 'governance proposal'],
    deployment: ['deploy uniswap', 'v4 deployment'],
  },
  'vote.makerdao.com': {
    ratification: ['executive proposal', 'risk parameter update', 'dai savings rate', 'collateral onboarding'],
    allocation: ['subdao', 'spark grant'],
  },
};

export function getProtocolProfile(spaceId: string, override?: string): Partial<Record<Exclude<DecisionType, 'unclassified'>, string[]>> | null {
  const key = (override || spaceId).toLowerCase();
  return PROTOCOL_PROFILES[key] || null;
}

function matchKeyword(text: string, keyword: string): boolean {
  // Multi-word or keyword already containing a space: substring match is fine.
  if (keyword.includes(' ')) return text.includes(keyword);
  // Single-word keyword: require word boundary to avoid "mission" matching "emission".
  const pattern = new RegExp(`\\b${keyword.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`);
  return pattern.test(text);
}

export function classifyProposal(
  title: string,
  body?: string,
  profile?: Partial<Record<Exclude<DecisionType, 'unclassified'>, string[]>> | null
): DecisionType {
  const text = `${title} ${body || ''}`.toLowerCase();
  const scores: Partial<Record<DecisionType, number>> = {};
  for (const [category, keywords] of Object.entries(DECISION_KEYWORDS)) {
    const profileKeywords = profile?.[category as Exclude<DecisionType, 'unclassified'>] || [];
    const allKeywords = [...keywords, ...profileKeywords];
    scores[category as DecisionType] = allKeywords.reduce(
      (acc, kw) => acc + (matchKeyword(text, kw) ? 1 : 0),
      0
    );
  }
  const best = (Object.entries(scores) as [DecisionType, number][])
    .sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : 'unclassified';
}

// v0.9 (Task #477): Rule-A capture-adjustment. When top-1 controls ≥50% of voting power,
// Rule A rubber-stamp dynamics dominate regardless of decision-type mix. Empirical anchor:
// Gitcoin 96% at top-1 50.1%, Balancer 94% at top-1 ~50%. Override predicted pass rate to
// floor of 0.85 in this regime.
const RULE_A_CAPTURE_FLOOR = 0.85;
const RULE_A_TOP1_THRESHOLD = 0.50;
const RULE_A_DUAL_THRESHOLD = 0.50;

export function applyRuleAAdjustment(
  basePrediction: number,
  topVoterShares: number[]
): { adjusted: number; triggered: boolean; mode: 'single-whale' | 'dual-whale-candidate' | 'none' } {
  const top1 = topVoterShares[0] || 0;
  const top2 = topVoterShares[1] || 0;
  if (top1 >= RULE_A_TOP1_THRESHOLD) {
    return {
      adjusted: Math.max(basePrediction, RULE_A_CAPTURE_FLOOR),
      triggered: true,
      mode: 'single-whale',
    };
  }
  if (top1 + top2 >= RULE_A_DUAL_THRESHOLD) {
    // Dual-whale candidate: coordination must be verified externally (lockstep-analyzer).
    // Do not apply floor automatically; surface as candidate for user to verify.
    return { adjusted: basePrediction, triggered: false, mode: 'dual-whale-candidate' };
  }
  return { adjusted: basePrediction, triggered: false, mode: 'none' };
}

export function weightedMixPrediction(
  counts: Record<DecisionType, number>
): { predictedPassRate: number; pRatification: number; pNonRatification: number; pSignaling: number; classifiedFraction: number } {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return { predictedPassRate: 0, pRatification: 0, pNonRatification: 0, pSignaling: 0, classifiedFraction: 0 };
  }
  const classified = total - counts.unclassified;
  if (classified === 0) {
    return { predictedPassRate: 0, pRatification: 0, pNonRatification: 0, pSignaling: 0, classifiedFraction: 0 };
  }
  // v0.5 (vigil HB#438 fix): compute over classified subset only.
  // v0.6 (vigil HB#438 rec #2): signaling as distinct category, pass rate ~0.40
  // (empirical anchor: Nouns secondary Snapshot 29%, signaling-heavy space).
  const pRatif = counts.ratification / classified;
  const pNonRatif =
    (counts.allocation + counts.policy + counts.tokenomics + counts.deployment) / classified;
  const pSignal = counts.signaling / classified;
  // P_RATIF_PASS = 0.99, P_NON_PASS = 0.70, P_SIGNAL_PASS = 0.40 (HB#748 anchor from Nouns).
  const predicted = pRatif * 0.99 + pNonRatif * 0.70 + pSignal * 0.40;
  return {
    predictedPassRate: parseFloat(predicted.toFixed(3)),
    pRatification: parseFloat(pRatif.toFixed(3)),
    pNonRatification: parseFloat(pNonRatif.toFixed(3)),
    pSignaling: parseFloat(pSignal.toFixed(3)),
    classifiedFraction: parseFloat((classified / total).toFixed(3)),
  };
}

async function querySnapshot(query: string, variables: any = {}): Promise<any> {
  const response = await fetch(SNAPSHOT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json() as any;
  if (json.errors) throw new Error(`Snapshot API: ${json.errors[0].message}`);
  return json.data;
}

export const auditSnapshotHandler = {
  builder: (yargs: Argv) => yargs
    .option('space', { type: 'string', demandOption: true, describe: 'Snapshot space ID (e.g. ens.eth)' })
    .option('pin', { type: 'boolean', default: false, describe: 'Pin report to IPFS' })
    .option('classify-proposals', { type: 'boolean', default: false, describe: 'Apply Pattern θ v0.4 decision-type classification + weighted-mix pass-rate prediction' })
    .option('protocol-profile', { type: 'string', describe: 'Override auto-detected protocol keyword profile (e.g. opcollective.eth, arbitrumfoundation.eth, morpho.eth)' })
    .option('no-rule-a-adjustment', { type: 'boolean', default: false, describe: 'Disable Pattern θ v0.9 Rule-A capture-adjustment (top-1 ≥50% override)' }),

  handler: async (argv: ArgumentsCamelCase<AuditSnapshotArgs>) => {
    const spin = output.spinner(`Auditing Snapshot space: ${argv.space}...`);
    spin.start();

    try {
      const spaceId = argv.space as string;

      // Fetch proposals (last 100)
      spin.text = 'Fetching proposals...';
      const proposalData = await querySnapshot(`
        query($space: String!) {
          proposals(where: {space: $space}, first: 100, orderBy: "created", orderDirection: desc) {
            id title state votes scores_total scores choices created end author
          }
        }
      `, { space: spaceId });

      const proposals = proposalData.proposals || [];
      if (proposals.length === 0) throw new Error(`No proposals found for space "${spaceId}"`);

      // Fetch votes for recent proposals (last 10)
      spin.text = 'Analyzing voting patterns...';
      const recentProposalIds = proposals.slice(0, 10).map((p: any) => p.id);
      const voteData = await querySnapshot(`
        query($proposals: [String!]!) {
          votes(where: {proposal_in: $proposals}, first: 1000, orderBy: "vp", orderDirection: desc) {
            voter vp proposal { id }
          }
        }
      `, { proposals: recentProposalIds });

      const votes = voteData.votes || [];

      // Compute metrics
      const closed = proposals.filter((p: any) => p.state === 'closed');
      const active = proposals.filter((p: any) => p.state === 'active');
      const totalVotes = proposals.reduce((sum: number, p: any) => sum + (p.votes || 0), 0);
      const avgVotesPerProposal = closed.length > 0 ? Math.round(totalVotes / closed.length) : 0;

      // Voter concentration
      const voterPower: Record<string, number> = {};
      for (const v of votes) {
        voterPower[v.voter] = (voterPower[v.voter] || 0) + (v.vp || 0);
      }
      const sortedVoters = Object.entries(voterPower).sort((a, b) => b[1] - a[1]);
      const totalVP = sortedVoters.reduce((sum, [, vp]) => sum + vp, 0);
      const uniqueVoters = sortedVoters.length;

      // Top 5 voters
      const topVoters = sortedVoters.slice(0, 5).map(([addr, vp]) => ({
        address: addr.slice(0, 8) + '...' + addr.slice(-4),
        votingPower: Math.round(vp),
        share: totalVP > 0 ? ((vp / totalVP) * 100).toFixed(1) + '%' : '0%',
      }));

      // Voter Gini
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

      // Proposal pass rate (approximation: option with highest score wins)
      const passedCount = closed.filter((p: any) => {
        if (!p.scores || p.scores.length < 2) return true;
        return p.scores[0] > p.scores[1]; // First option ("For") wins
      }).length;

      // Time span
      const oldestProposal = proposals[proposals.length - 1];
      const newestProposal = proposals[0];
      const timeSpanDays = oldestProposal ? Math.round((newestProposal.created - oldestProposal.created) / 86400) : 0;

      // Risks
      const risks: string[] = [];
      if (gini > 0.8) risks.push(`Extreme voting power concentration (Gini: ${gini.toFixed(2)})`);
      else if (gini > 0.6) risks.push(`High voting power concentration (Gini: ${gini.toFixed(2)})`);
      if (topVoters.length > 0 && parseFloat(topVoters[0].share) > 30) {
        risks.push(`Top voter controls ${topVoters[0].share} of voting power`);
      }
      if (avgVotesPerProposal < 20) risks.push(`Low voter participation (avg ${avgVotesPerProposal} votes/proposal)`);
      if (passedCount / Math.max(closed.length, 1) > 0.95) risks.push('Near-100% pass rate — proposals may lack genuine deliberation');
      if (uniqueVoters < 10) risks.push(`Very few unique voters (${uniqueVoters}) — governance capture risk`);

      // Recommendations
      const recommendations: string[] = [];
      if (gini > 0.6) recommendations.push('Implement delegation programs to distribute voting power');
      if (avgVotesPerProposal < 20) recommendations.push('Lower barriers to participation — simplify voting UX');
      if (passedCount / Math.max(closed.length, 1) > 0.95) recommendations.push('Encourage more diverse proposals and dissenting views');
      if (uniqueVoters < 20) recommendations.push('Launch voter education and incentive programs');

      const report: any = {
        space: spaceId,
        auditor: 'Argus',
        date: new Date().toISOString().split('T')[0],
        summary: {
          proposals: proposals.length,
          active: active.length,
          closed: closed.length,
          totalVotes,
          avgVotesPerProposal,
          uniqueVoters,
          votingPowerGini: parseFloat(gini.toFixed(3)),
          passRate: closed.length > 0 ? `${Math.round((passedCount / closed.length) * 100)}%` : 'N/A',
          timeSpanDays,
        },
        topVoters,
        risks,
        recommendations,
      };

      if (argv.classifyProposals) {
        const counts: Record<DecisionType, number> = {
          ratification: 0, allocation: 0, policy: 0,
          tokenomics: 0, deployment: 0, signaling: 0, unclassified: 0,
        };
        const profile = getProtocolProfile(spaceId, argv.protocolProfile);
        const classified: Array<{ id: string; title: string; category: DecisionType }> = [];
        for (const p of closed) {
          const category = classifyProposal(p.title || '', undefined, profile);
          counts[category]++;
          classified.push({ id: p.id, title: p.title, category });
        }
        const prediction = weightedMixPrediction(counts);
        const actualPR = closed.length > 0 ? passedCount / closed.length : 0;
        const lowConfidence = prediction.classifiedFraction < 0.5;
        const topShares = topVoters.map((v: any) => parseFloat(v.share) / 100);
        const ruleA = argv.noRuleAAdjustment
          ? { adjusted: prediction.predictedPassRate, triggered: false, mode: 'disabled' as const }
          : applyRuleAAdjustment(prediction.predictedPassRate, topShares);
        const finalPrediction = ruleA.adjusted;
        report.patternTheta = {
          version: 'v0.9',
          protocolProfile: profile ? (argv.protocolProfile || spaceId).toLowerCase() : null,
          decisionTypeCounts: counts,
          classifiedFraction: prediction.classifiedFraction,
          lowConfidence,
          pRatification: prediction.pRatification,
          pNonRatification: prediction.pNonRatification,
          pSignaling: prediction.pSignaling,
          basePassRate: prediction.predictedPassRate,
          ruleAAdjustment: {
            applied: ruleA.triggered,
            mode: ruleA.mode,
            floor: RULE_A_CAPTURE_FLOOR,
          },
          predictedPassRate: parseFloat(finalPrediction.toFixed(3)),
          actualPassRate: parseFloat(actualPR.toFixed(3)),
          deltaPpPoints: parseFloat(
            ((finalPrediction - actualPR) * 100).toFixed(1)
          ),
          sampleClassified: classified.slice(0, 10),
          ...(lowConfidence && {
            warning: `Only ${Math.round(prediction.classifiedFraction * 100)}% of proposals classified — prediction may be unreliable for this space (out-of-distribution governance surface per vigil HB#438)`,
          }),
          ...(ruleA.mode === 'dual-whale-candidate' && {
            dualWhaleNotice: `top-1 + top-2 cumulative ≥50% (dual-whale candidate). Rule-A capture-adjustment NOT applied — coordination must be verified via lockstep-analyzer.js before treating as captured governance.`,
          }),
        };
      }

      if (argv.pin) {
        const { pinJson } = require('../../lib/ipfs');
        const cid = await pinJson(JSON.stringify(report));
        report.ipfsCid = cid;
      }

      spin.stop();

      if (argv.json) {
        output.json(report);
      } else {
        output.success(`Snapshot Audit: ${spaceId}`, {
          proposals: `${proposals.length} (${active.length} active, ${closed.length} closed)`,
          avgVotes: avgVotesPerProposal,
          uniqueVoters,
          vpGini: gini.toFixed(3),
          passRate: report.summary.passRate,
          risks: risks.join('; ') || 'None identified',
        });
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
