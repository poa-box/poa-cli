/**
 * Display Formatting Helpers
 * Pure functions for tokens, times, and USD amounts.
 * Time functions accept an injectable `now` (unix seconds) for testability.
 *
 * NOTE: statusColor (chalk-based) did NOT move here — it stays CLI-side.
 */

import { ethers } from 'ethers';

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function addThousandsSeparators(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format a wei-denominated amount as a human string, e.g. "12.5 PT".
 * Trims trailing zeros, adds thousands separators to the integer part,
 * shows at most 4 decimal places — unless the value is nonzero and
 * < 0.0001, in which case full precision is kept.
 */
export function formatToken(wei: ethers.BigNumberish, decimals = 18, symbol?: string): string {
  const raw = ethers.utils.formatUnits(wei, decimals);
  let [intPart, fracPart = ''] = raw.split('.');
  const negative = intPart.startsWith('-');
  if (negative) intPart = intPart.slice(1);
  fracPart = fracPart.replace(/0+$/, '');

  let frac = fracPart;
  if (fracPart.length > 4) {
    const isSubDust = /^0+$/.test(intPart) && /^0{4}/.test(fracPart);
    if (!isSubDust) {
      frac = fracPart.slice(0, 4).replace(/0+$/, '');
    }
  }

  let result = addThousandsSeparators(intPart) + (frac ? '.' + frac : '');
  if (negative && !/^0(\.0*)?$/.test(result)) result = '-' + result;
  return symbol ? `${result} ${symbol}` : result;
}

/** Bucket a positive elapsed/remaining span in seconds: s/m/h/d/mo. */
function bucket(seconds: number): string {
  const abs = Math.abs(Math.round(seconds));
  if (abs < 60) return `${abs}s`;
  if (abs < 3600) return `${Math.floor(abs / 60)}m`;
  if (abs < 86400) return `${Math.floor(abs / 3600)}h`;
  if (abs < 30 * 86400) return `${Math.floor(abs / 86400)}d`;
  return `${Math.floor(abs / (30 * 86400))}mo`;
}

/** "3h ago" for past timestamps, "in 2d" for future ones. */
export function formatRelativeTime(unixSecs: number | string, now: number = nowSecs()): string {
  const ts = Number(unixSecs);
  const diff = now - ts;
  if (diff >= 0) return `${bucket(diff)} ago`;
  return `in ${bucket(-diff)}`;
}

/** "2d 4h left" | "expired 3h ago" | "none" for a zero deadline. */
export function formatCountdown(deadlineUnixSecs: number, now: number = nowSecs()): string {
  if (deadlineUnixSecs === 0) return 'none';
  const remaining = deadlineUnixSecs - now;
  if (remaining <= 0) return `expired ${bucket(-remaining)} ago`;

  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m left`;
  return `${s}s left`;
}

/** "$1,234.50" */
export function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
