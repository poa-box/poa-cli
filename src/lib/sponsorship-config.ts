/**
 * Sponsorship config resolution — CLI wrapper over @poa-box/core.
 *
 * Core's resolveSponsoredConfig takes an injected EnvSource; the CLI binds
 * process.env so every pre-extraction call site (tx.ts, preflight.ts, and the
 * agent's deep imports) keeps its zero-argument signature.
 */

import { resolveSponsoredConfig as coreResolveSponsoredConfig } from '@poa-box/core/sponsorship-config';
import type { SponsoredConfig } from '@poa-box/core/sponsorship-config';

export type { SponsoredConfig };

/**
 * Resolve sponsored config from environment variables. Returns undefined when
 * any required piece is missing. See @poa-box/core/sponsorship-config for the
 * semantics (POP_READONLY, POP_PRIVATE_KEY, POP_ORG_ID, POP_HAT_ID, and
 * PIMLICO_API_KEY | POP_BUNDLER_URL as the bundler requirement).
 */
export function resolveSponsoredConfig(): SponsoredConfig | undefined {
  return coreResolveSponsoredConfig(process.env);
}
