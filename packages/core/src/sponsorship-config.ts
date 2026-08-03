/**
 * Sponsorship config resolution (pure, env-injected).
 *
 * Kept in its own tiny module — with no viem/permissionless/network deps — so
 * both the tx layer (which sends sponsored transactions) and preflight logic
 * (which skips the gas-balance check for sponsored wallets) can import it
 * without a circular dependency, and so mocking the tx module in a test never
 * removes this function from preflight's reach.
 */
import { EnvSource, EMPTY_ENV } from './env';

/**
 * Structurally identical to viem's Hex. Declared locally so this module — and
 * everything that re-exports SponsoredConfig (the root barrel, preflight, the
 * plain-EOA executor) — never references viem's declarations: viem is an
 * OPTIONAL peer, and a skipLibCheck:false consumer without it must still
 * typecheck. Values flow to/from viem's Hex without casts.
 */
export type Hex = `0x${string}`;

export interface SponsoredConfig {
  privateKey: Hex;
  orgId: Hex;
  hatId: bigint;
}

/**
 * Bundler/RPC routing for the sponsored (4337/7702) send path. Lives here —
 * not in execute/sponsored — for the same optional-peer reason: TxOptions on
 * the plain-EOA executor references this type, and that executor must not
 * pull viem-typed declarations into its closure. execute/sponsored re-exports
 * it, so its historical import path keeps working.
 */
export interface SponsoredSendOptions {
  rpcUrl?: string;
  value?: bigint;
  pimlicoApiKey?: string;
  bundlerUrl?: string;
}

/**
 * Resolve sponsored config from the injected environment. Returns undefined
 * when any required piece is missing.
 *
 * A signing key + org + hat identify the subject; the bundler can be EITHER a
 * self-hosted endpoint (POP_BUNDLER_URL) OR Pimlico (PIMLICO_API_KEY) — mirror
 * of sendSponsored(), so a bundler URL alone is a complete setup. Requiring a
 * Pimlico key here would silently drop self-hosted-bundler users to direct EOA
 * transactions.
 */
export function resolveSponsoredConfig(env: EnvSource = EMPTY_ENV): SponsoredConfig | undefined {
  // Read-only mode: sponsorship is a signing capability (userops are signed
  // with the key) — report "not configured" so no 4337 path ever activates.
  if (env.POP_READONLY === '1') return undefined;
  const privateKey = env.POP_PRIVATE_KEY;
  const orgId = env.POP_ORG_ID;
  const hatId = env.POP_HAT_ID;
  const hasBundler = Boolean(env.PIMLICO_API_KEY || env.POP_BUNDLER_URL);

  if (!privateKey || !orgId || !hatId || !hasBundler) {
    return undefined;
  }

  return {
    privateKey: (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex,
    orgId: orgId as Hex,
    hatId: BigInt(hatId),
  };
}
