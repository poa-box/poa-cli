import type { Argv, ArgumentsCamelCase } from 'yargs';
import { parseDecimalAmountToRaw } from '@poa-box/core/amounts';
import { buildDonateToSolidarity } from '@poa-box/core/tx/paymaster';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { executeIntent } from '../../lib/tx';
import { resolvePaymasterInfra } from './helpers';
import * as output from '../../lib/output';
export const donateHandler = {
  builder: (y: Argv) => y.option('amount', { type: 'string', demandOption: true, describe: 'Exact native-token donation in human units' }),
  handler: async (argv: ArgumentsCamelCase<{ amount: string; chain?: number; dryRun?: boolean }>) => {
    try {
      const amountWei = parseDecimalAmountToRaw(argv.amount, 18);
      const ctx = await getWriteContext(argv, { needsOrg: false });
      const { paymasterHubAddress } = await resolvePaymasterInfra(ctx.chainId);
      const intent = buildDonateToSolidarity({ paymasterHubAddress, amountWei });
      await confirmWrite(argv, { amount: argv.amount, paymasterHub: paymasterHubAddress, chain: ctx.chainId }, { destructive: true, actionLabel: 'About to DONATE to the protocol solidarity fund' });
      const result = await executeIntent(ctx.signer, intent, { dryRun: argv.dryRun });
      finishWrite(result, { successMsg: 'Solidarity donation sent', fields: { amount: argv.amount, amountWei, paymasterHub: paymasterHubAddress } });
    } catch (error: any) { output.error(error.message); process.exitCode = 1; }
  },
};
