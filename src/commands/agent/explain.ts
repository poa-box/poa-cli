/**
 * pop agent explain <txHash>
 *
 * Diagnostic: decode a transaction against POP's known contract ABIs.
 *
 * Fetches the receipt + input data from an RPC, tries to decode the call
 * against each ABI we ship, and reports what the transaction actually did —
 * function name, arguments, success/failure, revert reason, and any POP
 * events emitted. When the tx corresponds to a subgraph entity (proposal,
 * task, vouch), the output includes that context too.
 *
 * This complements the custom-error decoding in src/lib/tx.ts: that decodes
 * errors at execution time; this decodes any tx after the fact.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveNetworkConfig } from '../../config/networks';
import { loadAbi } from '../../lib/contracts';
import * as output from '../../lib/output';

// Cache Interfaces so we don't repeatedly reconstruct (and re-warn on) them.
// ethers v5 prints "duplicate definition - LengthMismatch()" warnings to
// stderr when loading ABIs that share error selectors. setLogLevel(OFF)
// causes infinite recursion in parseLog via logger.throwError, so we filter
// stderr around Interface construction instead — cosmetic warnings are
// suppressed but real errors still propagate via exceptions.
const ifaceCache = new Map<string, ethers.utils.Interface>();
function getIface(abiName: string): ethers.utils.Interface {
  let cached = ifaceCache.get(abiName);
  if (!cached) {
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
      const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() || '';
      if (s.startsWith('duplicate definition -')) return true;
      return origWrite(chunk, ...rest);
    };
    try {
      cached = new ethers.utils.Interface(loadAbi(abiName));
    } finally {
      (process.stderr as any).write = origWrite;
    }
    ifaceCache.set(abiName, cached);
  }
  return cached;
}

interface ExplainArgs {
  tx: string;
  chain?: number;
  rpc?: string;
}

const CANDIDATE_ABIS = [
  'HybridVotingNew',
  'DirectDemocracyVotingNew',
  'Executor',
  'TaskManagerNew',
  'ParticipationToken',
  'EducationHubNew',
  'QuickJoinNew',
  'PaymentManager',
  'OrgRegistry',
  'OrgDeployerNew',
  'UniversalAccountRegistry',
  'PaymasterHub',
  'EOADelegation',
  'ERC20',
];

interface DecodedCall {
  abi: string;
  name: string;
  args: Record<string, any>;
}

function tryDecodeCall(inputData: string): DecodedCall | null {
  if (!inputData || inputData === '0x') return null;
  for (const abiName of CANDIDATE_ABIS) {
    try {
      const iface = getIface(abiName);
      const parsed = iface.parseTransaction({ data: inputData });
      if (parsed) {
        const args: Record<string, any> = {};
        parsed.functionFragment.inputs.forEach((input, i) => {
          const v = parsed.args[i];
          args[input.name || `arg${i}`] = formatArg(v);
        });
        return { abi: abiName, name: parsed.name, args };
      }
    } catch { /* wrong ABI — try next */ }
  }
  return null;
}

function formatArg(v: any): any {
  if (v === null || v === undefined) return v;
  if (ethers.BigNumber.isBigNumber(v)) return v.toString();
  if (Array.isArray(v)) return v.map(formatArg);
  if (typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v)) {
      if (isNaN(Number(k))) out[k] = formatArg(v[k]);
    }
    return out;
  }
  return v;
}

function decodeLogs(logs: ethers.providers.Log[]): Array<{ abi: string; name: string; args: Record<string, any> }> {
  const decoded: Array<{ abi: string; name: string; args: Record<string, any> }> = [];
  for (const log of logs) {
    let matched = false;
    for (const abiName of CANDIDATE_ABIS) {
      if (matched) break;
      try {
        const iface = getIface(abiName);
        const parsed = iface.parseLog(log);
        if (parsed) {
          const args: Record<string, any> = {};
          parsed.eventFragment.inputs.forEach((input, i) => {
            args[input.name || `arg${i}`] = formatArg(parsed.args[i]);
          });
          decoded.push({ abi: abiName, name: parsed.name, args });
          matched = true;
        }
      } catch (e: any) {
        if (process.env.DEBUG_EXPLAIN) {
          process.stderr.write(`[explain] ${abiName} parseLog failed: ${e?.message?.slice(0, 80)}\n`);
        }
      }
    }
  }
  return decoded;
}

async function decodeRevertReason(
  provider: ethers.providers.Provider,
  txHash: string
): Promise<string | null> {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return null;
    // Re-execute the tx at its block to get the revert reason
    try {
      await provider.call(
        { to: tx.to, from: tx.from, data: tx.data, value: tx.value },
        tx.blockNumber
      );
      return null; // didn't revert on replay — odd
    } catch (err: any) {
      const data = err.data || err.error?.data || err.error?.error?.data;
      if (data && typeof data === 'string' && data.length >= 10) {
        // Try each ABI's custom errors
        for (const abiName of CANDIDATE_ABIS) {
          try {
            const iface = getIface(abiName);
            const decoded = iface.parseError(data);
            return `${abiName}.${decoded.name}()`;
          } catch { /* try next */ }
        }
        // Fallback: try Error(string) standard revert
        if (data.startsWith('0x08c379a0')) {
          const reason = ethers.utils.defaultAbiCoder.decode(
            ['string'],
            '0x' + data.slice(10)
          )[0];
          return `revert: ${reason}`;
        }
        return `unknown revert selector ${data.slice(0, 10)}`;
      }
      return err.reason || err.message?.slice(0, 200) || null;
    }
  } catch {
    return null;
  }
}

export const explainHandler = {
  builder: (yargs: Argv) => yargs
    .option('tx', { type: 'string', demandOption: true, describe: 'Transaction hash' }),

  handler: async (argv: ArgumentsCamelCase<ExplainArgs>) => {
    const spin = output.spinner('Fetching transaction...');
    spin.start();

    try {
      const config = resolveNetworkConfig(argv.chain);
      const rpcUrl = (argv.rpc as string) || config.resolvedRpc;
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

      const txHash = argv.tx;
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        throw new Error(`Invalid tx hash: ${txHash}`);
      }

      const [tx, receipt] = await Promise.all([
        provider.getTransaction(txHash),
        provider.getTransactionReceipt(txHash),
      ]);

      if (!tx) {
        throw new Error(`Transaction ${txHash} not found on chain ${config.chainId}`);
      }

      spin.text = 'Decoding call data...';
      const decodedCall = tryDecodeCall(tx.data || '0x');

      let revertReason: string | null = null;
      if (receipt && receipt.status === 0) {
        spin.text = 'Decoding revert reason...';
        revertReason = await decodeRevertReason(provider, txHash);
      }

      const decodedEvents = receipt ? decodeLogs(receipt.logs) : [];

      spin.stop();

      const explorerUrl = config.blockExplorer
        ? `${config.blockExplorer}/tx/${txHash}`
        : undefined;

      const summary = {
        txHash,
        chainId: config.chainId,
        from: tx.from,
        to: tx.to,
        value: tx.value.toString(),
        blockNumber: tx.blockNumber,
        status: receipt ? (receipt.status === 1 ? 'success' : 'reverted') : 'pending',
        gasUsed: receipt?.gasUsed?.toString(),
        revertReason,
        call: decodedCall,
        events: decodedEvents,
        explorerUrl,
      };

      if (argv.json) {
        output.json(summary);
      } else {
        console.log('');
        console.log(`  tx: ${txHash}`);
        console.log(`  chain: ${config.chainId} ${config.name ? '(' + config.name + ')' : ''}`);
        console.log(`  from: ${tx.from}`);
        console.log(`  to:   ${tx.to}`);
        console.log(`  status: ${summary.status}${receipt ? ' (block ' + tx.blockNumber + ', gas ' + receipt.gasUsed.toString() + ')' : ''}`);
        if (revertReason) {
          console.log(`  revert: ${revertReason}`);
        }
        if (decodedCall) {
          console.log(`\n  call: ${decodedCall.abi}.${decodedCall.name}(`);
          for (const [k, v] of Object.entries(decodedCall.args)) {
            const display = typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '...' : JSON.stringify(v);
            console.log(`    ${k}: ${display}`);
          }
          console.log(`  )`);
        } else {
          console.log(`\n  call: (unrecognized — input data did not match any POP ABI)`);
        }
        if (decodedEvents.length > 0) {
          console.log(`\n  events (${decodedEvents.length}):`);
          for (const ev of decodedEvents) {
            console.log(`    - ${ev.abi}.${ev.name}`);
          }
        }
        if (explorerUrl) console.log(`\n  explorer: ${explorerUrl}`);
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
