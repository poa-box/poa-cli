import type { Argv, ArgumentsCamelCase } from 'yargs';
import { requiredPrefundV07 } from '@poa-box/core/sponsorship/budget';
import * as output from '../../lib/output';
export const prefundHandler = {
  builder: (y: Argv) => y.option('operation', { type: 'string', demandOption: true, describe: 'JSON with final v0.7 gas limits and maxFeePerGas, all exact raw strings' }),
  handler: (argv: ArgumentsCamelCase<{ operation: string }>) => {
    try { const requiredPrefundRaw = requiredPrefundV07(JSON.parse(argv.operation));
      if (output.isJsonMode()) output.json({ requiredPrefundRaw }); else output.info(`Required prefund: ${requiredPrefundRaw} wei`);
    } catch (error: any) { output.error(error.message); process.exitCode = 1; }
  },
};
