/**
 * pop zkemail allowlist — show the org's active ZK Email allowlist.
 *
 * Reads the indexed entries from the subgraph (fast, no IPFS round-trip) and verifies the
 * declared root against the on-chain commit. With --verify it additionally fetches the raw
 * IPFS doc and RECOMPUTES the merkle root from its tree dump, which is the only check that
 * proves the pinned file can actually produce valid claim proofs.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { resolveZkEmailModule, readModuleState, normalizeEntries, fetchRoleNames, labelHat } from './helpers';
import { assertRootMatches, summarize } from '../../lib/zkemail';
import { fetchJson } from '../../lib/ipfs';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface AllowlistArgs {
  org?: string;
  chain?: number;
  verify?: boolean;
}

export const allowlistHandler = {
  builder: (yargs: Argv) => yargs
    .option('verify', {
      type: 'boolean',
      default: false,
      describe: 'Fetch the allowlist file from IPFS and recompute its merkle root against the on-chain commit',
    })
    .example('pop zkemail allowlist', 'List who is invited and which roles they get')
    .example('pop zkemail allowlist --verify', 'Also prove the pinned file reproduces the on-chain root')
    .example('pop zkemail allowlist --json', 'Machine-readable entries'),

  handler: async (argv: ArgumentsCamelCase<AllowlistArgs>) => {
    const spin = output.spinner('Reading allowlist...');
    spin.start();

    try {
      const { orgId, orgName, address, subgraph } = await resolveZkEmailModule(argv.org, argv.chain);
      const state = await readModuleState(address, orgId, orgName, argv.chain, undefined, { subgraph });

      if (state.dormant) {
        spin.stop();
        throw new CliError(
          `Org "${orgName || orgId}" has a ZkEmailInvites module but no active allowlist.`,
          EXIT.PRECONDITION,
          'Publish one with: pop zkemail build-allowlist --file entries.json --pin'
        );
      }

      const entries = normalizeEntries(subgraph.activeAllowlist);
      const roleNames = await fetchRoleNames(orgId, argv.chain);

      let verified: { ok: boolean; detail: string } | null = null;
      if (argv.verify) {
        spin.text = 'Fetching allowlist from IPFS...';
        if (!state.allowlistCid) {
          throw new CliError('On-chain allowlist CID is unset, so there is nothing to verify.', EXIT.PRECONDITION);
        }
        const doc = await fetchJson<any>(state.allowlistCid);
        if (!doc) {
          throw new CliError(
            `Could not fetch allowlist ${state.allowlistCid} from IPFS.`,
            EXIT.INFRA,
            'The file may be unpinned. Members cannot claim until it is retrievable.'
          );
        }
        try {
          assertRootMatches(doc, state.merkleRoot);
          verified = { ok: true, detail: 'recomputed root matches the on-chain commit' };
        } catch (e: any) {
          verified = { ok: false, detail: e.message };
        }
      }

      spin.stop();

      if (output.isJsonMode()) {
        output.json({
          orgId,
          module: address,
          merkleRoot: state.merkleRoot,
          allowlistCid: state.allowlistCid,
          indexed: Boolean(subgraph.activeAllowlist),
          verified: verified ? verified.ok : null,
          verifyDetail: verified?.detail ?? null,
          entries: entries.map(e => ({
            ...e,
            hatNames: e.hatIds.map(h => roleNames.get(h) ?? null),
          })),
        });
        if (verified && !verified.ok) process.exit(EXIT.PRECONDITION);
        return;
      }

      if (!subgraph.activeAllowlist) {
        output.warn(
          'The active allowlist file is not indexed yet (the subgraph fetches it from IPFS asynchronously). '
          + 'Re-run shortly, or use --verify to read it directly from IPFS.'
        );
      }

      if (entries.length === 0) {
        output.info('No allowlist entries indexed.');
      } else {
        output.table(
          ['#', 'Type', 'Identifier', 'Grants'],
          entries.map(e => [
            String(e.index),
            e.entryType,
            e.identifier ?? (e.identifierHash ? `${e.identifierHash.slice(0, 14)}… (hash only)` : '(unknown)'),
            e.hatIds.map(h => labelHat(h, roleNames)).join(', '),
          ])
        );
        const s = summarize({ entries: entries.map(e => ({ type: e.entryType, identifier: e.identifier })) });
        output.keyValueBlock('Summary', {
          domains: s.domains.length ? s.domains.join(', ') : '(none)',
          specificAddresses: s.emails.length ? String(s.emails.length) : '(none)',
          merkleRoot: state.merkleRoot,
          allowlistCid: state.allowlistCid ?? '(unset)',
        });
      }

      if (verified) {
        if (verified.ok) {
          output.success(`Verified: ${verified.detail}`);
        } else {
          // --verify is an assertion, so it must fail the process — output.error only prints,
          // and a CI/heartbeat gate would otherwise pass while every claim is unprovable.
          output.error(`Verification FAILED: ${verified.detail}`);
          process.exit(EXIT.PRECONDITION);
        }
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
