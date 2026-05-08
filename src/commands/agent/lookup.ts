import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveNetworkConfig } from '../../config/networks';
import { lookupAgentById, lookupAgentByAddress } from '../../lib/erc8004';
import * as output from '../../lib/output';

interface LookupArgs {
  address?: string;
  id?: string;
  chain?: number;
  rpc?: string;
}

export const lookupHandler = {
  builder: (yargs: Argv) => yargs
    .option('address', { type: 'string', describe: 'Agent wallet address' })
    .option('id', { type: 'string', describe: 'Agent token ID (e.g. 3380)' })
    .check((argv) => {
      if (!argv.address && !argv.id) throw new Error('Provide --address or --id');
      return true;
    }),

  handler: async (argv: ArgumentsCamelCase<LookupArgs>) => {
    const spin = output.spinner('Looking up agent identity...');
    spin.start();

    try {
      const networkConfig = resolveNetworkConfig(argv.chain);
      const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc);

      let result;
      if (argv.id) {
        result = await lookupAgentById(argv.id as string, provider);
      } else {
        result = await lookupAgentByAddress(argv.address as string, provider);
        if (!result) {
          spin.stop();
          output.error(`No ERC-8004 identity found for ${argv.address}`);
          process.exit(1);
        }
      }

      spin.stop();

      if (output.isJsonMode()) {
        output.json(result);
      } else {
        console.log('');
        console.log(`  Agent Identity #${result.tokenId}`);
        console.log('  ' + '─'.repeat(40));
        console.log(`  Owner:    ${result.owner}`);
        console.log(`  URI:      ${result.uri}`);

        if (result.metadata) {
          const m = result.metadata;
          console.log(`  Name:     ${m.name}`);
          if (m.description) console.log(`  Desc:     ${m.description}`);
          if (m.capabilities?.length) console.log(`  Skills:   ${m.capabilities.join(', ')}`);
          if (m.protocols?.length) console.log(`  Protocols:${m.protocols.join(', ')}`);
          if (m.org) console.log(`  Org:      ${m.org.name} (${m.org.protocol})`);
          if (m.x402Support?.enabled) {
            console.log(`  x402:     enabled (${m.x402Support.supportedNetworks.join(', ')})`);
          }
          if (m.services?.length) {
            for (const s of m.services) {
              const loc = s.url || s.address || '';
              console.log(`  Service:  ${s.type} ${loc}`);
            }
          }
          console.log(`  Active:   ${m.active}`);
          if (m.registeredAt) console.log(`  Registered: ${m.registeredAt}`);
        } else {
          console.log('  Metadata: (could not resolve)');
        }
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
