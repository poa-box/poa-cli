/**
 * pop org update-metadata — update org name/metadata (DESTRUCTIVE).
 *
 * Gate — VERIFIED against contracts origin/main src/OrgRegistry.sol:
 * updateOrgMetaAsAdmin(orgId, newName, newMetadataHash) requires the caller
 * to wear the org's metadata-admin hat (metadataAdminHatOf[orgId], falling
 * back to the topHat when unset — revert NotOrgMetadataAdmin otherwise).
 * Change the admin hat itself with: pop org set-metadata-admin.
 *
 * The write is a full overwrite of name + metadata hash, so the current
 * metadata is fetched first and only the passed flags are merged over it.
 * Destructive confirmation: this rewrites the org's public identity;
 * non-TTY sessions must pass --yes explicitly.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson, pinFile } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { query } from '../../lib/subgraph';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../queries/infrastructure';
import { FETCH_ORG_FULL_DATA } from '../../queries/org';
import type { InfrastructureAddresses } from '../../queries/infrastructure';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import fs from 'fs';

interface UpdateMetadataArgs {
  org: string;
  name?: string;
  description?: string;
  logo?: string;
  links?: string;
  'background-color'?: string;
  'hide-treasury'?: boolean;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

/** "old → new" when changed, plain value otherwise (for the confirm summary). */
function delta(oldValue: string, newValue: string): string {
  return oldValue === newValue ? oldValue : `${oldValue} → ${newValue}`;
}

export const updateMetadataHandler = {
  builder: (yargs: Argv) => yargs
    .option('name', { type: 'string', describe: 'New org name' })
    .option('description', { type: 'string', describe: 'Org description' })
    .option('logo', { type: 'string', describe: 'Path to logo image file' })
    .option('links', { type: 'string', describe: 'JSON array of {name, url} links' })
    .option('background-color', { type: 'string', describe: 'Background color hex' })
    .option('hide-treasury', { type: 'boolean', describe: 'Hide treasury in UI' })
    .example('pop org update-metadata --description "New mission statement"', 'Update one field; everything else is preserved')
    .example('pop org update-metadata --name "New Name" --yes', 'Rename the org non-interactively'),

  handler: async (argv: ArgumentsCamelCase<UpdateMetadataArgs>) => {
    const spin = output.spinner('Reading current metadata...');
    spin.start();

    try {
      if (!argv.name && !argv.description && !argv.logo && !argv.links && argv.backgroundColor === undefined && argv.hideTreasury === undefined) {
        throw new CliError(
          'At least one metadata field must be provided.',
          EXIT.USAGE,
          'Available: --name, --description, --logo, --links, --background-color, --hide-treasury'
        );
      }

      const ctx = await getWriteContext(argv);

      // Resolve OrgRegistry address (global infrastructure, not an org module)
      const infra = await query<InfrastructureAddresses>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, argv.chain);
      const orgRegistryAddr = infra.poaManagerContracts?.[0]?.orgRegistryProxy;
      if (!orgRegistryAddr) {
        throw new CliError('Could not resolve OrgRegistry address from subgraph', EXIT.INFRA);
      }

      // Fetch existing metadata to preserve fields not being updated
      const existing = await query<{ organization: any }>(FETCH_ORG_FULL_DATA, { orgId: ctx.orgId }, argv.chain);
      const currentMeta = existing.organization?.metadata || {};
      const currentName = existing.organization?.name || '';

      // Upload logo to IPFS if provided
      let logoCid: string | null = null;
      if (argv.logo) {
        spin.text = 'Uploading logo to IPFS...';
        const logoBuffer = fs.readFileSync(argv.logo);
        logoCid = await pinFile(logoBuffer);
      }

      // Parse links if provided, otherwise keep existing
      let links = currentMeta.links || [];
      if (argv.links) {
        try {
          links = JSON.parse(argv.links);
        } catch {
          throw new CliError('--links must be valid JSON array: [{"name":"...","url":"..."}]', EXIT.USAGE);
        }
        links = links.map((l: any, i: number) => ({ ...l, index: i }));
      }

      // Build metadata JSON — merge provided flags over existing values.
      // Key order MUST match the frontend for subgraph/UI compatibility.
      const metadata: any = {
        description: argv.description !== undefined ? argv.description : (currentMeta.description || ''),
        links,
        template: currentMeta.template || 'default',
        logo: logoCid || currentMeta.logo || null,
        backgroundColor: argv.backgroundColor !== undefined ? argv.backgroundColor : (currentMeta.backgroundColor || null),
        hideTreasury: argv.hideTreasury !== undefined ? argv.hideTreasury : (currentMeta.hideTreasury || false),
      };

      // If --name not provided, keep the current name (full-overwrite write).
      const nameToSend = argv.name || currentName;

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        name: delta(currentName || '(unnamed)', nameToSend || '(unnamed)'),
        description: argv.description !== undefined
          ? delta(currentMeta.description || '(none)', argv.description)
          : undefined,
        logo: logoCid ? `re-pinned (${logoCid})` : undefined,
        links: argv.links !== undefined ? `${links.length} link(s)` : undefined,
        backgroundColor: argv.backgroundColor !== undefined
          ? delta(currentMeta.backgroundColor || '(none)', argv.backgroundColor)
          : undefined,
        hideTreasury: argv.hideTreasury !== undefined ? String(argv.hideTreasury) : undefined,
        org: argv.org,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to OVERWRITE org name + metadata' });

      const txSpin = output.spinner('Pinning metadata + sending transaction...');
      txSpin.start();
      const metaCid = await pinJson(JSON.stringify(metadata));
      const metadataHash = ipfsCidToBytes32(metaCid);
      const nameBytes = stringToBytes(nameToSend);

      const contract = createWriteContract(orgRegistryAddr, 'OrgRegistry', ctx.signer);
      const result = await executeTx(
        contract,
        'updateOrgMetaAsAdmin',
        [ctx.orgId, nameBytes, metadataHash],
        { dryRun: argv.dryRun }
      );
      txSpin.stop();

      finishWrite(result, {
        successMsg: 'Organization metadata updated',
        fields: {
          metadataCid: metaCid,
          logoCid,
          name: nameToSend || undefined,
        },
      });
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
