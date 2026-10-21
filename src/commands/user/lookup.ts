import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readIdentityFacts, type IdentitySelector } from '@poa-box/core/reads/identity';
import { readCredentialFacts, projectCredentialFacts } from '@poa-box/core/reads/protocol';
import { requireAddress } from '@poa-box/core/validation';
import { createIndexedSource } from '../../lib/indexed-source';
import { resolveNetworkConfig } from '../../config/networks';
import * as output from '../../lib/output';
import { EXIT } from '../../lib/exit-codes';

interface LookupArgs { chain?: number; registry: string[]; account?: string[]; username?: string[]; search?: string; pageSize: number; maxPages: number }
export const lookupHandler = {
  builder: (yargs: Argv) => yargs
    .option('registry', { type: 'string', array: true, demandOption: true, describe: 'Explicit registry address(es) on the selected chain' })
    .option('account', { type: 'string', array: true, describe: 'Exact account address(es)' })
    .option('username', { type: 'string', array: true, describe: 'Exact username(s)' })
    .option('search', { type: 'string', describe: 'Username substring; ranking remains host-owned' })
    .option('page-size', { type: 'number', default: 100, describe: 'Rows per page (1–1000)' })
    .option('max-pages', { type: 'number', default: 100, describe: 'Maximum pages per registry' }),
  handler: async (argv: ArgumentsCamelCase<LookupArgs>) => {
    try {
      if ([argv.account !== undefined, argv.username !== undefined, argv.search !== undefined].filter(Boolean).length !== 1) throw new Error('Choose exactly one of --account, --username or --search');
      const chainId = resolveNetworkConfig(argv.chain).chainId;
      const registries = argv.registry.map(value => requireAddress(value, 'registry'));
      if (new Set(registries.map(value => value.toLowerCase())).size !== registries.length) throw new Error('Duplicate registry');
      const host = await createIndexedSource({ chainId });
      const sources = registries.map(contract => ({ ...host.source, contract }));
      const selector: IdentitySelector = argv.account ? { kind: 'addresses', addresses: argv.account }
        : argv.username ? { kind: 'names', names: argv.username } : { kind: 'search', query: argv.search! };
      output.json(await readIdentityFacts({ sources, selector, query: host.protocolQuery, pageSize: argv.pageSize, maxPages: argv.maxPages }));
    } catch (err: any) { output.error(err?.message || String(err)); process.exit(EXIT.USAGE); }
  },
};

export const credentialsHandler = {
  builder: (yargs: Argv) => yargs
    .option('account', { type: 'string', describe: 'Account whose credentials should be listed (includes revoked rows)' })
    .option('credential', { type: 'string', describe: 'Exact bytes32 credential digest to discover' })
    .option('page-size', { type: 'number', default: 100, describe: 'Rows per page (1–1000)' })
    .option('max-pages', { type: 'number', default: 100, describe: 'Maximum pages' }),
  handler: async (argv: ArgumentsCamelCase<{ chain?: number; account?: string; credential?: string; pageSize: number; maxPages: number }>) => {
    try {
      if ((argv.account !== undefined) === (argv.credential !== undefined)) throw new Error('Choose exactly one of --account or --credential');
      const chainId = resolveNetworkConfig(argv.chain).chainId;
      const host = await createIndexedSource({ chainId, ...(argv.account ? { account: requireAddress(argv.account, 'account') } : {}) });
      const facts = await readCredentialFacts({ source: host.source, query: host.protocolQuery,
        credentialId: argv.credential, pageSize: argv.pageSize, maxPages: argv.maxPages });
      output.json({ ...facts, credentials: facts.data.map(row => projectCredentialFacts(row, facts.source)) });
    } catch (err: any) { output.error(err?.message || String(err)); process.exit(EXIT.USAGE); }
  },
};
