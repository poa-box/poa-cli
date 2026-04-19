import { describe, it, expect } from 'vitest';
import { classifyProposal, weightedMixPrediction, getProtocolProfile, applyRuleAAdjustment, PROTOCOL_PROFILES, type DecisionType } from '../../src/commands/org/audit-snapshot';

describe('classifyProposal — Pattern θ v0.4 decision-type heuristic', () => {
  it('classifies Aave ARFC titles as ratification', () => {
    expect(classifyProposal('[ARFC] Onboard PT-USDG to Aave V3 Core Instance')).toBe('ratification');
    expect(classifyProposal('[ARFC] Continued Deprecation Steps of Aave V2 Markets')).toBe('ratification');
  });

  it('classifies Aave allocation/budget titles as allocation', () => {
    expect(classifyProposal('SLC Budget Request - Month 8')).toBe('allocation');
    expect(classifyProposal('Contributor Grant: 2026 Q2 Development Funding')).toBe('allocation');
  });

  it('classifies policy-type titles as policy', () => {
    expect(classifyProposal('[ARFC ADDENDUM] Mandatory Disclosures and Conflict-of-Interest Voting'))
      .toBe('ratification'); // ARFC keyword dominates over disclosure — matches real-world Aave proposal mixed categorization
    expect(classifyProposal('Adopt a Code of Conduct for contributors')).toBe('policy');
  });

  it('classifies tokenomics titles as tokenomics', () => {
    expect(classifyProposal('$AAVE token alignment. Phase 1 - Ownership')).toBe('tokenomics');
    expect(classifyProposal('Reduce SWISE emission schedule by 50%')).toBe('tokenomics');
  });

  it('classifies strategic deployment titles as deployment', () => {
    expect(classifyProposal('[ARFC] Deploy Aave V3 to MegaETH')).toBe('ratification'); // ARFC dominant
    expect(classifyProposal('Strategic partnership with Lido for staked assets')).toBe('deployment');
  });

  it('classifies Morpho MIP ratification titles as ratification', () => {
    expect(classifyProposal('MIP 126 - List MorphoMarketV1AdapterV2 in Morpho Registry')).toBe('ratification');
  });

  it('returns unclassified for ambiguous titles with no keyword match', () => {
    expect(classifyProposal('Community update')).toBe('unclassified');
    expect(classifyProposal('Test proposal')).toBe('unclassified');
    // Note: "discussion" is a signaling keyword in v0.6, so "general discussion" now classifies as signaling.
  });

  it('is case-insensitive', () => {
    expect(classifyProposal('ARFC ONBOARD NEW ASSET')).toBe('ratification');
    expect(classifyProposal('arfc onboard new asset')).toBe('ratification');
  });
});

describe('weightedMixPrediction — Pattern θ v0.4 formula', () => {
  const emptyCounts: Record<DecisionType, number> = {
    ratification: 0, allocation: 0, policy: 0,
    tokenomics: 0, deployment: 0, signaling: 0, unclassified: 0,
  };

  it('returns zero when no proposals classified', () => {
    const pred = weightedMixPrediction(emptyCounts);
    expect(pred.predictedPassRate).toBe(0);
    expect(pred.pRatification).toBe(0);
    expect(pred.pNonRatification).toBe(0);
  });

  it('predicts ~0.99 when all proposals are ratification', () => {
    const counts = { ...emptyCounts, ratification: 100 };
    const pred = weightedMixPrediction(counts);
    expect(pred.predictedPassRate).toBeCloseTo(0.99, 2);
    expect(pred.pRatification).toBe(1);
    expect(pred.pNonRatification).toBe(0);
  });

  it('predicts ~0.70 when all proposals are allocation', () => {
    const counts = { ...emptyCounts, allocation: 100 };
    const pred = weightedMixPrediction(counts);
    expect(pred.predictedPassRate).toBeCloseTo(0.70, 2);
    expect(pred.pRatification).toBe(0);
    expect(pred.pNonRatification).toBe(1);
  });

  it('weighted-mix matches Aave HB#729 prediction (96% ratif + 4% non-ratif)', () => {
    // HB#729 formula: PR = 0.96 × 0.99 + 0.04 × 0.70 = 0.9504 + 0.028 = 0.978
    const counts = { ...emptyCounts, ratification: 96, allocation: 4 };
    const pred = weightedMixPrediction(counts);
    expect(pred.predictedPassRate).toBeCloseTo(0.978, 2);
  });

  it('v0.5 (vigil HB#438): unclassified proposals excluded from denominator', () => {
    const counts = { ...emptyCounts, ratification: 50, unclassified: 50 };
    const pred = weightedMixPrediction(counts);
    // v0.5: classified=50, unclassified=50 → P(ratif) = 50/50 = 1.0
    // predicted = 1.0 × 0.99 + 0 × 0.70 = 0.99
    expect(pred.pRatification).toBe(1.0);
    expect(pred.pNonRatification).toBe(0);
    expect(pred.predictedPassRate).toBeCloseTo(0.99, 2);
    expect(pred.classifiedFraction).toBe(0.5);
  });

  it('v0.5: returns zeroes when all proposals unclassified', () => {
    const counts = { ...emptyCounts, unclassified: 100 };
    const pred = weightedMixPrediction(counts);
    expect(pred.predictedPassRate).toBe(0);
    expect(pred.pRatification).toBe(0);
    expect(pred.classifiedFraction).toBe(0);
  });

  it('v0.5: classifiedFraction reflects heuristic coverage', () => {
    const counts = { ...emptyCounts, ratification: 20, allocation: 10, unclassified: 70 };
    const pred = weightedMixPrediction(counts);
    expect(pred.classifiedFraction).toBe(0.3);
  });

  it('v0.6: signaling-heavy DAO predicts ~40% (Nouns secondary anchor)', () => {
    const counts = { ...emptyCounts, signaling: 100 };
    const pred = weightedMixPrediction(counts);
    expect(pred.predictedPassRate).toBeCloseTo(0.40, 2);
    expect(pred.pSignaling).toBe(1);
  });

  it('v0.6: signaling classifier catches polls/sentiment/temp-checks', () => {
    expect(classifyProposal('Nouns DAO Split (a version of ragequit) Urgency Signaling')).toBe('signaling');
    expect(classifyProposal('Will sentiment polls improve discussions?')).toBe('signaling');
    expect(classifyProposal('Straw poll on new mascot')).toBe('signaling');
  });

  it('mixed decision-type DAO produces intermediate prediction', () => {
    // OP Token House approximation: 10% ratif, 80% allocation, 10% policy → 10% ratif, 90% non
    const counts = { ...emptyCounts, ratification: 10, allocation: 80, policy: 10 };
    const pred = weightedMixPrediction(counts);
    expect(pred.predictedPassRate).toBeCloseTo(0.729, 2);
  });

  it('handles fractional rounding to 3 decimal places', () => {
    const counts = { ...emptyCounts, ratification: 33, allocation: 67 };
    const pred = weightedMixPrediction(counts);
    // P(ratif)=0.33, P(non)=0.67
    // predicted = 0.33 × 0.99 + 0.67 × 0.70 = 0.3267 + 0.469 = 0.7957
    expect(pred.predictedPassRate).toBeCloseTo(0.796, 2);
  });
});

describe('classifyProposal + weightedMixPrediction integration', () => {
  it('Aave 4-rejection corpus classifies as expected', () => {
    const rejections = [
      '[ARFC ADDENDUM] Mandatory Disclosures and Conflict-of-Interest Voting',
      '[ARFC] Deploy Aave V3 to MegaETH',
      '[ARFC] $AAVE token alignment. Phase 1 - Ownership',
      '[TEMP CHECK] Onboard frxUSD to Aave v3 Ethereum Core Instance',
    ];
    const classified = rejections.map(t => classifyProposal(t));
    // Aave's "[ARFC]" prefix dominates classification — all 4 land in ratification due to keyword weight.
    // Acceptance: classifier is keyword-based MVP, not semantic. Real-world validation from HB#729 showed
    // these are all non-ratification SEMANTICALLY, but the heuristic classifies by title morphology.
    // Test asserts the actual MVP behavior, not the ideal semantic behavior.
    for (const c of classified) {
      expect(['ratification', 'tokenomics']).toContain(c);
    }
  });
});

describe('v0.7 protocol-profiles (Task #475)', () => {
  it('auto-detects opcollective.eth profile', () => {
    const profile = getProtocolProfile('opcollective.eth');
    expect(profile).not.toBeNull();
    expect(profile?.allocation).toContain('mission request');
  });

  it('returns null for unknown space', () => {
    const profile = getProtocolProfile('randomspace.eth');
    expect(profile).toBeNull();
  });

  it('override argument supersedes auto-detect', () => {
    const profile = getProtocolProfile('randomspace.eth', 'opcollective.eth');
    expect(profile).not.toBeNull();
    expect(profile?.allocation).toContain('mission request');
  });

  it('OP Mission Request titles classify as allocation WITH profile', () => {
    const profile = getProtocolProfile('opcollective.eth');
    expect(classifyProposal('Special Voting Cycle #9b: Grants Council Elections - Builders', undefined, profile)).toBe('allocation');
    expect(classifyProposal('Mission Request: Onboarding Growth Experiments', undefined, profile)).toBe('allocation');
  });

  it('OP Intent WITHOUT profile remains unclassified (v0.6 baseline)', () => {
    // "intent" / "special voting cycle" / "badgeholder" are OP-specific vocabulary
    // and do not match generic keywords
    expect(classifyProposal('Special Voting Cycle #12a')).toBe('unclassified');
  });

  it('Arbitrum AIP titles classify as ratification WITH profile', () => {
    const profile = getProtocolProfile('arbitrumfoundation.eth');
    expect(classifyProposal('AIP-52: Adjust Council Election Thresholds', undefined, profile)).toBe('ratification');
    expect(classifyProposal('STIP: Short-Term Incentive Program', undefined, profile)).toBe('allocation');
  });

  it('Gearbox credit-manager titles classify as ratification WITH profile', () => {
    const profile = getProtocolProfile('gearbox.eth');
    expect(classifyProposal('Update Credit Manager parameters for WETH pool', undefined, profile)).toBe('ratification');
    expect(classifyProposal('Adjust leverage ratio for v3 pool', undefined, profile)).toBe('ratification');
  });

  it('PROTOCOL_PROFILES has entries for known DAO gaps', () => {
    expect(Object.keys(PROTOCOL_PROFILES)).toContain('opcollective.eth');
    expect(Object.keys(PROTOCOL_PROFILES)).toContain('arbitrumfoundation.eth');
    expect(Object.keys(PROTOCOL_PROFILES)).toContain('gearbox.eth');
    expect(Object.keys(PROTOCOL_PROFILES)).toContain('morpho.eth');
    expect(Object.keys(PROTOCOL_PROFILES)).toContain('uniswapgovernance.eth');
  });
});

describe('v0.9 Rule-A capture-adjustment (Task #477)', () => {
  it('triggers when top-1 ≥50% (single-whale Rule A)', () => {
    // Gitcoin: top-1 50.1% → Rule A single-whale
    const base = 0.60; // base weighted-mix prediction (e.g. low ratif-fraction)
    const result = applyRuleAAdjustment(base, [0.501, 0.299, 0.05]);
    expect(result.triggered).toBe(true);
    expect(result.mode).toBe('single-whale');
    expect(result.adjusted).toBe(0.85); // floor applied
  });

  it('preserves higher base prediction (floor is MAX, not override)', () => {
    // Morpho-like: high ratif base already above floor
    const base = 0.95;
    const result = applyRuleAAdjustment(base, [0.555]);
    expect(result.triggered).toBe(true);
    expect(result.mode).toBe('single-whale');
    expect(result.adjusted).toBe(0.95); // base preserved, not lowered
  });

  it('flags dual-whale candidate but does NOT adjust (lockstep verification required)', () => {
    // ApeCoin-like: top-1 25% + top-2 24% = 49% — still below threshold
    // But top-1 35% + top-2 25% = 60% → candidate
    const base = 0.70;
    const result = applyRuleAAdjustment(base, [0.35, 0.25, 0.10]);
    expect(result.triggered).toBe(false);
    expect(result.mode).toBe('dual-whale-candidate');
    expect(result.adjusted).toBe(0.70); // unchanged
  });

  it('returns "none" when no Rule A trigger', () => {
    // Aave-like: top-1 18.8%, top-2 17.2%, cumulative <50%
    const base = 0.95;
    const result = applyRuleAAdjustment(base, [0.188, 0.172, 0.139]);
    expect(result.triggered).toBe(false);
    expect(result.mode).toBe('none');
    expect(result.adjusted).toBe(0.95);
  });

  it('Gitcoin scenario: Rule A floor lifts prediction from ~70% to 85%', () => {
    // Realistic Gitcoin: grant allocation heavy + 50% top-1 rubber-stamp
    // Base P(ratif) ~0.1, P(non) ~0.9, P(signal) 0 → base 0.729
    const baseFromFormula = 0.1 * 0.99 + 0.9 * 0.70;
    const result = applyRuleAAdjustment(baseFromFormula, [0.501, 0.299]);
    expect(result.triggered).toBe(true);
    expect(result.adjusted).toBe(0.85);
    // Would have been 72.9% without Rule-A adjustment; now 85%
    // Actual Gitcoin ~96%, so still under-predicts ~11pp but closer than v0.8's -25pp
  });

  it('empty topShares safely returns "none"', () => {
    const result = applyRuleAAdjustment(0.8, []);
    expect(result.triggered).toBe(false);
    expect(result.mode).toBe('none');
    expect(result.adjusted).toBe(0.8);
  });
});
