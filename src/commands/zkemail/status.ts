/**
 * pop zkemail status — ZK Email invite module state for an org.
 *
 * Surfaces the two states that silently break claims:
 *   - no module at all (org deployed without ZK Email)
 *   - module deployed but DORMANT (merkleRoot == 0 → every claim reverts AllowlistNotActive)
 * and cross-checks the committed root (indexed from ActiveAllowlistSet) against the root
 * declared inside the pinned allowlist file, which catches a swapped/unpinned CID before a
 * member hits it. Still two independent sources — chain event vs IPFS document — though
 * `pop zkemail allowlist --verify` is the stronger check: it recomputes the root from the
 * file's merkle tree rather than trusting the value the file declares.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveZkEmailModule, readModuleState, normalizeEntries } from './helpers';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface StatusArgs {
  org?: string;
  chain?: number;
}

export const statusHandler = {
  builder: (yargs: Argv) => yargs
    .example('pop zkemail status', 'Show the org\'s ZK Email invite module state')
    .example('pop zkemail status --json', 'Machine-readable module state for an agent'),

  handler: async (argv: ArgumentsCamelCase<StatusArgs>) => {
    const spin = output.spinner('Reading ZkEmailInvites module...');
    spin.start();

    try {
      const { orgId, orgName, address, subgraph } = await resolveZkEmailModule(argv.org, argv.chain);
      const state = await readModuleState(address, orgId, orgName, argv.chain, undefined, { subgraph, withWiring: true });

      const indexed = subgraph.activeAllowlist;
      const entries = normalizeEntries(indexed);
      const domains = entries.filter(e => e.entryType === 'domain').length;
      const emails = entries.filter(e => e.entryType === 'email').length;

      // The indexed doc's declared root must match the on-chain commit. A mismatch means the
      // pinned CID is not the file the root was computed from — claims will fail to prove.
      const indexedRoot: string | null = indexed?.root ?? null;
      const rootMatches = indexedRoot
        ? indexedRoot.toLowerCase() === state.merkleRoot.toLowerCase()
        : null;

      spin.stop();

      if (output.isJsonMode()) {
        output.json({
          orgId: state.orgId,
          orgName: state.orgName,
          module: state.address,
          dormant: state.dormant,
          merkleRoot: state.merkleRoot,
          allowlistCid: state.allowlistCid,
          allowlistCidDigest: state.allowlistCidDigest,
          allowlistIndexed: Boolean(indexed),
          indexedRoot,
          rootMatches,
          entryCount: entries.length,
          domainCount: domains,
          emailCount: emails,
          // Indexed since #197; undefined against an older deployment.
          claimCount: subgraph.claimCount ?? null,
          wiringSource: state.indexedWiring ? 'subgraph' : 'rpc',
          executor: state.executor,
          domainVerifier: state.domainVerifier,
          emailVerifier: state.emailVerifier,
          dkimRegistry: state.dkimRegistry,
          accountRegistry: state.accountRegistry,
          universalFactory: state.universalFactory,
        });
        return;
      }

      output.keyValueBlock(`ZK Email invites — ${state.orgName || state.orgId}`, {
        module: state.address,
        status: state.dormant ? 'DORMANT (no allowlist committed — all claims revert)' : 'active',
        merkleRoot: state.dormant ? '(unset)' : state.merkleRoot,
        allowlistCid: state.allowlistCid ?? '(unset)',
      });

      if (!state.dormant) {
        output.keyValueBlock('Active allowlist', {
          indexed: indexed ? 'yes' : 'no (IPFS file not yet indexed by the subgraph)',
          rootMatch: rootMatches === null ? 'unknown' : rootMatches ? 'ok' : 'MISMATCH',
          entries: `${entries.length} (${domains} domain, ${emails} specific address)`,
        });
        if (rootMatches === false) {
          output.warn(
            'The indexed allowlist file declares a different root than the on-chain commit. '
            + 'Members cannot produce valid proofs until the correct file is pinned. '
            + 'Re-run `pop zkemail build-allowlist` and re-publish.'
          );
        }
      }

      if (subgraph.claimCount != null) {
        output.keyValueBlock('Claims', { total: subgraph.claimCount });
      }

      output.keyValueBlock('Wiring', {
        executor: state.executor,
        domainVerifier: state.domainVerifier,
        emailVerifier: state.emailVerifier,
        dkimRegistry: state.dkimRegistry,
        accountRegistry: state.accountRegistry,
        universalFactory: state.universalFactory,
      });

      if (state.dormant) {
        output.info('Publish an allowlist: pop zkemail build-allowlist --file entries.json --pin');
      } else {
        output.info('Inspect entries: pop zkemail allowlist');
      }
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err?.message || String(err));
      process.exit(EXIT.USAGE);
    }
  },
};
