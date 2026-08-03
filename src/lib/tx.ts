/**
 * Transaction Execution — CLI wrapper over @poa/core/execute.
 *
 * The full pipeline (gas estimation as revert prediction, dry-run calldata,
 * EIP-7702 sponsored routing with EOA fallback, receipt-log parsing, error
 * classification/decoding) lives in @poa/core/execute/ethers and is
 * environment-free. This wrapper restores the CLI's implicit env behavior:
 *
 *   - sponsorship auto-resolves from env (POP_PRIVATE_KEY/POP_ORG_ID/POP_HAT_ID
 *     + PIMLICO_API_KEY|POP_BUNDLER_URL) when options.sponsored is not given
 *   - bundler routing comes from POP_BUNDLER_URL / PIMLICO_API_KEY
 *   - POP_LEGACY_DRYRUN_TXHASH=1 keeps the legacy dry-run txHash field
 *
 * executeTx keeps its pre-extraction signature for every command and for
 * @poa/agent's `@poa/cli/lib/tx` deep import.
 */

import { ethers } from 'ethers';
import {
  executeContractTx,
  executeIntent as coreExecuteIntent,
  classifyError,
  detectUserOpFailure,
  parseEventLogs,
} from '@poa/core/execute/ethers';
import type { TxResult, TxOptions as CoreTxOptions, ErrorCode, ClassifiedError } from '@poa/core/execute/ethers';
import type { TxIntent } from '@poa/core/tx/intent';
import { resolveSponsoredConfig } from './sponsorship-config';
import type { SponsoredConfig } from './sponsorship-config';

// Re-exported for backward compatibility — canonical home is sponsorship-config.
export { resolveSponsoredConfig };
export type { SponsoredConfig };

export { classifyError, detectUserOpFailure, parseEventLogs };
export type { TxResult, ErrorCode, ClassifiedError };

export interface TxOptions {
  dryRun?: boolean;
  gasLimit?: number;
  value?: ethers.BigNumber;
  sponsored?: SponsoredConfig;
}

function withCliEnv(options: TxOptions): CoreTxOptions {
  return {
    ...options,
    // Explicit config wins; otherwise auto-resolve from env exactly as before.
    // A THUNK, not a value: core invokes it inside its try/catch after the
    // dry-run short-circuit, so a malformed POP_HAT_ID yields a classified
    // TxResult on live writes and never touches --dry-run (pre-extraction
    // ordering — resolveSponsoredConfig ran inside executeTx's try block).
    sponsored: options.sponsored || (() => resolveSponsoredConfig()),
    sponsoredSend: {
      bundlerUrl: process.env.POP_BUNDLER_URL || undefined,
      pimlicoApiKey: process.env.PIMLICO_API_KEY || undefined,
    },
    legacyDryRunTxHash: process.env.POP_LEGACY_DRYRUN_TXHASH === '1',
  };
}

/**
 * Execute a contract method.
 * In dry-run mode: estimates gas and encodes calldata without sending.
 * When sponsored config is available (explicit or from env) and the EOA is
 * delegated, routes through the PaymasterHub for gas sponsorship, falling back
 * to a direct EOA tx. Returns parsed event logs so callers can extract entity IDs.
 */
export async function executeTx(
  contract: ethers.Contract,
  method: string,
  args: any[],
  options: TxOptions = {}
): Promise<TxResult> {
  return executeContractTx(contract, method, args, withCliEnv(options));
}

/**
 * Execute a @poa/core TxIntent with the same CLI env bindings as executeTx.
 * New code should prefer building intents (tx/<domain> in @poa/core) and
 * executing them here.
 */
export async function executeIntent(
  signer: ethers.Signer,
  intent: TxIntent,
  options: TxOptions = {}
): Promise<TxResult> {
  return coreExecuteIntent(signer, intent, withCliEnv(options));
}
