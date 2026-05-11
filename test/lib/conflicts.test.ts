import { describe, it, expect } from 'vitest';
import { parseResourceClaims } from '../../src/commands/vote/conflicts';

describe('parseResourceClaims', () => {
  describe('valid patterns', () => {
    it('parses "Bridge 0.4 xDAI"', () => {
      const r = parseResourceClaims('Bridge 0.4 xDAI to vigil_01 as ETH on Arbitrum (retry)');
      expect(r).toEqual({ token: 'xDAI', amount: 0.4 });
    });

    it('parses "Bridge 5 BREAD"', () => {
      const r = parseResourceClaims('Bridge 5 BREAD to vigil_01 as ETH on Arbitrum (quote-free)');
      expect(r).toEqual({ token: 'BREAD', amount: 5 });
    });

    it('parses "Distribute 2.0 BREAD"', () => {
      const r = parseResourceClaims('Distribute 2.0 BREAD to 3 members');
      expect(r).toEqual({ token: 'BREAD', amount: 2 });
    });

    it('parses "Deposit 0.5 xDAI"', () => {
      const r = parseResourceClaims('Deposit 0.5 xDAI into sDAI for yield');
      expect(r).toEqual({ token: 'xDAI', amount: 0.5 });
    });

    it('parses "Swap 15 BREAD"', () => {
      const r = parseResourceClaims('Swap 15 BREAD for WXDAI via Curve');
      expect(r).toEqual({ token: 'BREAD', amount: 15 });
    });

    it('parses "Withdraw 15 BREAD"', () => {
      const r = parseResourceClaims('Withdraw 15 BREAD from PaymentManager');
      expect(r).toEqual({ token: 'BREAD', amount: 15 });
    });

    it('parses "Send 5 xDAI"', () => {
      const r = parseResourceClaims('Send 5 xDAI to operator wallet');
      expect(r).toEqual({ token: 'xDAI', amount: 5 });
    });
  });

  describe('case insensitivity', () => {
    it('handles lowercase verbs', () => {
      expect(parseResourceClaims('bridge 0.4 xdai')).toEqual({ token: 'xDAI', amount: 0.4 });
    });

    it('handles uppercase tokens', () => {
      expect(parseResourceClaims('Bridge 0.4 XDAI')).toEqual({ token: 'xDAI', amount: 0.4 });
    });

    it('handles mixed case', () => {
      expect(parseResourceClaims('BrIdGe 0.4 XdAi')).toEqual({ token: 'xDAI', amount: 0.4 });
    });
  });

  describe('token normalization', () => {
    it('normalizes XDAI → xDAI', () => {
      const r = parseResourceClaims('Send 5 XDAI somewhere');
      expect(r?.token).toBe('xDAI');
    });

    it('preserves BREAD symbol as uppercase', () => {
      const r = parseResourceClaims('Bridge 5 BREAD');
      expect(r?.token).toBe('BREAD');
    });

    it('preserves WXDAI as uppercase', () => {
      const r = parseResourceClaims('Send 5 WXDAI');
      expect(r?.token).toBe('WXDAI');
    });
  });

  describe('decimals', () => {
    it('handles integer amounts', () => {
      expect(parseResourceClaims('Bridge 10 BREAD')?.amount).toBe(10);
    });

    it('handles decimal amounts', () => {
      expect(parseResourceClaims('Bridge 0.4 xDAI')?.amount).toBe(0.4);
    });

    it('handles multi-digit decimals', () => {
      expect(parseResourceClaims('Distribute 1.234 BREAD')?.amount).toBe(1.234);
    });
  });

  describe('non-matches', () => {
    it('returns null for proposals without a matching pattern', () => {
      expect(parseResourceClaims('Sprint 9 Priority: Where should agents focus next?')).toBeNull();
    });

    it('returns null for empty title', () => {
      expect(parseResourceClaims('')).toBeNull();
    });

    it('returns null for titles without verb+amount+token', () => {
      expect(parseResourceClaims('Deposit for yield')).toBeNull();
    });

    it('returns null for unknown tokens', () => {
      expect(parseResourceClaims('Bridge 10 DOGE to Arbitrum')).toBeNull();
    });

    it('returns null for verb+token without amount', () => {
      expect(parseResourceClaims('Bridge xDAI to Arbitrum')).toBeNull();
    });
  });

  describe('real proposal titles from Argus history', () => {
    it('parses #48: "Bridge 0.4 xDAI to vigil_01 as ETH on Arbitrum (retry)"', () => {
      const r = parseResourceClaims('Bridge 0.4 xDAI to vigil_01 as ETH on Arbitrum (retry)');
      expect(r).toEqual({ token: 'xDAI', amount: 0.4 });
    });

    it('parses #49: "Bridge 5 BREAD to vigil_01 as ETH on Arbitrum (quote-free)"', () => {
      const r = parseResourceClaims('Bridge 5 BREAD to vigil_01 as ETH on Arbitrum (quote-free)');
      expect(r).toEqual({ token: 'BREAD', amount: 5 });
    });

    it('parses #50: "Bridge 10 BREAD to vigil_01 as ETH on Arbitrum (5% slippage)"', () => {
      const r = parseResourceClaims('Bridge 10 BREAD to vigil_01 as ETH on Arbitrum (5% slippage)');
      expect(r).toEqual({ token: 'BREAD', amount: 10 });
    });

    it('parses #46: "Deposit 0.5 xDAI into sDAI for yield"', () => {
      const r = parseResourceClaims('Deposit 0.5 xDAI into sDAI for yield');
      expect(r).toEqual({ token: 'xDAI', amount: 0.5 });
    });

    it('parses #45: "Distribute 2.0 BREAD to 3 members"', () => {
      const r = parseResourceClaims('Distribute 2.0 BREAD to 3 members');
      expect(r).toEqual({ token: 'BREAD', amount: 2 });
    });

    it('ignores #47: "Sprint 9 Priority..."', () => {
      expect(parseResourceClaims('Sprint 9 Priority: Where should agents focus next?')).toBeNull();
    });
  });
});
