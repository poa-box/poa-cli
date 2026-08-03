/**
 * Token configuration — moved to @poa/core/chains (shared with the frontend so
 * amount encoding can never drift). This shim keeps the historical CLI import
 * path and the `@poa/cli/config/tokens` subpath stable.
 */
export {
  PARTICIPATION_TOKEN_DECIMALS,
  getTokenByAddress,
  getTokenBySymbol,
  resolveTokenAddress,
  getTokenDecimals,
} from '@poa/core/chains';
export type { TokenInfo } from '@poa/core/chains';
