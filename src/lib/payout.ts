/**
 * Task payout + token-label conventions.
 *
 * Port of the frontend's `poa-app/src/util/taskUtils.js` (payout math, 15-minute time helpers)
 * and `src/util/tokenLabel.js` (token label). None of this is enforced on-chain — TaskManager
 * stores whatever payout it is handed — so it is a shared CONVENTION between the UI and the
 * CLI. Diverging here produces tasks that look mispriced in the app next to identical ones
 * created in the browser, which is why the numbers are copied rather than re-derived.
 *
 * Two payout modes:
 *   - default:    difficulty-weighted, base + multiplier x estimated hours
 *   - hours-only: the org sets `taskPayoutHoursOnly` in its metadata; difficulty is ignored
 *                 and payout is simply rate x estimated hours
 */

/**
 * Difficulty configuration for payout calculation.
 * base payout + (multiplier * estimated hours) = total payout.
 */
export const DIFFICULTY_CONFIG: Record<string, { base: number; multiplier: number }> = {
  easy: { base: 1, multiplier: 16.5 },
  medium: { base: 4, multiplier: 24 },
  hard: { base: 10, multiplier: 30 },
  veryHard: { base: 25, multiplier: 37.5 },
};

/** Tokens-per-hour default for orgs that opt into hours-only payouts. */
export const DEFAULT_HOURLY_RATE = 10;

/** Orgs default to "Shares" unless they opt into the token's on-chain symbol. */
export const DEFAULT_TOKEN_LABEL = 'Shares';

export const MINUTES_STEP = 15;

export interface PayoutConfig {
  hoursOnly?: boolean;
  hourlyRate?: number | string | null;
}

/** Normalize a configured hourly rate to a positive finite number. */
export function normalizeHourlyRate(value: unknown): number {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_HOURLY_RATE;
}

/**
 * Calculate a task payout the same way the web app does.
 *
 * An unknown difficulty falls back to `medium` rather than throwing, matching the frontend —
 * the CLI accepts free-text --difficulty and older tasks carry values no longer in the config.
 */
export function calculatePayout(
  difficulty: string | undefined,
  estimatedHours: number,
  payoutConfig?: PayoutConfig
): number {
  const hours = Number(estimatedHours) || 0;
  if (payoutConfig?.hoursOnly) {
    return Math.round(normalizeHourlyRate(payoutConfig.hourlyRate) * hours);
  }
  const config = DIFFICULTY_CONFIG[difficulty as string];
  if (!config) return calculatePayout('medium', hours);
  return Math.round(config.base + config.multiplier * hours);
}

/**
 * Resolve the user-facing label for an org's participation token.
 * `useTokenSymbol` is an OrgMetadata flag; without it every amount reads as "Shares".
 */
export function resolveTokenLabel(args?: { useTokenSymbol?: boolean; symbol?: string | null }): string {
  const { useTokenSymbol, symbol } = args || {};
  if (useTokenSymbol === true && symbol && typeof symbol === 'string' && symbol.trim()) {
    return symbol.trim();
  }
  return DEFAULT_TOKEN_LABEL;
}

/**
 * Format decimal hours as a compact "1h 30m" / "45m" / "2h" label.
 *
 * Durations are stored as decimal hours (0.25 = 15 min); hours-only orgs enter and read them
 * in 15-minute steps, so "0.25 hrs" is the wrong unit to show those members.
 */
export function formatEstTime(hours: number | string): string {
  const totalMin = Math.round(Number(hours) * 60);
  if (!Number.isFinite(totalMin) || totalMin <= 0) return '0m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Read an org's payout convention out of its OrgMetadata (subgraph entity or raw IPFS doc). */
export function payoutConfigFromMetadata(metadata: any): PayoutConfig & { useTokenSymbol: boolean } {
  return {
    hoursOnly: metadata?.taskPayoutHoursOnly === true,
    // BigDecimal arrives from the subgraph as a string; normalizeHourlyRate coerces it.
    hourlyRate: metadata?.taskPayoutHourlyRate ?? null,
    useTokenSymbol: metadata?.useTokenSymbol === true,
  };
}
