/**
 * pop vote announce-all — batch-announce every ended proposal.
 *
 * Each candidate is pre-checked with callStatic.announceWinner so proposals
 * that would revert (already announced, quorum edge, …) are skipped without
 * burning gas. The whole batch is wrapped in withIdempotency: an identical
 * retry within the TTL returns the prior batch result instead of re-running
 * (runs that found nothing to announce return early and are never cached).
 * finishWrite is deliberately NOT used here — it renders exactly one
 * transaction, and this command reports N of them with its own summary.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createSigner } from '../../lib/signer';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { resolveOrgId } from '../../lib/resolve';
import { queryWithFieldFallback } from '../../lib/subgraph';
import { FETCH_VOTING_DATA, FETCH_VOTING_DATA_LEGACY } from '../../queries/voting';
import { withIdempotency } from '../../lib/command';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { resolveVotingContracts } from './helpers';

interface AnnounceAllArgs {
  org: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const announceAllHandler = {
  builder: (yargs: Argv) => yargs
    .option('idempotency-key', { type: 'string', describe: 'Explicit idempotency key for the batch (default: derived from argv).' })
    .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache and always re-run the batch.' }),

  handler: async (argv: ArgumentsCamelCase<AnnounceAllArgs>) => {
    const spin = output.spinner('Checking for ended proposals...');
    spin.start();

    try {
      const orgId = await resolveOrgId(argv.org, argv.chain);
      // A GraphQL document validates as a whole, so one unknown field fails the entire query.
      // Fall back to the pre-#195 field set rather than hard-failing (announcing must keep working against a pre-#195 subgraph).
      const { data: result } = await queryWithFieldFallback<any>([
        { query: FETCH_VOTING_DATA, variables: { orgId } },
        { query: FETCH_VOTING_DATA_LEGACY, variables: { orgId } },
      ], { chainId: argv.chain });
      const org = result.organization;

      if (!org) throw new Error('Organization not found');

      // Find all Ended proposals (not yet announced/executed)
      const toAnnounce: Array<{ id: string; type: 'hybrid' | 'dd'; title: string; retry: boolean }> = [];

      const now = Math.floor(Date.now() / 1000);

      // Find proposals that are ready to announce:
      // - Status "Ended" (subgraph updated), OR
      // - Status "Active" but endTimestamp has passed (subgraph hasn't updated yet)
      // Exclude "Executed" (already announced)
      const hybridProposals = org.hybridVoting?.proposals || [];
      for (const p of hybridProposals) {
        // A FAILED execution is not "done". Audit H-05 releases the in-flight `executed` lock
        // in the catch branch, so the proposal is re-announceable — but it already has a
        // winningOption (Winner is emitted regardless), so the plain already-announced test
        // would skip it forever and silently. Nothing else surfaces a stuck-but-fixable batch.
        const alreadyDone = (p.status === 'Executed' || p.winningOption != null) && !p.executionFailed;
        if (alreadyDone) continue;
        const ended = p.status === 'Ended' ||
          (p.status === 'Active' && p.endTimestamp && parseInt(p.endTimestamp) < now);
        if (ended) {
          toAnnounce.push({
            id: p.proposalId,
            type: 'hybrid',
            title: p.title || `Proposal #${p.proposalId}`,
            retry: Boolean(p.executionFailed),
          });
        }
      }

      const ddProposals = org.directDemocracyVoting?.ddvProposals || [];
      for (const p of ddProposals) {
        // Same H-05 retry case as hybrid above.
        const alreadyDone = (p.status === 'Executed' || p.winningOption != null) && !p.executionFailed;
        if (alreadyDone) continue;
        const ended = p.status === 'Ended' ||
          (p.status === 'Active' && p.endTimestamp && parseInt(p.endTimestamp) < now);
        if (ended) {
          toAnnounce.push({
            id: p.proposalId,
            type: 'dd',
            title: p.title || `DD Proposal #${p.proposalId}`,
            retry: Boolean(p.executionFailed),
          });
        }
      }

      if (toAnnounce.length === 0) {
        spin.stop();
        if (output.isJsonMode()) {
          output.json({ announced: 0, proposals: [] });
        } else {
          output.info('No ended proposals to announce');
        }
        return;
      }

      const contracts = await resolveVotingContracts(argv.org, argv.chain);
      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });

      const run = async (): Promise<Record<string, any>> => {
        spin.start();
        spin.text = `Announcing ${toAnnounce.length} proposal(s)...`;

        const results: Array<{ id: string; type: string; title: string; retry: boolean; success: boolean; txHash?: string; error?: string }> = [];

        for (const proposal of toAnnounce) {
          const isHybrid = proposal.type === 'hybrid';
          const contractAddr = isHybrid ? contracts.hybridVotingAddress : contracts.ddVotingAddress;
          if (!contractAddr) {
            results.push({ ...proposal, success: false, error: `No ${proposal.type} voting contract` });
            continue;
          }

          const abiName = isHybrid ? 'HybridVotingNew' : 'DirectDemocracyVotingNew';
          const contract = createWriteContract(contractAddr, abiName, signer);

          // Pre-check with callStatic to avoid wasting gas on reverts
          spin.text = `Checking #${proposal.id}...`;
          try {
            await contract.callStatic.announceWinner(proposal.id);
          } catch {
            // Would revert — skip (already announced, quorum not met, etc.)
            continue;
          }

          spin.text = `Announcing #${proposal.id}: ${proposal.title}...`;
          const txResult = await executeTx(contract, 'announceWinner', [proposal.id], { dryRun: argv.dryRun });

          if (txResult.success) {
            results.push({
              ...proposal,
              success: true,
              txHash: txResult.txHash,
            });
          } else {
            results.push({ ...proposal, success: false, error: txResult.error });
          }
        }

        spin.stop();

        const announced = results.filter(r => r.success).length;
        if (output.isJsonMode()) {
          output.json({ announced, proposals: results });
        } else {
          console.log('');
          for (const r of results) {
            if (r.success) {
              console.log(`  \x1b[32m✓\x1b[0m #${r.id} ${r.title}`);
            } else {
              console.log(`  \x1b[31m✗\x1b[0m #${r.id} ${r.title} — ${r.error}`);
            }
          }
          console.log(`\n  ${announced}/${results.length} proposals announced.`);
          console.log('');
        }
        return { announced, proposals: results };
      };

      spin.stop();

      // Dry runs simulate unconditionally — no idempotency consult/record.
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, orgId, 'vote.announce-all', run);
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
