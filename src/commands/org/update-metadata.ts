import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createSigner } from '../../lib/signer';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson, pinFile } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { query } from '../../lib/subgraph';
import { resolveOrgId } from '../../lib/resolve';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../queries/infrastructure';
import { FETCH_ORG_BY_ID, FETCH_ORG_FULL_DATA } from '../../queries/org';
import type { InfrastructureAddresses } from '../../queries/infrastructure';
import * as output from '../../lib/output';
import fs from 'fs';

interface UpdateMetadataArgs {
  org: string;
  name?: string;
  description?: string;
  logo?: string;
  links?: string;
  'update-link'?: string[];
  'background-color'?: string;
  'hide-treasury'?: boolean;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
}

export const updateMetadataHandler = {
  builder: (yargs: Argv) => yargs
    .option('name', { type: 'string', describe: 'New org name' })
    .option('description', { type: 'string', describe: 'Org description' })
    .option('logo', { type: 'string', describe: 'Path to logo image file' })
    .option('links', { type: 'string', describe: 'JSON array of {name, url} links. REPLACES the full link list. Use --update-link <name>:<url> instead for safe single-link patches without re-passing all existing links.' })
    .option('update-link', { type: 'string', array: true, describe: 'HB#749 (retro-1098 vigil-proposed update-metadata-merge-flag): single-link patch as "<name>:<url>". Preserves all other existing links. Pass multiple --update-link flags to patch multiple links in one tx. Mutually exclusive with --links.' })
    .option('background-color', { type: 'string', describe: 'Background color hex' })
    .option('hide-treasury', { type: 'boolean', describe: 'Hide treasury in UI' }),

  handler: async (argv: ArgumentsCamelCase<UpdateMetadataArgs>) => {
    const spin = output.spinner('Updating organization metadata...');
    spin.start();

    try {
      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });

      // Resolve OrgRegistry address
      const infra = await query<InfrastructureAddresses>(
        FETCH_INFRASTRUCTURE_ADDRESSES,
        {},
        argv.chain
      );

      const orgRegistryAddr = infra.poaManagerContracts?.[0]?.orgRegistryProxy;
      if (!orgRegistryAddr) {
        throw new Error('Could not resolve OrgRegistry address from subgraph');
      }

      const updateLinks = (argv.updateLink as string[] | undefined) ?? [];
      if (!argv.name && !argv.description && !argv.logo && !argv.links && updateLinks.length === 0 && argv.backgroundColor === undefined && argv.hideTreasury === undefined) {
        throw new Error('At least one metadata field must be provided (--name, --description, --logo, --links, --update-link, --background-color, or --hide-treasury)');
      }
      if (argv.links && updateLinks.length > 0) {
        throw new Error('--links and --update-link are mutually exclusive. Use --links to replace the full list, OR --update-link to patch individual links.');
      }

      // Resolve org ID early so we can fetch existing metadata
      const orgId = await resolveOrgId(argv.org, argv.chain);

      // Fetch existing metadata to preserve fields not being updated
      spin.text = 'Fetching current metadata...';
      const existing = await query<{ organization: any }>(
        FETCH_ORG_FULL_DATA,
        { orgId },
        argv.chain
      );
      const currentMeta = existing.organization?.metadata || {};

      // Upload logo to IPFS if provided
      let logoCid: string | null = null;
      if (argv.logo) {
        spin.text = 'Uploading logo to IPFS...';
        const logoBuffer = fs.readFileSync(argv.logo);
        logoCid = await pinFile(logoBuffer);
      }

      // Parse links if provided, otherwise keep existing
      let links = (currentMeta.links || []).map((l: any) => ({ name: l.name, url: l.url }));
      if (argv.links) {
        try {
          links = JSON.parse(argv.links);
        } catch {
          throw new Error('--links must be valid JSON array: [{"name":"...","url":"..."}]');
        }
        links = links.map((l: any, i: number) => ({ ...l, index: i }));
      } else if (updateLinks.length > 0) {
        // HB#749 (retro-1098 vigil-proposed): single-link patch path.
        // For each "<name>:<url>", upsert into the existing link list:
        // replace url if name exists (case-insensitive match), else append.
        for (const patch of updateLinks) {
          const colonIdx = patch.indexOf(':');
          if (colonIdx < 0) {
            throw new Error(`--update-link must be "<name>:<url>"; got: "${patch}"`);
          }
          const name = patch.slice(0, colonIdx).trim();
          const url = patch.slice(colonIdx + 1).trim();
          if (!name || !url) {
            throw new Error(`--update-link "<name>" and "<url>" both required; got: "${patch}"`);
          }
          const idx = links.findIndex((l: any) => l.name?.toLowerCase() === name.toLowerCase());
          if (idx >= 0) {
            links[idx] = { ...links[idx], url };
          } else {
            links.push({ name, url });
          }
        }
        links = links.map((l: any, i: number) => ({ ...l, index: i }));
      }

      // Build metadata JSON — merge provided flags over existing values
      const metadata: any = {
        description: argv.description !== undefined ? argv.description : (currentMeta.description || ''),
        links,
        template: currentMeta.template || 'default',
        logo: logoCid || currentMeta.logo || null,
        backgroundColor: argv.backgroundColor !== undefined ? argv.backgroundColor : (currentMeta.backgroundColor || null),
        hideTreasury: argv.hideTreasury !== undefined ? argv.hideTreasury : (currentMeta.hideTreasury || false),
      };

      spin.text = 'Pinning metadata to IPFS...';
      const metaCid = await pinJson(JSON.stringify(metadata));
      const metadataHash = ipfsCidToBytes32(metaCid);

      // If --name not provided, use current name from already-fetched org data
      const nameToSend = argv.name || existing.organization?.name || '';
      const nameBytes = stringToBytes(nameToSend);

      spin.text = 'Sending transaction...';
      const contract = createWriteContract(orgRegistryAddr, 'OrgRegistry', signer);
      const result = await executeTx(
        contract,
        'updateOrgMetaAsAdmin',
        [orgId, nameBytes, metadataHash],
        { dryRun: argv.dryRun }
      );

      spin.stop();

      if (result.success) {
        output.success('Organization metadata updated', {
          txHash: result.txHash, explorerUrl: result.explorerUrl,
          metadataCid: metaCid,
          logoCid: logoCid,
        });
      } else {
        output.error('Metadata update failed', { error: result.error, errorCode: result.errorCode });
        process.exit(2);
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
