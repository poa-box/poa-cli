/**
 * pop zkemail claims — who has claimed a role via a ZK Email invite.
 *
 * Indexed since subgraph-pop #197; before that the claim events were seen but every parameter
 * was discarded, so this history did not exist anywhere queryable.
 *
 * Two honesty constraints shape the output:
 *
 *   - `identifierHash` is the allowlist leaf the claim used, and allowlists get replaced. A
 *     claim made under a superseded root has a hash that resolves to nothing today, so it is
 *     labelled as such rather than being silently blanked or, worse, mismatched.
 *   - `nullifier` is absent on the passkey onboarding path, which does not emit it. On the live
 *     Gnosis module that is the majority of claims, so a missing nullifier is rendered as "n/a"
 *     for that path rather than as a gap in the data.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveZkEmailModule, normalizeEntries, fetchRoleNames, labelHat } from './helpers';
import { query } from '../../lib/subgraph';
import { FETCH_ZKEMAIL_CLAIMS } from '../../queries/zkemail';
import { formatRelativeTime } from '../../lib/format';
import { formatAddress } from '../../lib/encoding';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ClaimsArgs {
  org?: string;
  chain?: number;
  limit?: number;
}

export const claimsHandler = {
  builder: (yargs: Argv) => yargs
    .option('limit', { type: 'number', default: 50, describe: 'Maximum claims to show (most recent first)' })
    .example('pop zkemail claims', 'Who has claimed a role via a ZK Email invite')
    .example('pop zkemail claims --json', 'Full claim records for an agent'),

  handler: async (argv: ArgumentsCamelCase<ClaimsArgs>) => {
    const spin = output.spinner('Reading claim history...');
    spin.start();

    try {
      const { orgId, orgName, address, subgraph, indexedWiring } = await resolveZkEmailModule(argv.org, argv.chain);

      if (!indexedWiring) {
        throw new CliError(
          'This chain\'s subgraph does not index ZK Email claim history yet.',
          EXIT.PRECONDITION,
          'Claim history landed in subgraph-pop #197. Until that deployment is live here, the '
            + 'claim events are seen but their parameters are not retained, so there is nothing to read.'
        );
      }

      const res = await query<{ zkEmailClaims: any[] }>(
        FETCH_ZKEMAIL_CLAIMS,
        { module: address.toLowerCase(), first: Math.max(1, Math.min(1000, argv.limit ?? 50)) },
        argv.chain
      );
      const claims = res.zkEmailClaims ?? [];

      // Map the active allowlist's leaf ids back to human identifiers. Claims made under a
      // superseded root will not be in here — that is expected, not an error.
      const activeById = new Map<string, string>();
      for (const e of normalizeEntries(subgraph.activeAllowlist)) {
        if (e.identifierHash && e.identifier) activeById.set(e.identifierHash.toLowerCase(), e.identifier);
      }
      // Domain entries carry no identifierHash in the schema, so recompute from the identifier.
      const { domainHash } = await import('../../lib/zkemail');
      for (const e of normalizeEntries(subgraph.activeAllowlist)) {
        if (e.entryType === 'domain' && e.identifier) {
          activeById.set(domainHash(e.identifier).toLowerCase(), e.identifier);
        }
      }

      const roleNames = await fetchRoleNames(orgId, argv.chain);
      spin.stop();

      const rows = claims.map((c) => {
        const via = activeById.get(String(c.identifierHash).toLowerCase());
        return {
          ...c,
          // null = the leaf is not in the CURRENT allowlist (claimed under an older root).
          resolvedIdentifier: via ?? null,
          onboarding: c.nullifier == null,
        };
      });

      if (output.isJsonMode()) {
        output.json({
          orgId,
          module: address,
          claimCount: subgraph.claimCount ?? rows.length,
          claims: rows.map((c) => ({
            id: c.id,
            kind: c.kind,
            claimer: c.claimer,
            claimerUsername: c.claimerUsername ?? null,
            identifierHash: c.identifierHash,
            resolvedIdentifier: c.resolvedIdentifier,
            hatIds: c.hatIds,
            hatNames: (c.hatIds ?? []).map((h: string) => roleNames.get(ethers.BigNumber.from(h).toString()) ?? null),
            // Absent on the onboarding path — see the module docstring.
            nullifier: c.nullifier ?? null,
            registeredUsername: c.registeredUsername ?? null,
            viaOnboarding: c.onboarding,
            claimedAt: Number(c.claimedAt),
            transactionHash: c.transactionHash,
          })),
        });
        return;
      }

      if (rows.length === 0) {
        output.info(`No ZK Email claims recorded for ${orgName || orgId}.`);
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      output.table(
        ['When', 'Claimer', 'Via', 'Invited by', 'Grants', 'Path'],
        rows.map((c) => [
          formatRelativeTime(Number(c.claimedAt), now),
          c.claimerUsername || formatAddress(c.claimer),
          c.kind === 'Domain' ? 'domain' : 'address',
          c.resolvedIdentifier ?? `${String(c.identifierHash).slice(0, 12)}… (not in current allowlist)`,
          (c.hatIds ?? []).map((h: string) => labelHat(h, roleNames)).join(', '),
          c.onboarding ? `onboarding${c.registeredUsername ? ` (registered "${c.registeredUsername}")` : ''}` : 'claim',
        ])
      );

      const superseded = rows.filter((c) => c.resolvedIdentifier === null).length;
      if (superseded > 0) {
        output.info(
          `${superseded} claim(s) used an allowlist entry that is not in the current allowlist — `
          + 'they were made under an earlier root.'
        );
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
