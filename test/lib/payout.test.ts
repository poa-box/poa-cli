import { describe, it, expect } from 'vitest';
import {
  DIFFICULTY_CONFIG,
  DEFAULT_HOURLY_RATE,
  DEFAULT_TOKEN_LABEL,
  normalizeHourlyRate,
  calculatePayout,
  resolveTokenLabel,
  formatEstTime,
  payoutConfigFromMetadata,
} from '../../src/lib/payout';

/**
 * These pin CLI/UI parity. The numbers come from the frontend's
 * poa-app/src/util/taskUtils.js — a task priced by `pop task create` must match one priced
 * in the browser for the same difficulty/hours, or the board shows two prices for one policy.
 */
describe('DIFFICULTY_CONFIG — frontend parity', () => {
  it('matches the frontend table exactly', () => {
    expect(DIFFICULTY_CONFIG).toEqual({
      easy: { base: 1, multiplier: 16.5 },
      medium: { base: 4, multiplier: 24 },
      hard: { base: 10, multiplier: 30 },
      veryHard: { base: 25, multiplier: 37.5 },
    });
    expect(DEFAULT_HOURLY_RATE).toBe(10);
    expect(DEFAULT_TOKEN_LABEL).toBe('Shares');
  });
});

describe('calculatePayout — difficulty-weighted (default mode)', () => {
  it('is base + multiplier * hours, rounded', () => {
    expect(calculatePayout('easy', 2)).toBe(Math.round(1 + 16.5 * 2)); // 34
    expect(calculatePayout('medium', 3)).toBe(Math.round(4 + 24 * 3)); // 76
    expect(calculatePayout('hard', 1)).toBe(40);
    expect(calculatePayout('veryHard', 2)).toBe(100);
  });

  it('rounds fractional results', () => {
    // 1 + 16.5 * 1.5 = 25.75 -> 26
    expect(calculatePayout('easy', 1.5)).toBe(26);
  });

  it('falls back to medium for an unknown or missing difficulty', () => {
    expect(calculatePayout('bogus', 2)).toBe(calculatePayout('medium', 2));
    expect(calculatePayout(undefined, 2)).toBe(calculatePayout('medium', 2));
  });

  it('treats a non-numeric or zero hour count as zero hours', () => {
    expect(calculatePayout('medium', 0)).toBe(4);
    expect(calculatePayout('medium', NaN as any)).toBe(4);
  });
});

describe('calculatePayout — hours-only mode', () => {
  it('ignores difficulty entirely and uses rate * hours', () => {
    const cfg = { hoursOnly: true, hourlyRate: 12.5 };
    expect(calculatePayout('easy', 4, cfg)).toBe(50);
    // Difficulty must make no difference in this mode.
    expect(calculatePayout('veryHard', 4, cfg)).toBe(50);
  });

  it('defaults the rate when missing, zero, negative, or unparseable', () => {
    for (const rate of [null, undefined, 0, -5, 'abc']) {
      expect(calculatePayout('medium', 3, { hoursOnly: true, hourlyRate: rate as any })).toBe(30);
    }
  });

  it('accepts a BigDecimal-as-string rate, the shape the subgraph returns', () => {
    expect(calculatePayout('medium', 2, { hoursOnly: true, hourlyRate: '12.5' })).toBe(25);
  });

  it('handles 15-minute increments', () => {
    expect(calculatePayout('medium', 0.25, { hoursOnly: true, hourlyRate: 20 })).toBe(5);
    expect(calculatePayout('medium', 1.5, { hoursOnly: true, hourlyRate: 10 })).toBe(15);
  });

  it('is NOT applied when hoursOnly is false or absent', () => {
    expect(calculatePayout('medium', 3, { hoursOnly: false, hourlyRate: 100 })).toBe(76);
    expect(calculatePayout('medium', 3, {})).toBe(76);
  });
});

describe('normalizeHourlyRate', () => {
  it('keeps positive finite values and defaults everything else', () => {
    expect(normalizeHourlyRate(12.5)).toBe(12.5);
    expect(normalizeHourlyRate('7')).toBe(7);
    expect(normalizeHourlyRate(0)).toBe(DEFAULT_HOURLY_RATE);
    expect(normalizeHourlyRate(-1)).toBe(DEFAULT_HOURLY_RATE);
    expect(normalizeHourlyRate(Infinity)).toBe(DEFAULT_HOURLY_RATE);
    expect(normalizeHourlyRate(null)).toBe(DEFAULT_HOURLY_RATE);
  });
});

describe('resolveTokenLabel', () => {
  it('only uses the symbol when the org opted in AND a symbol exists', () => {
    expect(resolveTokenLabel({ useTokenSymbol: true, symbol: 'REP' })).toBe('REP');
    expect(resolveTokenLabel({ useTokenSymbol: true, symbol: '  REP  ' })).toBe('REP');
    expect(resolveTokenLabel({ useTokenSymbol: false, symbol: 'REP' })).toBe('Shares');
    expect(resolveTokenLabel({ useTokenSymbol: true, symbol: '   ' })).toBe('Shares');
    expect(resolveTokenLabel({ useTokenSymbol: true, symbol: null })).toBe('Shares');
    expect(resolveTokenLabel({})).toBe('Shares');
    expect(resolveTokenLabel()).toBe('Shares');
  });
});

describe('formatEstTime', () => {
  it('renders decimal hours as h/m, not "0.25 hrs"', () => {
    expect(formatEstTime(0.25)).toBe('15m');
    expect(formatEstTime(0.5)).toBe('30m');
    expect(formatEstTime(1)).toBe('1h');
    expect(formatEstTime(1.5)).toBe('1h 30m');
    expect(formatEstTime(2.25)).toBe('2h 15m');
  });

  it('renders 0m for zero, negative, or unparseable input', () => {
    expect(formatEstTime(0)).toBe('0m');
    expect(formatEstTime(-1)).toBe('0m');
    expect(formatEstTime('abc')).toBe('0m');
  });
});

describe('payoutConfigFromMetadata', () => {
  it('reads the org convention out of OrgMetadata', () => {
    expect(payoutConfigFromMetadata({
      taskPayoutHoursOnly: true,
      taskPayoutHourlyRate: '12.5',
      useTokenSymbol: true,
    })).toEqual({ hoursOnly: true, hourlyRate: '12.5', useTokenSymbol: true });
  });

  it('defaults every flag off for missing/absent metadata', () => {
    expect(payoutConfigFromMetadata(null)).toEqual({ hoursOnly: false, hourlyRate: null, useTokenSymbol: false });
    expect(payoutConfigFromMetadata({})).toEqual({ hoursOnly: false, hourlyRate: null, useTokenSymbol: false });
  });

  it('treats non-true values as false rather than truthy-coercing', () => {
    const cfg = payoutConfigFromMetadata({ taskPayoutHoursOnly: 'yes', useTokenSymbol: 1 });
    expect(cfg.hoursOnly).toBe(false);
    expect(cfg.useTokenSymbol).toBe(false);
  });
});
