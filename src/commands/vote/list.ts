import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { queryWithFieldFallback } from '../../lib/subgraph';
import { resolveOrgId } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import { FETCH_VOTING_DATA, FETCH_VOTING_DATA_LEGACY } from '../../queries/voting';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import HybridVotingAbi from '../../abi/HybridVotingNew.json';
import DirectDemocracyVotingAbi from '../../abi/DirectDemocracyVotingNew.json';

/**
 * Task #378 (HB#437) mitigation for pop vote list subgraph-indexer lag.
 *
 * Observed twice this session: #54 (PR #10 merge) showed Ends-in decrementing
 * at ~30% wall-clock speed, and #55/#56 (duplicate PR #14 merge) stayed
 * status=Active with 0 votes for 13+ hours after actual on-chain execution.
 * The pop vote announce --dry-run probe confirmed both returned
 * `AlreadyExecuted()` — the subgraph had simply missed the Vote and
 * Announced events.
 *
 * Root cause hypothesis (diagnosis step of #378): the Gnosis subgraph
 * indexer for the POP HybridVoting/DirectDemocracyVoting contracts lags
 * under bursty block production. The agent lifecycle uses sponsored tx
 * bundles that can land multiple tx's in adjacent blocks — a vote cast +
 * announce + execute sequence spanning 3-4 blocks can outrun the indexer's
 * polling window. Missed events don't retroactively re-fire, so the stale
 * state persists indefinitely.
 *
 * Full root-cause fix is upstream in the subgraph indexer (not in this
 * repo). This file's mitigation: when the subgraph reports a proposal as
 * Active + endTimestamp<chainNow (which should NEVER happen for a healthy
 * indexer), probe the contract via callStatic.announceWinner(id). Three
 * possible outcomes:
 *   - callStatic succeeds → proposal is ready to announce (no one has run
 *     the announce tx yet). Override displayStatus to "Announceable".
 *   - reverts with AlreadyExecuted() → proposal has already been executed
 *     on-chain. Override displayStatus to "Ended (chain)" and flag the
 *     subgraph lag.
 *   - reverts with any other error → subgraph is probably right; fall
 *     through to the subgraph-reported state.
 *
 * Cost guard: only proposals matching `status === "Active" && endTs < now`
 * get probed. Normal active-and-not-yet-expired proposals pay zero RPC
 * cost. Zombies that have been in the stale state for hours pay one
 * callStatic per list invocation — negligible.
 */
async function probeExpiredActiveProposal(
  contractAddr: string,
  proposalId: string,
  provider: ethers.providers.Provider,
  abi: any = HybridVotingAbi,
): Promise<'announceable' | 'chain-ended' | 'unknown'> {
  try {
    const contract = new ethers.Contract(contractAddr, abi as any, provider);
    await contract.callStatic.announceWinner(proposalId);
    // No revert — announce would succeed → proposal is ready to announce.
    return 'announceable';
  } catch (err: any) {
    const msg = err?.reason || err?.error?.message || err?.message || '';
    if (msg.includes('AlreadyExecuted') || err?.errorName === 'AlreadyExecuted') {
      return 'chain-ended';
    }
    return 'unknown';
  }
}

/**
 * Format a unix timestamp as a relative time string from a reference now.
 * Returns "in 32m", "in 1h 45m", "expired 12m ago", "ended 3h 21m ago" depending on direction.
 *
 * Uses the chain's block.timestamp as `now`, NOT the agent's wall-clock time.
 * Locale-formatted absolute times (Date.toLocaleString) caused multiple
 * heartbeats of confusion this session — relative to chain time is unambiguous.
 */
function formatRelativeTime(endTs: number, nowTs: number): string {
  const diff = endTs - nowTs;
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  const dur = parts.join(' ');
  return diff > 0 ? `in ${dur}` : `expired ${dur} ago`;
}

interface ListArgs {
  org?: string;
  type?: string;
  status?: string;
  unvoted?: boolean;
  chain?: number;
  'private-key'?: string;
}

export const listHandler = {
  builder: (yargs: Argv) => yargs
    .option('type', { type: 'string', choices: ['hybrid', 'dd', 'all'], default: 'all', describe: 'Voting type filter' })
    .option('status', { type: 'string', choices: ['Active', 'Ended', 'Executed'], describe: 'Status filter' })
    .option('unvoted', { type: 'boolean', describe: 'Only show proposals where I have not voted (requires key)' }),

  handler: async (argv: ArgumentsCamelCase<ListArgs>) => {
    const spin = output.spinner('Fetching proposals...');
    spin.start();

    try {
      // Resolve signer address if --unvoted
      let myAddress: string | undefined;
      if (argv.unvoted) {
        const key = argv.privateKey as string || process.env.POP_PRIVATE_KEY;
        if (!key) {
          spin.stop();
          output.error('--unvoted requires a private key (set POP_PRIVATE_KEY or pass --private-key)');
          process.exit(1);
          return;
        }
        myAddress = new ethers.Wallet(key).address.toLowerCase();
      }

      const orgId = await resolveOrgId(argv.org, argv.chain);
      // A GraphQL document validates as a whole, so one unknown field fails the entire query.
      // Fall back to the pre-#195 field set rather than hard-failing (attribution columns render as '-' on the legacy tier).
      const { data: result } = await queryWithFieldFallback<any>([
        { query: FETCH_VOTING_DATA, variables: { orgId } },
        { query: FETCH_VOTING_DATA_LEGACY, variables: { orgId } },
      ], { chainId: argv.chain });
      const org = result.organization;

      // Fetch chain block.timestamp as the relative-time reference. Using
      // chain time (not Date.now()) means displayed countdowns line up with
      // what the contract sees — the same time used for VotingOpen checks.
      let chainNow = Math.floor(Date.now() / 1000);
      try {
        const networkConfig = resolveNetworkConfig(argv.chain);
        const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc, networkConfig.chainId);
        const block = await provider.getBlock('latest');
        chainNow = block.timestamp;
      } catch {
        // Fall back to wall clock if RPC unreachable
      }

      if (!org) {
        spin.stop();
        output.error('Organization not found');
        process.exit(1);
        return;
      }

      const rows: string[][] = [];
      let lagWarnings: Array<{ id: string; type: string; chainState: string }> = [];

      /**
       * Who created a proposal, as an IDENTITY or '-' — deliberately never an address.
       *
       * The subgraph derives `proposer` from transaction.from, which under POP's sponsored
       * ERC-4337 path is the BUNDLER, not the author (live Gnosis data: 3 of the 12 most recent
       * proposals are 0x4337-prefixed bundler addresses, and 11 of 12 resolve to no username).
       * Rendering that address here would assert a false author, so this stops at the username
       * exactly like the frontend (VotingContext.js) and `pop vote results`.
       *
       * '-' therefore means "no registered identity for the sender" — and, when it is '-' for
       * EVERY row, that the legacy query tier served the request and stripped the fields.
       * `pop vote results --proposal N --json` exposes the raw proposerAddress when needed.
       */
      function proposerLabel(p: any): string {
        return p.proposerUsername || p.creatorUsername || '-';
      }

      // Helper: check if address has voted on a proposal
      function hasVoted(proposal: any): boolean {
        if (!myAddress) return false;
        return (proposal.votes || []).some((v: any) => v.voter?.toLowerCase() === myAddress);
      }

      // Task #378 mitigation: share one provider for chain probes across
      // hybrid + dd loops. Reuse the same provider the chainNow fetch
      // already used if available.
      let probeProvider: ethers.providers.Provider | null = null;
      try {
        const networkConfig = resolveNetworkConfig(argv.chain);
        probeProvider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc, networkConfig.chainId);
      } catch {
        // Fall through — if no provider, the probe step is skipped.
      }

      // Hybrid proposals
      if (argv.type === 'all' || argv.type === 'hybrid') {
        const hybridContractAddr = org.hybridVoting?.id;
        const proposals = org.hybridVoting?.proposals || [];
        for (const p of proposals) {
          if (argv.status && p.status !== argv.status) continue;
          if (argv.unvoted && hasVoted(p)) continue;

          const endRelative = p.endTimestamp
            ? formatRelativeTime(parseInt(p.endTimestamp), chainNow)
            : '';
          const voteCount = (p.votes || []).length;

          let displayStatus = p.executionFailed ? 'ExecFailed' : p.status;
          let winnerDisplay = p.winningOption != null ? `#${p.winningOption}` : '-';

          // Task #378 probe: subgraph says Active but chain time has passed?
          // That's the stale-state signature. Run a cheap callStatic probe.
          const endTs = p.endTimestamp ? parseInt(p.endTimestamp) : 0;
          if (
            p.status === 'Active' &&
            endTs > 0 &&
            endTs < chainNow &&
            probeProvider &&
            hybridContractAddr
          ) {
            const chainState = await probeExpiredActiveProposal(
              hybridContractAddr,
              p.proposalId,
              probeProvider,
            );
            if (chainState === 'chain-ended') {
              displayStatus = 'Ended (chain)';
              lagWarnings.push({ id: p.proposalId, type: 'hybrid', chainState: 'executed' });
            } else if (chainState === 'announceable') {
              displayStatus = 'Announceable';
              lagWarnings.push({ id: p.proposalId, type: 'hybrid', chainState: 'ready' });
            }
            // 'unknown' = leave as-is, subgraph is probably right
          }

          rows.push([
            p.proposalId,
            'hybrid',
            p.title || p.metadata?.description?.substring(0, 40) || 'Untitled',
            proposerLabel(p),
            displayStatus,
            `${p.numOptions}`,
            `${voteCount}`,
            winnerDisplay,
            endRelative,
          ]);
        }
      }

      // DD proposals
      if (argv.type === 'all' || argv.type === 'dd') {
        const ddContractAddr = org.directDemocracyVoting?.id;
        const proposals = org.directDemocracyVoting?.ddvProposals || [];
        for (const p of proposals) {
          if (argv.status && p.status !== argv.status) continue;
          if (argv.unvoted && hasVoted(p)) continue;

          const endRelative = p.endTimestamp
            ? formatRelativeTime(parseInt(p.endTimestamp), chainNow)
            : '';
          const voteCount = (p.votes || []).length;

          let ddDisplayStatus = p.executionFailed ? 'ExecFailed' : p.status;

          // Task #378 mitigation extended to DD (HB#438). DD and hybrid both
          // expose `announceWinner(uint256)` on their contracts with matching
          // AlreadyExecuted() error signatures, so the same probe helper
          // works — just pass the DD ABI in.
          const ddEndTs = p.endTimestamp ? parseInt(p.endTimestamp) : 0;
          if (
            p.status === 'Active' &&
            ddEndTs > 0 &&
            ddEndTs < chainNow &&
            probeProvider &&
            ddContractAddr
          ) {
            const chainState = await probeExpiredActiveProposal(
              ddContractAddr,
              p.proposalId,
              probeProvider,
              DirectDemocracyVotingAbi,
            );
            if (chainState === 'chain-ended') {
              ddDisplayStatus = 'Ended (chain)';
              lagWarnings.push({ id: p.proposalId, type: 'dd', chainState: 'executed' });
            } else if (chainState === 'announceable') {
              ddDisplayStatus = 'Announceable';
              lagWarnings.push({ id: p.proposalId, type: 'dd', chainState: 'ready' });
            }
          }

          rows.push([
            p.proposalId,
            'dd',
            p.title || p.metadata?.description?.substring(0, 40) || 'Untitled',
            proposerLabel(p),
            ddDisplayStatus,
            `${p.numOptions}`,
            `${voteCount}`,
            p.winningOption != null ? `#${p.winningOption}` : '-',
            endRelative,
          ]);
        }
      }

      spin.stop();

      if (rows.length === 0) {
        output.info(argv.unvoted ? 'No unvoted proposals found' : 'No proposals found');
        return;
      }

      output.table(
        ['ID', 'Type', 'Title', 'By', 'Status', 'Options', 'Votes', 'Winner', 'Ends'],
        rows
      );

      // Footer: show the chain reference time so the relative-time column
      // is auditable. Block timestamp is what the contract sees.
      if (!output.isJsonMode()) {
        // Voting-validity parameters, labeled DISTINCTLY: support threshold
        // is a % of weighted power; quorum is a raw VOTER COUNT (since
        // PR #119 — not a percentage). Conflating them has caused real
        // mis-votes, so each line names its unit explicitly.
        const configLines: string[] = [];
        if ((argv.type === 'all' || argv.type === 'hybrid') && org.hybridVoting) {
          configLines.push(
            `hybrid — support threshold: ${org.hybridVoting.thresholdPct}% of weighted power | quorum: ${org.hybridVoting.quorum} voters (0 = disabled)`
          );
        }
        if ((argv.type === 'all' || argv.type === 'dd') && org.directDemocracyVoting) {
          configLines.push(
            `dd — support threshold: ${org.directDemocracyVoting.thresholdPct}% of weighted power | quorum: ${org.directDemocracyVoting.quorum} voters (0 = disabled)`
          );
        }
        if (configLines.length > 0) {
          console.log('');
          for (const line of configLines) console.log(`  ${line}`);
        }

        // Voting-class drift. Each proposal snapshots the HybridVoting classVersion it was
        // created under (subgraph #195), so a live config change mid-flight means the shown
        // threshold/quorum line is NOT the rule those proposals will be tallied against.
        const liveClassVersion = org.hybridVoting?.classVersion;
        if (liveClassVersion != null && (argv.type === 'all' || argv.type === 'hybrid')) {
          // Must apply the SAME filters the table above used, or the warning counts proposals
          // the operator cannot see (e.g. `--status Executed` reporting on Active ones).
          const stale = (org.hybridVoting?.proposals || []).filter(
            (p: any) => p.status === 'Active'
              && !(argv.status && p.status !== argv.status)
              && !(argv.unvoted && hasVoted(p))
              && p.classesVersion != null
              && String(p.classesVersion) !== String(liveClassVersion)
          );
          if (stale.length > 0) {
            // classVersion is a BLOCK NUMBER, and stale proposals nearly always share one, so
            // dedupe rather than repeating the same 8-digit value per proposal.
            const versions = [...new Set(stale.map((p: any) => String(p.classesVersion)))];
            console.log(
              `\n  ⚠️  ${stale.length} active proposal(s) were created under an older voting-class `
              + `config (v${versions.join(', v')} vs live v${liveClassVersion}).`
            );
            console.log('     Their class weights/strategies are the ones in force at creation.');
            console.log('     (Support threshold and quorum are separate live values, not versioned by this.)');
          }
        }

        const refIso = new Date(chainNow * 1000).toISOString();
        console.log(`\n  Chain time: ${refIso} (block.timestamp)`);

        // Task #378: warn when subgraph lag was detected + corrected.
        if (lagWarnings.length > 0) {
          console.log(
            `\n  ⚠️  Subgraph lag detected: ${lagWarnings.length} proposal(s) had stale Active state corrected from on-chain probe:`,
          );
          for (const w of lagWarnings) {
            console.log(`       #${w.id} (${w.type}) — chain state: ${w.chainState}`);
          }
          console.log(
            `     These proposals are CORRECTLY handled on-chain; the subgraph just hasn't indexed the announce/execute events yet.`,
          );
        }
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
