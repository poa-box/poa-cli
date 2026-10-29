import type { Argv } from 'yargs';
import { ethers } from 'ethers';
import { resolveIdentityAddress, createProvider } from '../../lib/signer';
import { resolveNetworkConfig } from '../../config/networks';
import { loadSubmission, recoverSubmission } from '../../lib/submission-recovery';
import * as output from '../../lib/output';

export function executionChainId(input?: number): number {
  const chainId = input ?? resolveNetworkConfig().chainId;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('--chain must be a positive safe integer chain ID');
  return chainId;
}
export function recoveryProvider(chainId: number, rpc?: string): ethers.providers.JsonRpcProvider {
  if (rpc) {
    const parsed = new URL(rpc);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('--rpc must be an HTTP(S) JSON-RPC endpoint');
    return new ethers.providers.JsonRpcProvider(rpc);
  }
  try { return createProvider({ chainId }); }
  catch { throw new Error('Recovery on a custom chain requires an explicit --rpc endpoint.'); }
}
export function registerExecutionCommands(yargs: Argv) {
  const builder = (y: Argv) => y.option('address', { type: 'string', describe: 'Account address; no signing key is needed' });
  return yargs.command('status', 'Inspect the saved submission for an account', builder, async argv => {
    try {
      const account = resolveIdentityAddress(argv, { required: true })!;
      const chainId = executionChainId(argv.chain as number | undefined);
      const record = loadSubmission(chainId, account) ?? null;
      if (output.isJsonMode()) output.json({ record }); else output.info(record ? JSON.stringify(record, null, 2) : 'No saved submission');
    } catch (error: any) { output.error(error.message); process.exitCode = 1; }
  }).command('recover', 'Reconcile a saved submission with bounded read-only RPC; never resends', y => builder(y)
    .option('max-blocks', { type: 'number', default: 16, describe: 'Prefix recovery window (1–64 blocks)' })
    .option('candidate-tx', { type: 'string', describe: 'Exact mined EOA candidate after the saved prefix window' })
    .option('abandon', { type: 'boolean', default: false, describe: 'Release only a provably pre-broadcast record; never an uncertain send' }), async argv => {
      try {
        const account = resolveIdentityAddress(argv, { required: true })!;
        const chainId = executionChainId(argv.chain as number | undefined);
        const provider = recoveryProvider(chainId, argv.rpc as string | undefined);
        if ((await provider.getNetwork()).chainId !== chainId) throw new Error('RPC_CHAIN_MISMATCH');
        const result = await recoverSubmission(chainId, account, provider, {
          maxBlocks: argv.maxBlocks as number, candidateTxHash: argv.candidateTx as string | undefined, abandon: argv.abandon as boolean,
          bundlerUrl: process.env.POP_BUNDLER_URL || (process.env.PIMLICO_API_KEY ? `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${process.env.PIMLICO_API_KEY}` : undefined),
        });
        if (output.isJsonMode()) output.json(result); else output.info(JSON.stringify(result, null, 2));
      } catch (error: any) { output.error(error.message); process.exitCode = 1; }
    }).demandCommand(1, 'Specify status or recover');
}
