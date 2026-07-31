/**
 * Sponsorship config resolution (pure, env-only).
 *
 * Kept in its own tiny module — with no viem/permissionless/network deps — so
 * both tx.ts (which sends sponsored transactions) and preflight.ts (which
 * skips the gas-balance check for sponsored wallets) can import it without a
 * circular dependency, and so mocking './tx' in a test never removes this
 * function from preflight's reach.
 */
import type { Hex } from 'viem';

export interface SponsoredConfig {
  privateKey: Hex;
  orgId: Hex;
  hatId: bigint;
}

/**
 * Resolve sponsored config from environment variables. Returns undefined when
 * any required piece is missing.
 *
 * A signing key + org + hat identify the subject; the bundler can be EITHER a
 * self-hosted endpoint (POP_BUNDLER_URL) OR Pimlico (PIMLICO_API_KEY) — mirror
 * of sendSponsored(), so a bundler URL alone is a complete setup. Requiring a
 * Pimlico key here would silently drop self-hosted-bundler users to direct EOA
 * transactions.
 */
export function resolveSponsoredConfig(): SponsoredConfig | undefined {
  // Read-only mode: sponsorship is a signing capability (userops are signed
  // with the key) — report "not configured" so no 4337 path ever activates.
  if (process.env.POP_READONLY === '1') return undefined;
  const privateKey = process.env.POP_PRIVATE_KEY;
  const orgId = process.env.POP_ORG_ID;
  const hatId = process.env.POP_HAT_ID;
  const hasBundler = Boolean(process.env.PIMLICO_API_KEY || process.env.POP_BUNDLER_URL);

  if (!privateKey || !orgId || !hatId || !hasBundler) {
    return undefined;
  }

  return {
    privateKey: (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex,
    orgId: orgId as Hex,
    hatId: BigInt(hatId),
  };
}
