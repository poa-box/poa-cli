import { describe, it, expect } from 'vitest';
import {
  getTokenByAddress,
  getTokenBySymbol,
  resolveTokenAddress,
  getTokenDecimals,
  PARTICIPATION_TOKEN_DECIMALS,
} from '../../src/config/tokens';

describe('tokens', () => {
  describe('getTokenByAddress', () => {
    it('finds BREAD by lowercase address', () => {
      const token = getTokenByAddress('0xa555d5344f6fb6c65da19e403cb4c1ec4a1a5ee3');
      expect(token).not.toBeNull();
      expect(token!.symbol).toBe('BREAD');
      expect(token!.decimals).toBe(18);
    });

    it('finds BREAD by mixed-case address (case-insensitive)', () => {
      const token = getTokenByAddress('0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3');
      expect(token).not.toBeNull();
      expect(token!.symbol).toBe('BREAD');
    });

    it('finds USDC on Gnosis', () => {
      const token = getTokenByAddress('0xddafbb505ad214d7b80b1f830fccc89b60fb7a83');
      expect(token).not.toBeNull();
      expect(token!.symbol).toBe('USDC');
      expect(token!.decimals).toBe(6);
    });

    it('returns null for unknown address', () => {
      expect(getTokenByAddress('0x0000000000000000000000000000000000000000')).toBeNull();
    });

    it('returns checksummed address in result', () => {
      const token = getTokenByAddress('0xa555d5344f6fb6c65da19e403cb4c1ec4a1a5ee3');
      // Address in result should be checksummed (mixed case)
      expect(token!.address).not.toBe(token!.address.toLowerCase());
    });
  });

  describe('getTokenBySymbol', () => {
    it('finds BREAD by symbol', () => {
      const token = getTokenBySymbol('BREAD');
      expect(token).not.toBeNull();
      expect(token!.decimals).toBe(18);
    });

    it('is case-insensitive', () => {
      expect(getTokenBySymbol('bread')).not.toBeNull();
      expect(getTokenBySymbol('Bread')).not.toBeNull();
    });

    it('finds WXDAI', () => {
      const token = getTokenBySymbol('WXDAI');
      expect(token).not.toBeNull();
      expect(token!.decimals).toBe(18);
    });

    it('returns null for unknown symbol', () => {
      expect(getTokenBySymbol('NONEXISTENT')).toBeNull();
    });
  });

  describe('resolveTokenAddress', () => {
    it('returns address unchanged if starts with 0x', () => {
      const addr = '0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3';
      expect(resolveTokenAddress(addr)).toBe(addr);
    });

    it('resolves BREAD symbol to checksummed address', () => {
      const addr = resolveTokenAddress('BREAD');
      expect(addr).toBe('0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3');
    });

    it('throws on unknown symbol', () => {
      expect(() => resolveTokenAddress('FAKE')).toThrow('Unknown token symbol');
    });
  });

  describe('getTokenDecimals', () => {
    it('returns 18 for BREAD', () => {
      expect(getTokenDecimals('0xa555d5344f6fb6c65da19e403cb4c1ec4a1a5ee3')).toBe(18);
    });

    it('returns 6 for USDC', () => {
      expect(getTokenDecimals('0xddafbb505ad214d7b80b1f830fccc89b60fb7a83')).toBe(6);
    });

    it('throws for unknown address', () => {
      expect(() => getTokenDecimals('0x0000000000000000000000000000000000000001')).toThrow('Unknown bounty token');
    });
  });

  describe('PARTICIPATION_TOKEN_DECIMALS', () => {
    it('is 18', () => {
      expect(PARTICIPATION_TOKEN_DECIMALS).toBe(18);
    });
  });
});
