/**
 * x402 Payment Client
 *
 * Creates an x402-enabled fetch that automatically handles HTTP 402 responses
 * by signing micropayments with the agent's wallet. Uses the ERC-8004 identity
 * (same POP_PRIVATE_KEY) so the agent pays for its own API queries.
 *
 * Environment config:
 *   POP_PRIVATE_KEY     — agent wallet (required)
 *   X402_ENABLED        — kill switch, default "true" when key is set
 *   X402_MAX_PAYMENT    — max per-payment in token units, default "0.01"
 *   X402_FACILITATOR_URL — facilitator endpoint (optional, SDK handles defaults)
 */

import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

// Lazy-loaded singleton
let paidFetchInstance: typeof fetch | null = null;
let initialized = false;

/**
 * Create a configured x402Client from a private key.
 * Registers the ExactEvmScheme for all EVM networks (eip155:*).
 */
export function createX402Client(privateKey: Hex) {
  const { toClientEvmSigner, ExactEvmScheme } = require('@x402/evm');
  const { x402Client } = require('@x402/fetch');

  const account = privateKeyToAccount(privateKey);
  const signer = toClientEvmSigner(account);
  const scheme = new ExactEvmScheme(signer);

  const client = new x402Client();
  client.register('eip155:*', scheme);

  // Spending policy: reject payments above threshold
  const maxPayment = process.env.X402_MAX_PAYMENT || '0.01';
  client.registerPolicy({
    filter: () => true,
    check: (paymentRequirements: any) => {
      const amount = parseFloat(paymentRequirements.amount || '0');
      const limit = parseFloat(maxPayment);
      if (amount > limit) {
        return { ok: false, reason: `Payment ${amount} exceeds max ${limit}` };
      }
      return { ok: true };
    },
  });

  // Log payments for audit trail
  client.onAfterPaymentCreation((result: any) => {
    process.stderr.write(
      `[x402] payment signed: ${result?.paymentRequirements?.amount || '?'} ` +
      `${result?.paymentRequirements?.asset || '?'} on ${result?.paymentRequirements?.network || '?'}\n`
    );
  });

  client.onPaymentCreationFailure((error: any) => {
    process.stderr.write(`[x402] payment failed: ${error?.message || error}\n`);
  });

  return client;
}

/**
 * Get a fetch function that automatically handles 402 responses with micropayments.
 * Returns null if POP_PRIVATE_KEY is not set, X402_ENABLED is "false", or SDK is missing.
 * Lazy singleton — the client is created once and reused.
 */
export function getX402PaidFetch(): typeof fetch | null {
  if (initialized) return paidFetchInstance;
  initialized = true;

  try {
    // Kill switch
    if (process.env.X402_ENABLED === 'false') return null;

    const pk = process.env.POP_PRIVATE_KEY;
    if (!pk) return null;

    const privateKey: Hex = pk.startsWith('0x') ? (pk as Hex) : (`0x${pk}` as Hex);
    const client = createX402Client(privateKey);

    const { wrapFetchWithPayment } = require('@x402/fetch');
    paidFetchInstance = wrapFetchWithPayment(fetch, client);
    return paidFetchInstance;
  } catch {
    return null; // x402 SDK not installed or initialization error
  }
}
