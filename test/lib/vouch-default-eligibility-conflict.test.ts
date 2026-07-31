/**
 * Audit M-03 conflict predicate — the gate behind the two blocking pre-flights
 * added to `pop role eligibility set-default` and `pop vouch config set`.
 *
 * These branches were previously untested, so a false block would not have been
 * caught by CI. The predicate is pinned against LIVE Gnosis behaviour on
 * EligibilityModule 0x27114cb757bedf77e30eeb0ca635e3368d8c2914:
 *
 *   hat …569216, quorum 1, flags 3 (enabled|combine), defaultRules.eligible false
 *     eth_call setDefaultEligibility(hat, true, true) from superAdmin
 *       -> 0x70414907 == DefaultEligibilityConflictsWithVouch()
 *
 *   hats …904064 and …056320, defaultRules.eligible true
 *     eth_call configureVouching(hat, 1, hat, true) from superAdmin
 *       -> 0x70414907 == DefaultEligibilityConflictsWithVouch()
 *
 * NOTE for anyone re-running those probes: the Gnosis RPC returns revert data as
 * the eth_call RESULT rather than throwing, so a returned error selector must not
 * be read as success. A genuine success on these void functions returns '0x'.
 */

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  vouchConflictsWithDefaultEligibility,
  VOUCH_FLAG_ENABLED,
  VOUCH_FLAG_COMBINE_HIERARCHY,
} from '../../src/lib/perms';
import { loadAbi } from '../../src/lib/contracts';

const ENABLED_AND_COMBINE = VOUCH_FLAG_ENABLED | VOUCH_FLAG_COMBINE_HIERARCHY; // 3

describe('vouchConflictsWithDefaultEligibility — blocking pre-flight predicate', () => {
  it('the selector the CLI is predicting really is DefaultEligibilityConflictsWithVouch', () => {
    const iface = new ethers.utils.Interface(loadAbi('EligibilityModuleNew'));
    const err = iface.fragments.find(
      f => f.type === 'error' && f.name === 'DefaultEligibilityConflictsWithVouch'
    );
    expect(err, 'ABI must declare the error the gate exists to avoid').toBeTruthy();
    expect(ethers.utils.id('DefaultEligibilityConflictsWithVouch()').slice(0, 10)).toBe('0x70414907');
  });

  // set-default --eligible on a vouching+combine hat: BLOCKS (live: reverts).
  it('blocks when vouching is enabled, combines with hierarchy, and default-eligible is set', () => {
    expect(vouchConflictsWithDefaultEligibility(ENABLED_AND_COMBINE, 1, true)).toBe(true);
  });

  // The exact live state of hat …569216 (flags 3, quorum 1).
  it('matches the live Gnosis hat that reverts (flags 3, quorum 1, eligible true)', () => {
    expect(vouchConflictsWithDefaultEligibility(3, 1, true)).toBe(true);
  });

  it('does NOT block when default-eligible is being turned OFF', () => {
    expect(vouchConflictsWithDefaultEligibility(ENABLED_AND_COMBINE, 1, false)).toBe(false);
  });

  it('does NOT block when vouching is enabled but does not combine with hierarchy', () => {
    // flags 1 == enabled only. Live: Test6/Newcomer sits in this state.
    expect(vouchConflictsWithDefaultEligibility(VOUCH_FLAG_ENABLED, 1, true)).toBe(false);
  });

  it('does NOT block when vouching is disabled (quorum 0), even with the combine bit set', () => {
    // resetVouches emits VouchConfigSet(hat, 0, 0, false, false); quorum is the
    // authority, so a stale combine bit must not manufacture a conflict.
    expect(vouchConflictsWithDefaultEligibility(ENABLED_AND_COMBINE, 0, true)).toBe(false);
    expect(vouchConflictsWithDefaultEligibility(VOUCH_FLAG_COMBINE_HIERARCHY, 0, true)).toBe(false);
  });

  it('does NOT block a hat with no vouch config at all (flags 0, quorum 0)', () => {
    // The overwhelmingly common case — 0 of the live orgs may block by default.
    expect(vouchConflictsWithDefaultEligibility(0, 0, true)).toBe(false);
  });

  it('is symmetric: the vouch-config direction uses the same predicate', () => {
    // `pop vouch config set --combine-hierarchy --quorum N` on an already
    // default-eligible hat is the mirror image and must block identically.
    const quorum = 1;
    const combine = true;
    const defaultEligible = true;
    const flags = (quorum > 0 ? VOUCH_FLAG_ENABLED : 0) | (combine ? VOUCH_FLAG_COMBINE_HIERARCHY : 0);
    expect(vouchConflictsWithDefaultEligibility(flags, quorum, defaultEligible)).toBe(true);
    // ...and must NOT block without --combine-hierarchy.
    const noCombine = quorum > 0 ? VOUCH_FLAG_ENABLED : 0;
    expect(vouchConflictsWithDefaultEligibility(noCombine, quorum, defaultEligible)).toBe(false);
  });
});
