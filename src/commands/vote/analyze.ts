/**
 * pop vote analyze — counterfactual analysis of one hybrid-voting proposal.
 *
 * Data source: the subgraph. Vote.classRawPowers is the per-class raw voting
 * power the contract itself emitted (verified live on poa-gnosis-v-1, e.g.
 * ["100","3700000000000000000000"] for a DIRECT+ERC20_BAL org), which is
 * exactly the quantity this command needs, and TokenBalance mirrors ERC20
 * balanceOf exactly (sum over holders == totalSupply on live data).
 *
 * The contract path is kept as a fallback and is what this command used to do
 * unconditionally — a single un-chunked queryFilter over the last 200k blocks
 * (rejected outright by most public RPCs) followed by one strictly serial
 * balanceOf per voter. The fallback reads the complete indexed creation-block-to-head range in
 * bounded chunks and batches balances through Multicall3.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveNetworkConfig } from '../../config/networks';
import { resolveOrgModules } from '../../lib/resolve';
import { query, queryWithFieldFallback } from '../../lib/subgraph';
import { tryAggregate } from '../../lib/multicall';
import {
  selectIndexedClassSnapshot,
} from '../../queries/voting-classes';
import { FETCH_TOKEN_BALANCES } from '../../queries/token';
import { CliError } from '../../lib/errors';
import { computeClassWeightedScores, fetchProposalVoteAnalysis } from '@poa-box/core/reads/vote';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface AnalyzeArgs {
  org: string;
  chain: number;
  proposal: number;
  rpc?: string;
}

/** One ballot, normalized to the shape the counterfactual math consumes. */
interface AnalyzedVoter {
  address: string;
  name: string;
  /**
   * The option indexes this ballot names, paired positionally with `weights`
   * as emitted by VoteCast(idxs, weights). Cleared once `weights` has been
   * densified into a full 0..numOptions-1 array.
   */
  optionIndexes?: number[];
  /** SPARSE until densified — see the densify block in the handler. */
  weights: number[];
  classRawPowers: bigint[];
  ptBalance: number;
  ptBalanceWei: bigint;
}

const ERC20_IFACE = new ethers.utils.Interface([
  'function balanceOf(address) view returns (uint256)',
]);

/**
 * PT balances for many holders in ONE subgraph query, keyed by lowercase
 * address. Holders with no TokenBalance row are simply absent (they hold 0).
 */
async function fetchPtBalances(
  tokenAddress: string,
  holders: string[],
  chainId?: number
): Promise<Map<string, string>> {
  const balances = new Map<string, string>();
  if (holders.length === 0) return balances;
  const accounts = [...new Set(holders.map(h => h.toLowerCase()))];
  for (let offset = 0; offset < accounts.length; offset += 1000) {
    const data = await query<any>(FETCH_TOKEN_BALANCES, {
      token: tokenAddress.toLowerCase(),
      accounts: accounts.slice(offset, offset + 1000),
    }, chainId);
    for (const row of data?.tokenBalances ?? []) {
      balances.set(String(row.account).toLowerCase(), String(row.balance));
    }
  }
  return balances;
}

/** Complete proposal log history, with adaptive pages for RPC range limits. */
export async function readProposalVoteEvents(
  hv: Pick<ethers.Contract, 'filters' | 'queryFilter'>,
  proposalId: number,
  fromBlock: number,
  toBlock: number,
): Promise<ethers.Event[]> {
  if (!Number.isSafeInteger(fromBlock) || fromBlock <= 0 || !Number.isSafeInteger(toBlock) || toBlock < fromBlock) {
    throw new CliError('Cannot establish the complete proposal vote-event range.', EXIT.PRECONDITION);
  }
  const filter = hv.filters.VoteCast(proposalId);
  const events: ethers.Event[] = [];
  let pageSize = 10000;
  for (let from = fromBlock; from <= toBlock;) {
    const to = Math.min(from + pageSize - 1, toBlock);
    try {
      events.push(...await hv.queryFilter(filter, from, to));
      from = to + 1;
    } catch (err) {
      if (pageSize === 1) throw err;
      pageSize = Math.max(1, Math.floor(pageSize / 2));
    }
  }
  return events;
}

export const analyzeHandler = {
  builder: (yargs: Argv) => yargs
    .option('proposal', { type: 'number', demandOption: true, describe: 'Proposal ID to analyze' }),

  handler: async (argv: ArgumentsCamelCase<AnalyzeArgs>) => {
    const spin = output.spinner('Analyzing vote...');
    spin.start();

    try {
      const chainId = argv.chain as number || 100;
      const contracts = await resolveOrgModules(argv.org as string, chainId);
      const hvAddr = contracts.hybridVotingAddress;
      if (!hvAddr) throw new Error('HybridVoting not found for this org');
      const proposalId = argv.proposal as number;

      let classConfig: Array<{ slicePct: number; quadratic: boolean; strategy: string; asset: string; minBalance: string }> | null = null;
      let voters: AnalyzedVoter[] | null = null;
      let proposalOptionCount = 0;
      let proposalCreationBlock = 0;
      let source: 'subgraph' | 'rpc' = 'subgraph';

      // ── Subgraph path ────────────────────────────────────────────────
      // One query for the frozen class snapshot + every ballot (with the
      // contract-emitted per-class raw powers) + the org username map, then
      // paginated ballot reads and batched PT balances.
      spin.text = 'Reading votes...';
      try {
        if (argv.rpc) throw new Error('Explicit RPC requested');
        const data = await fetchProposalVoteAnalysis({ queryWithFieldFallback }, hvAddr, proposalId, chainId);

        const hvEntity = data?.hybridVotingContract;
        const proposal = hvEntity?.proposals?.[0];
        const subgraphVotes: any[] = proposal?.votes ?? [];
        const classRows = selectIndexedClassSnapshot(hvEntity, proposalId);
        proposalOptionCount = Number(proposal?.numOptions ?? 0);
        proposalCreationBlock = Number(proposal?.createdAtBlock ?? 0);

        // Empty votes are NOT treated as an answer: subgraph lag on a
        // just-cast ballot would otherwise report a different electorate than
        // the chain. Fall through and let the contract say so.
        //
        // Ballot pages have already been collected with an ID cursor.
        if (subgraphVotes.length > 0) {
          const ptAddr = contracts.participationTokenAddress;
          if (!ptAddr) throw new CliError('ParticipationToken not found for this org', EXIT.USAGE);

          const usernames: Record<string, string> = {};
          for (const u of hvEntity.organization?.users ?? []) {
            if (u.account?.username) usernames[String(u.address).toLowerCase()] = u.account.username;
          }

          spin.text = 'Reading PT balances...';
          const balances = await fetchPtBalances(ptAddr, subgraphVotes.map(v => String(v.voter)), chainId);

          classConfig = classRows.length > 0 ? classRows.map(c => ({
            slicePct: Number(c.slicePct),
            quadratic: Boolean(c.quadratic),
            strategy: String(c.strategy), asset: String(c.asset), minBalance: String(c.minBalance ?? 0),
          })) : null;
          voters = subgraphVotes.map(v => {
            const addr = ethers.utils.getAddress(String(v.voter));
            const wei = balances.get(addr.toLowerCase()) ?? '0';
            return {
              address: addr,
              name: usernames[addr.toLowerCase()] || v.voterUsername || addr.slice(0, 10),
              // SPARSE — paired with optionIndexes, densified below.
              optionIndexes: (v.optionIndexes ?? []).map((n: any) => Number(n)),
              weights: (v.optionWeights ?? []).map((w: any) => Number(w)),
              classRawPowers: (v.classRawPowers ?? []).map((p: any) => BigInt(String(p))),
              ptBalance: parseFloat(ethers.utils.formatEther(wei)), ptBalanceWei: BigInt(wei),
            };
          });
        }
      } catch (subgraphErr: any) {
        if (subgraphErr instanceof CliError) throw subgraphErr;
        // Unknown field / lag / HTTP — the contract is authoritative anyway.
      }

      // ── Contract fallback ────────────────────────────────────────────
      if (!classConfig || !voters) {
        source = 'rpc';
        const networkConfig = resolveNetworkConfig(chainId);
        const provider = new ethers.providers.JsonRpcProvider(argv.rpc || networkConfig.resolvedRpc);
        const abi = require('../../abi/HybridVotingNew.json');
        const hv = new ethers.Contract(hvAddr, abi, provider);

        spin.text = 'Reading class config...';
        const classes: any[] = await hv.getProposalClasses(proposalId);
        classConfig = classes.map((c: any) => ({
          slicePct: Number(c.slicePct),
          quadratic: Boolean(c.quadratic),
          strategy: String(c.strategy), asset: String(c.asset), minBalance: String(c.minBalance ?? 0),
        }));

        // A restricted V2 poll needs its on-chain synthetic classes, but the
        // emitted raw powers already indexed for every ballot remain exact.
        if (!voters) {
          if (!Number.isSafeInteger(proposalCreationBlock) || proposalCreationBlock <= 0 || proposalOptionCount <= 0) {
            let proposal: any;
            try {
              const metadata = await query<any>(`query ProposalAnalysisBounds($id: ID!) {
                proposal(id: $id) { createdAtBlock numOptions }
              }`, { id: `${hvAddr.toLowerCase()}-${proposalId}` }, chainId);
              proposal = metadata?.proposal;
            } catch { /* Fail explicitly below rather than guessing a recent log window. */ }
            proposalCreationBlock = Number(proposal?.createdAtBlock ?? 0);
            proposalOptionCount = Number(proposal?.numOptions ?? 0);
          }
          if (!Number.isSafeInteger(proposalCreationBlock) || proposalCreationBlock <= 0
            || !Number.isSafeInteger(proposalOptionCount) || proposalOptionCount <= 0) {
            throw new CliError('Cannot analyze the complete proposal: its creation block or option count is not indexed.',
              EXIT.PRECONDITION, 'Retry after the subgraph has indexed this proposal.');
          }
          spin.text = 'Reading complete vote history...';
          const events = await readProposalVoteEvents(hv, proposalId, proposalCreationBlock, await provider.getBlockNumber());
          if (events.length === 0) throw new Error('No votes found for proposal ' + proposalId);

          spin.text = 'Reading PT balances...';
          const ptAddr = contracts.participationTokenAddress;
          if (!ptAddr) throw new Error('ParticipationToken not found for this org');

          const { queryAllChains } = require('../../lib/subgraph');
          const orgId = contracts.orgId || argv.org;
          const memberQuery = `{ organization(id: "${orgId}") { users(first: 100) { address account { username } } } }`;
          const memberResults = await queryAllChains(memberQuery, {});
          const usernames: Record<string, string> = {};
          for (const r of memberResults) {
            for (const u of r.data?.organization?.users || []) {
              if (u.account?.username) usernames[u.address.toLowerCase()] = u.account.username;
            }
          }

          // The balances are independent reads — one Multicall3 round-trip
          // instead of N serial ones.
          const addrs: string[] = events.map(ev => ev.args!.voter as string);
          const balanceResults = await tryAggregate(
            provider,
            addrs.map(a => ({ to: ptAddr, data: ERC20_IFACE.encodeFunctionData('balanceOf', [a]) }))
          );

          voters = events.map((ev, i) => {
            const addr = addrs[i];
            const { success, returnData } = balanceResults[i];
            const ptBal = success && returnData && returnData !== '0x'
              ? (ERC20_IFACE.decodeFunctionResult('balanceOf', returnData)[0] as ethers.BigNumber)
              : ethers.constants.Zero;
            return {
              address: addr,
              name: usernames[addr.toLowerCase()] || addr.slice(0, 10),
              // VoteCast(id, voter, idxs, weights, classRawPowers, timestamp) —
              // `weights` is SPARSE and paired with `idxs`, exactly like the
              // subgraph's optionWeights/optionIndexes. Densified below.
              optionIndexes: ev.args!.idxs.map((n: any) => Number(n)),
              weights: ev.args!.weights.map((w: any) => Number(w)),
              classRawPowers: ev.args!.classRawPowers.map((p: any) => BigInt(p.toString())),
              ptBalance: parseFloat(ethers.utils.formatEther(ptBal)), ptBalanceWei: BigInt(ptBal.toString()),
            };
          });
        }
      }

      // ── Densify the ballots ──────────────────────────────────────────
      //
      // A ballot is SPARSE: `optionWeights[k]` is the weight for option
      // `optionIndexes[k]`, not for option `k`. Both sources agree on this —
      // the subgraph copies the VoteCast(idxs, weights) params verbatim.
      //
      // Reading weights[opt] positionally, and taking numOptions from the first
      // voter's array length, silently produces a WRONG WINNER. Live Gnosis
      // examples: proposal 0x13cbd5ed…-2's first ballot is idxs [1] / weights
      // [100], which collapses numOptions to 1 and books a vote FOR option 1 as
      // 100 for option 0; proposal …-9's first ballot is idxs [3].
      //
      // numOptions is the max index seen across ALL ballots (not just the first,
      // and not the first ballot's length), so partial ballots cannot shrink the
      // option space.
      let numOptions = proposalOptionCount;
      for (const v of voters) {
        for (const idx of (v.optionIndexes ?? [])) {
          if (Number.isFinite(idx) && idx + 1 > numOptions) numOptions = idx + 1;
        }
        // Defensive: a source that ever emits a genuinely dense array without
        // indexes must not be truncated.
        if (!(v.optionIndexes ?? []).length && v.weights.length > numOptions) numOptions = v.weights.length;
      }
      if (numOptions === 0) numOptions = 1;

      for (const v of voters) {
        const dense: number[] = new Array(numOptions).fill(0);
        const idxs: number[] = v.optionIndexes ?? [];
        if (idxs.length) {
          for (let k = 0; k < idxs.length; k++) {
            const opt = idxs[k];
            if (opt >= 0 && opt < numOptions) dense[opt] = Number(v.weights[k] ?? 0);
          }
        } else {
          for (let k = 0; k < Math.min(v.weights.length, numOptions); k++) dense[k] = Number(v.weights[k] ?? 0);
        }
        v.weights = dense;
      }

      // Normalize EACH class by its own total before applying its slice, with
      // the same per-ballot rounding as Solidity. Token base units must never
      // overwhelm DIRECT points merely because they are numerically larger.
      const computeResult = (voteData: AnalyzedVoter[], slices: number[]) =>
        computeClassWeightedScores(voteData, slices, numOptions);

      spin.text = 'Computing scenarios...';

      // Actual result
      const actualSlices = classConfig.map((c: any) => c.slicePct);
      const actual = computeResult(voters, actualSlices);

      // DD-only
      const directIndex = classConfig.findIndex(c => c.strategy === 'DIRECT' || c.strategy === '0');
      const tokenIndex = classConfig.findIndex(c => c.strategy === 'ERC20_BAL' || c.strategy === '1');
      const ddOnlySlices = classConfig.map((_, i) => i === directIndex ? 100 : 0);
      const ddOnly = computeResult(voters, ddOnlySlices);

      // Token-only
      const tokenOnlySlices = classConfig.map((_, i) => i === tokenIndex ? 100 : 0);
      const tokenOnly = computeResult(voters, tokenOnlySlices);

      // No quadratic (use linear PT as token power)
      const linearSupported = classConfig.every(c => !c.quadratic || c.strategy === 'DIRECT' || c.strategy === '0'
        || c.asset.toLowerCase() === contracts.participationTokenAddress?.toLowerCase());
      const linearVoters = voters.map(v => ({
        ...v,
        // Counterfactual uses CURRENT PT balances; preserve the historical
        // eligibility mask and keep every unrelated class unchanged.
        classRawPowers: classConfig.map((c, i) => c.quadratic && (c.strategy === 'ERC20_BAL' || c.strategy === '1')
          ? (v.classRawPowers[i] > 0n && v.ptBalanceWei >= BigInt(c.minBalance) ? v.ptBalanceWei * 100n : 0n)
          : v.classRawPowers[i] ?? 0n),
      }));
      const noQuadratic = computeResult(linearVoters, actualSlices);

      // Single-pick (each voter's max weight gets 100, rest 0)
      const singleVoters = voters.map(v => {
        const maxW = Math.max(...v.weights);
        const maxIdx = v.weights.indexOf(maxW);
        const single = new Array(numOptions).fill(0);
        single[maxIdx] = 100;
        return { ...v, weights: single };
      });
      const singlePick = computeResult(singleVoters, actualSlices);

      spin.stop();

      // Build rankings
      const makeRanking = (pcts: number[]) =>
        pcts.map((pct, i) => ({ option: i, pct })).sort((a, b) => b.pct - a.pct);
      const scenario = (pcts: number[], available = true) => ({
        ranking: available ? makeRanking(pcts) : [],
        winner: available ? makeRanking(pcts)[0] : null,
        changed: available ? makeRanking(pcts)[0].option !== makeRanking(actual)[0].option : null,
        available,
      });

      const report: any = {
        proposalId,
        voters: voters.length,
        options: numOptions,
        classConfig,
        votes: voters.map(v => ({
          name: v.name,
          weights: v.weights,
          ptBalance: v.ptBalance,
          ddPower: (v.classRawPowers[directIndex] ?? 0n).toString(),
          tokenPower: (v.classRawPowers[tokenIndex] ?? 0n).toString(),
        })),
        actual: { ranking: makeRanking(actual), winner: makeRanking(actual)[0] },
        counterfactuals: {
          ddOnly: scenario(ddOnly, directIndex >= 0),
          tokenOnly: scenario(tokenOnly, tokenIndex >= 0),
          noQuadratic: { ...scenario(noQuadratic, linearSupported), balanceBasis: 'current-PT-balance-with-vote-time-eligibility' },
          singlePick: { ranking: makeRanking(singlePick), winner: makeRanking(singlePick)[0], changed: makeRanking(singlePick)[0].option !== makeRanking(actual)[0].option },
        },
        robustness: directIndex < 0 || tokenIndex < 0 ? 'NOT_APPLICABLE' : (makeRanking(ddOnly)[0].option === makeRanking(actual)[0].option &&
          makeRanking(tokenOnly)[0].option === makeRanking(actual)[0].option) ? 'ROBUST' : 'SENSITIVE',
        source,
        winnerSource: 'class-weighted-ranking',
        validity: 'not-evaluated',
      };

      if (argv.json) {
        output.json(report);
      } else {
        console.log('');
        console.log(`  Vote Analysis: Proposal #${proposalId}`);
        console.log('  ' + '═'.repeat(55));
        console.log(`  Classes: ${classConfig.map((c: any, i: number) => `${c.strategy} ${c.slicePct}%${c.quadratic ? ' (quadratic)' : ''}`).join(' | ')}`);
        console.log(`  Voters: ${voters.length}`);
        console.log('');

        // Show votes
        for (const v of report.votes) {
          console.log(`  ${v.name}: weights [${v.weights.join(',')}] | ${v.ptBalance} PT`);
        }
        console.log('');

        // Actual ranking
        console.log('  CLASS-WEIGHTED RANKING (quorum and validity not evaluated):');
        for (const r of report.actual.ranking) {
          const bar = '█'.repeat(Math.round(r.pct / 3)) + '░'.repeat(Math.max(0, 33 - Math.round(r.pct / 3)));
          console.log(`    Option ${r.option}: ${bar} ${r.pct.toFixed(1)}%`);
        }
        console.log('');

        // Counterfactuals
        const scenarios = [
          ['DD Only', report.counterfactuals.ddOnly],
          ['Token Only', report.counterfactuals.tokenOnly],
          ['No Quadratic', report.counterfactuals.noQuadratic],
          ['Single Pick', report.counterfactuals.singlePick],
        ];
        console.log('  COUNTERFACTUALS:');
        for (const [name, s] of scenarios) {
          const winner = (s as any).winner;
          if (!winner) { console.log(`    ${name}: unavailable for this class configuration`); continue; }
          const changed = (s as any).changed ? ' ← DIFFERENT!' : '';
          console.log(`    ${(name as string).padEnd(14)} Winner: Option ${winner.option} (${winner.pct.toFixed(1)}%)${changed}`);
        }
        console.log('');
        console.log(`  Robustness: ${report.robustness}`);
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err.message);
      process.exit(EXIT.USAGE);
    }
  },
};
