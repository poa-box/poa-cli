/**
 * PaymasterHub query tiers.
 *
 * `PaymasterBudget.totalUsed` is the only field in FETCH_PAYMASTER_STATE with no
 * getter counterpart (getBudget() returns just the four in-epoch numbers), which
 * makes it the field most likely to be missing from an older deployment. GraphQL
 * validates a document as a WHOLE, so one unknown field fails the entire query
 * and drops `pop paymaster status` back to 3 + N eth_calls. The legacy tier is
 * derived from the modern one by line deletion so the two cannot drift — which
 * means reformatting `totalUsed` onto a shared line would silently turn the
 * "fallback" into a copy of the tier it exists to rescue. These pin that.
 */

import { describe, it, expect } from 'vitest';
import {
  FETCH_PAYMASTER_STATE,
  FETCH_PAYMASTER_STATE_LEGACY,
  FETCH_PAYMASTER_STATE_TIERS,
} from '../../src/queries/paymaster';

describe('paymaster query tiers', () => {
  it('the modern tier asks for totalUsed on its own line', () => {
    expect(FETCH_PAYMASTER_STATE).toMatch(/^\s*totalUsed\s*$/m);
  });

  it('the legacy tier drops it and nothing else', () => {
    expect(FETCH_PAYMASTER_STATE_LEGACY).not.toContain('totalUsed');
    expect(FETCH_PAYMASTER_STATE_LEGACY).not.toBe(FETCH_PAYMASTER_STATE);
    for (const kept of ['entryPoint', 'adminHatId', 'isPaused', 'isBannedFromSolidarity', 'registeredAt', 'maxFeePerGas', 'subjectKey', 'usedInEpoch', 'epochStart']) {
      expect(FETCH_PAYMASTER_STATE_LEGACY, `${kept} must survive`).toContain(kept);
    }
  });

  it('both tiers are brace-balanced with no empty selection set', () => {
    for (const [name, doc] of [['modern', FETCH_PAYMASTER_STATE], ['legacy', FETCH_PAYMASTER_STATE_LEGACY]] as const) {
      expect((doc.match(/\{/g) || []).length, `${name} brace balance`).toBe((doc.match(/\}/g) || []).length);
      expect(doc, `${name} has an empty selection set`).not.toMatch(/\{\s*\}/);
    }
  });

  it('orders tiers modern-first', () => {
    expect(FETCH_PAYMASTER_STATE_TIERS).toEqual([FETCH_PAYMASTER_STATE, FETCH_PAYMASTER_STATE_LEGACY]);
  });

  /**
   * These were measured against both live deployments and found WRONG, not just
   * absent — the indexer omits the solidarity fee from totalSpent (exactly
   * 1/1.01 of the contract's `spent` on Gnosis AND Arbitrum), reports a stale
   * solidarityBalance on Gnosis, and reports solidarityDistributionPaused=false
   * on Arbitrum while the contract says true. Requesting any of them would make
   * `pop paymaster status` quietly overstate an org's remaining sponsorship.
   */
  it('never requests the financial fields that diverge from the contract', () => {
    for (const banned of ['totalSpent', 'depositBalance', 'solidarityBalance', 'solidarityDistributionPaused', 'totalDeposited']) {
      expect(FETCH_PAYMASTER_STATE, `${banned} must not be queried`).not.toContain(banned);
    }
  });
});
