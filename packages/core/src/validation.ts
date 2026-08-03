/**
 * Input Validation
 */

import { ethers } from 'ethers';

export function requireArg<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required argument: --${name}`);
  }
  return value;
}

export function requireAddress(address: string | undefined, name: string): string {
  if (!address || !ethers.utils.isAddress(address)) {
    throw new Error(`Invalid address for --${name}: ${address}`);
  }
  return ethers.utils.getAddress(address);
}

export function requirePositiveNumber(value: number | string, name: string): number {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num) || num <= 0 || !isFinite(num)) {
    throw new Error(`--${name} must be a positive finite number, got: ${value}`);
  }
  return num;
}

/** Username: 3-32 chars, alphanumeric + underscores only (matches contract/frontend rules) */
export function requireValidUsername(username: string): string {
  if (!username || username.length < 3 || username.length > 32) {
    throw new Error('Username must be 3-32 characters');
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    throw new Error('Username can only contain letters, numbers, and underscores');
  }
  return username;
}
