import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveOrgModules } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import { probeTaskOnChain } from './probe';
import * as output from '../../lib/output';

interface ProbeCliArgs {
  org?: string;
  taskId: string;
  'lookback-blocks'?: number;
  chain?: number;
  rpc?: string;
}

export const probeHandler = {
  builder: (yargs: Argv) =>
    yargs
      .positional('taskId', { type: 'string', describe: 'Task ID (decimal integer)', demandOption: true })
      .option('lookback-blocks', {
        type: 'number',
        default: 10000,
        describe: 'Block range to scan back from chain head (default 10000 ≈ 12h on Gnosis)',
      }),

  handler: async (argv: ArgumentsCamelCase<ProbeCliArgs>) => {
    const spin = output.spinner('Probing task on-chain...');
    spin.start();
    try {
      const networkConfig = await resolveNetworkConfig(argv.chain);
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const taskManagerAddr = modules.taskManagerAddress;
      if (!taskManagerAddr) {
        throw new Error('No TaskManager found for this org');
      }
      const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc);
      const lookback = (argv as any).lookbackBlocks ?? 10000;
      const probed = await probeTaskOnChain(taskManagerAddr, argv.taskId, provider, { lookbackBlocks: lookback });
      spin.stop();
      if (!probed) {
        output.error(
          `Task #${argv.taskId} not found in last ${lookback} blocks. Either the task does not exist, or its creation block is outside the lookback window. Retry with --lookback-blocks <larger>.`,
        );
        process.exit(2);
      }
      output.success('Task probed on-chain', probed);
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
