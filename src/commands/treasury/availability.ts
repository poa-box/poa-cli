import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createProvider } from '../../lib/signer';
import { resolveNetworkConfig } from '../../config/networks';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { resolvePayoutTokenInfo } from './helpers';
import { readTreasuryPlanningState, treasuryAvailability } from '../../lib/treasury-planning';
import * as output from '../../lib/output';

export const availabilityHandler = {
  builder: (y: Argv) => y.option('token', { type: 'string', default: 'native', describe: 'Payout token address or native' })
    .option('max-rounds', { type: 'number', default: 1000, describe: 'Maximum complete RPC distribution enumeration' }),
  handler: async (argv: ArgumentsCamelCase<{ org?: string; chain?: number; token: string; maxRounds: number }>) => {
    try {
      const modules = await resolveOrgModules(argv.org, argv.chain), config = resolveNetworkConfig(argv.chain);
      const provider = createProvider({ chainId: config.chainId });
      const address = argv.token === 'native' ? ethers.constants.AddressZero : ethers.utils.getAddress(argv.token);
      const token = await resolvePayoutTokenInfo(provider, address, config.chainId);
      const snapshot = await readTreasuryPlanningState({ provider, chainId: config.chainId, orgId: modules.orgId,
        paymentManager: requireModule(modules, 'paymentManagerAddress'), asset: { chainId: config.chainId, address, decimals: token.decimals }, maxRounds: argv.maxRounds });
      const availability = treasuryAvailability(snapshot);
      const result = { paymentManager: snapshot.source.contract, token, source: snapshot.source, coverage: snapshot.coverage, availability };
      if (output.isJsonMode()) output.json(result); else output.info(JSON.stringify(result, null, 2));
    } catch (error: any) { output.error(error.message); process.exitCode = 1; }
  },
};
