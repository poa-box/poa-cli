import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import chalk from 'chalk';
import {
  formatToken,
  formatRelativeTime,
  formatCountdown,
  statusColor,
  formatUsd,
} from '../../src/lib/format';

const NOW = 1_750_000_000;

describe('formatToken', () => {
  it('formats zero as 0', () => {
    expect(formatToken(0)).toBe('0');
    expect(formatToken(ethers.BigNumber.from(0), 18, 'PT')).toBe('0 PT');
  });

  it('formats exact integers without decimals', () => {
    expect(formatToken(ethers.utils.parseEther('12'), 18, 'PT')).toBe('12 PT');
    expect(formatToken(ethers.utils.parseEther('1'))).toBe('1');
  });

  it('trims trailing zeros', () => {
    expect(formatToken(ethers.utils.parseEther('12.5'), 18, 'PT')).toBe('12.5 PT');
    expect(formatToken(ethers.utils.parseEther('1.500'))).toBe('1.5');
  });

  it('adds thousands separators to the integer part', () => {
    expect(formatToken(ethers.utils.parseEther('1234567.89'), 18, 'PT')).toBe('1,234,567.89 PT');
    expect(formatToken(ethers.utils.parseEther('1000'))).toBe('1,000');
  });

  it('caps at 4 decimal places for normal values', () => {
    expect(formatToken(ethers.utils.parseEther('1.123456789'))).toBe('1.1234');
    expect(formatToken(ethers.utils.parseEther('0.12345'))).toBe('0.1234');
  });

  it('keeps full precision for dust below 0.0001', () => {
    // 0.00005 ether
    expect(formatToken(ethers.BigNumber.from('50000000000000'))).toBe('0.00005');
    // 1 wei
    expect(formatToken(ethers.BigNumber.from(1))).toBe('0.000000000000000001');
  });

  it('respects non-18 decimals', () => {
    expect(formatToken('1000000', 6, 'USDC')).toBe('1 USDC');
    expect(formatToken('1500000', 6)).toBe('1.5');
  });

  it('accepts string BigNumberish input', () => {
    expect(formatToken('1000000000000000000')).toBe('1');
  });
});

describe('formatRelativeTime', () => {
  it('formats seconds ago', () => {
    expect(formatRelativeTime(NOW - 30, NOW)).toBe('30s ago');
  });

  it('formats minutes ago', () => {
    expect(formatRelativeTime(NOW - 120, NOW)).toBe('2m ago');
  });

  it('formats hours ago', () => {
    expect(formatRelativeTime(NOW - 3 * 3600, NOW)).toBe('3h ago');
  });

  it('formats days ago', () => {
    expect(formatRelativeTime(NOW - 5 * 86400, NOW)).toBe('5d ago');
  });

  it('formats months ago', () => {
    expect(formatRelativeTime(NOW - 90 * 86400, NOW)).toBe('3mo ago');
  });

  it('formats future timestamps with "in"', () => {
    expect(formatRelativeTime(NOW + 2 * 86400, NOW)).toBe('in 2d');
    expect(formatRelativeTime(NOW + 45, NOW)).toBe('in 45s');
  });

  it('accepts string timestamps', () => {
    expect(formatRelativeTime(String(NOW - 3600), NOW)).toBe('1h ago');
  });

  it('bucket boundaries roll over correctly', () => {
    expect(formatRelativeTime(NOW - 59, NOW)).toBe('59s ago');
    expect(formatRelativeTime(NOW - 60, NOW)).toBe('1m ago');
    expect(formatRelativeTime(NOW - 3599, NOW)).toBe('59m ago');
    expect(formatRelativeTime(NOW - 3600, NOW)).toBe('1h ago');
    expect(formatRelativeTime(NOW - 86399, NOW)).toBe('23h ago');
    expect(formatRelativeTime(NOW - 86400, NOW)).toBe('1d ago');
    expect(formatRelativeTime(NOW - 30 * 86400, NOW)).toBe('1mo ago');
  });
});

describe('formatCountdown', () => {
  it('returns none for a zero deadline', () => {
    expect(formatCountdown(0, NOW)).toBe('none');
  });

  it('formats days and hours remaining', () => {
    expect(formatCountdown(NOW + 2 * 86400 + 4 * 3600, NOW)).toBe('2d 4h left');
  });

  it('formats hours and minutes remaining', () => {
    expect(formatCountdown(NOW + 3 * 3600 + 20 * 60, NOW)).toBe('3h 20m left');
  });

  it('formats minutes remaining', () => {
    expect(formatCountdown(NOW + 90, NOW)).toBe('1m left');
  });

  it('formats seconds remaining', () => {
    expect(formatCountdown(NOW + 30, NOW)).toBe('30s left');
  });

  it('boundary: exactly one hour', () => {
    expect(formatCountdown(NOW + 3600, NOW)).toBe('1h 0m left');
  });

  it('boundary: exactly one day', () => {
    expect(formatCountdown(NOW + 86400, NOW)).toBe('1d 0h left');
  });

  it('deadline equal to now is expired', () => {
    expect(formatCountdown(NOW, NOW)).toBe('expired 0s ago');
  });

  it('formats expired deadlines with elapsed bucket', () => {
    expect(formatCountdown(NOW - 3 * 3600, NOW)).toBe('expired 3h ago');
    expect(formatCountdown(NOW - 2 * 86400, NOW)).toBe('expired 2d ago');
  });
});

describe('statusColor', () => {
  it('greens open statuses', () => {
    expect(statusColor('UNCLAIMED')).toBe(chalk.green('UNCLAIMED'));
    expect(statusColor('Open')).toBe(chalk.green('Open'));
  });

  it('cyans claimed statuses', () => {
    expect(statusColor('CLAIMED')).toBe(chalk.cyan('CLAIMED'));
    expect(statusColor('Assigned')).toBe(chalk.cyan('Assigned'));
  });

  it('yellows submitted', () => {
    expect(statusColor('SUBMITTED')).toBe(chalk.yellow('SUBMITTED'));
  });

  it('dims completed', () => {
    expect(statusColor('COMPLETED')).toBe(chalk.dim('COMPLETED'));
  });

  it('reds cancelled and rejected', () => {
    expect(statusColor('CANCELLED')).toBe(chalk.red('CANCELLED'));
    expect(statusColor('Rejected')).toBe(chalk.red('Rejected'));
  });

  it('passes unknown statuses through unchanged', () => {
    expect(statusColor('WeirdStatus')).toBe('WeirdStatus');
  });
});

describe('formatUsd', () => {
  it('formats with dollar sign, separators, and 2 decimals', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1000000)).toBe('$1,000,000.00');
  });

  it('handles negatives', () => {
    expect(formatUsd(-42.1)).toBe('-$42.10');
  });
});
