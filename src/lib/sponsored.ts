/**
 * EIP-7702 Gas Sponsorship — CLI wrapper over @poa-box/core/execute/sponsored.
 *
 * The userop construction (paymaster data encoding, v0.7 hash, dummy-signature
 * gas estimation, bundler submission) lives in core, environment-free. This
 * wrapper restores the CLI's env-driven bundler selection: POP_BUNDLER_URL for
 * a self-hosted bundler (task #425), else PIMLICO_API_KEY for Pimlico.
 */

import type { Hex, Address } from 'viem';
import { ethers } from 'ethers';
import { submissionIntentKey, submissionAuthorizationKey, reconcileSubmissionRecovery, type SubmissionRecoveryRecord } from '@poa-box/core/execute/recovery';
import { acquireSubmissionLock, startSubmission, transitionJournal, providerRecoveryReaders } from './submission-recovery';
import {
  sendSponsored as coreSendSponsored,
  EOA_DELEGATION,
  PAYMASTER_HUB,
  ENTRY_POINT,
  encodePaymasterData,
  isDelegated,
  delegateEOA as coreDelegateEOA,
  getUserOpHash,
  encodeCall,
} from '@poa-box/core/execute/sponsored';
import type { SponsoredSendOptions } from '@poa-box/core/execute/sponsored';

export {
  EOA_DELEGATION,
  PAYMASTER_HUB,
  ENTRY_POINT,
  encodePaymasterData,
  isDelegated,
  getUserOpHash,
  encodeCall,
};
export type { SponsoredSendOptions };

/**
 * Send a sponsored transaction via the bundler. Pre-extraction signature:
 * bundler routing falls back to env (POP_BUNDLER_URL, then PIMLICO_API_KEY)
 * when the options don't name one.
 */
export async function sendSponsored(
  privateKey: Hex,
  to: Address,
  data: Hex,
  orgId: Hex,
  hatId: bigint,
  options?: {
    rpcUrl?: string;
    value?: bigint;
    pimlicoApiKey?: string;
    bundlerUrl?: string;
  }
): Promise<{ txHash: Hex; userOpHash: Hex }> {
  if (process.env.POP_READONLY === '1') throw new Error('POP_READONLY=1 — sponsored submissions cannot sign or broadcast.');
  return coreSendSponsored(privateKey, to, data, orgId, hatId, {
    ...options,
    bundlerUrl: options?.bundlerUrl || process.env.POP_BUNDLER_URL || undefined,
    pimlicoApiKey: options?.pimlicoApiKey || process.env.PIMLICO_API_KEY || undefined,
  });
}

/** Delegation shares the durable account barrier with every CLI transaction.
 * The authorization digest distinguishes type-4 actions with identical self-call calldata. */
export async function delegateEOA(privateKey: Hex, rpcUrl?: string, options?: Parameters<typeof coreDelegateEOA>[2]): ReturnType<typeof coreDelegateEOA> {
  if (process.env.POP_READONLY === '1') throw new Error('POP_READONLY=1 — delegation cannot sign or broadcast.');
  const chainId = 100, account = new ethers.Wallet(privateKey).address;
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl || 'https://rpc.gnosischain.com');
  if ((await provider.getNetwork()).chainId !== chainId) throw new Error('Delegation RPC chain mismatch');
  const release = acquireSubmissionLock(chainId, account);
  let record: SubmissionRecoveryRecord | undefined;
  try {
    // Logical intent names the delegate; the prepared callKey below binds the
    // actual self-call, and authorizationKey binds its exact signed permission.
    record = startSubmission(chainId, account, { to: EOA_DELEGATION, data: '0x', value: '0' });
    const advance = (event: Parameters<typeof transitionJournal>[1]) => { record = transitionJournal(record!, event); };
    advance({ type: 'signing' });
    let transportError: unknown;
    try {
      const hash = await coreDelegateEOA(privateKey, rpcUrl, {
        onPrepared: async prepared => {
          if (prepared.chainId !== chainId || prepared.account.toLowerCase() !== account.toLowerCase()) throw new Error('Delegation preparation account or chain mismatch');
          advance({ type: 'prepare', kind: 'transaction', nonce: prepared.nonce, fromBlock: prepared.fromBlock,
            callKey: submissionIntentKey([{ to: account, data: '0x', value: '0' }]), authorizationKey: submissionAuthorizationKey(prepared.authorizationList) });
          await options?.onPrepared?.(prepared);
          advance({ type: 'broadcast' });
        },
        onSubmitted: async hash => { advance({ type: 'acknowledge', txHash: hash }); await options?.onSubmitted?.(hash); },
      });
      await provider.waitForTransaction(hash, 1, 120_000);
    } catch (error) { transportError = error; }
    if (['intent', 'signing', 'prepared'].includes(record.phase)) {
      advance({ type: 'abort' });
      throw transportError ?? new Error('Delegation transport did not establish a prepared submission');
    }
    const recovered = await reconcileSubmissionRecovery(record, providerRecoveryReaders(provider, undefined, true));
    if (recovered.outcome.status !== 'unknown') {
      advance({ type: 'settle', status: recovered.outcome.status });
      if (recovered.outcome.status === 'succeeded') return recovered.outcome.txHash as Hex;
    } else advance({ type: 'unresolved' });
    const failure: any = new Error(recovered.outcome.status === 'unknown'
      ? `Delegation outcome is unresolved (${recovered.outcome.code}); recover the account before trying again.`
      : `Delegation transaction ${recovered.outcome.status}.`);
    failure.result = { success: false, errorCode: recovered.outcome.status === 'unknown' ? 'UNKNOWN_ERROR' : 'TX_REVERTED',
      txHash: recovered.outcome.txHash ?? record.txHash,
      recovery: { account, chainId, phase: record.phase, nonce: record.nonce, authorizationKey: record.authorizationKey, txHash: record.txHash },
      suggestion: `pop execution recover --address ${account} --chain ${chainId}${rpcUrl ? ' --rpc <same-rpc-endpoint>' : ''}` };
    throw failure;
  } finally { release(); }
}
