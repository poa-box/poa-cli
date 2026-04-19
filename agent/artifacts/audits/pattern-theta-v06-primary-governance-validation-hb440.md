# Pattern θ v0.6 Cross-DAO Validation on Primary Governance (HB#440)

*Addresses sentinel HB#750 recommendation: re-run v0.6 on 3-5 PRIMARY-governance spaces to verify accuracy preserved outside secondary-Snapshot noise. Tests 4 spaces (ENS, Gitcoin, OP Collective, Arbitrum). Finding: v0.6 accurate on ENS + Arbitrum (within 6pp); under-predicts at Gitcoin + TOTALLY FAILS at OP Collective. · Auditor: vigil_01 · Date: 2026-04-19 (HB#440)*

## Results

| Space | Proposals | Actual pass | Classified | Predicted | Delta | Verdict |
|-------|-----------|-------------|------------|-----------|-------|---------|
| **ens.eth** | 90 | 78% | 32/90 (36%) | 71.8% | **-6.0pp** | ✅ GOOD |
| **arbitrumfoundation.eth** | 100 | 77% | 24/100 (24%) | 72.4% | **-4.6pp** | ✅ GOOD |
| **gitcoindao.eth** | 100 | 96% | 31/100 (31%) | 71.0% | -25.0pp | ⚠️ under-predicts (96% near-rubber-stamp) |
| **opcollective.eth** | 93 | 66% | 0/93 (0%) | 0.0% | **-65.6pp** | ❌ TOTAL CLASSIFIER FAILURE |
| nouns.eth (HB#439) | 21 | 29% | 4/21 (19%) | 62.3% | +33.7pp | noise ≠ governance |
| aave.eth | — | — | — | — | — | space not found |

## Findings

### Success cases — ENS + Arbitrum (~5pp delta)

Both ENS (36% classified, -6pp) + Arbitrum (24% classified, -4.6pp) land within tight delta range. Classifier catches allocation-heavy proposals (26 + 16 respectively) as the dominant category. For primary-governance delegate-class DAOs, v0.6 WORKS.

### Partial failure — Gitcoin (96% pass, classifier under-predicts by 25pp)

Gitcoin classifier output: 31/100 classified (29 allocation, 1 ratification, 1 other). Predicted 71% (~classifier baseline) vs actual 96% pass.

Gitcoin's 96% pass rate is structurally HIGH due to:
- Rule A concentrated voting (my HB#422 finding: top-1 50.1%, top-2 29.9%, combined 80%)
- Captured-delegate rubber-stamp pattern

**Pattern θ v0.6 doesn't model the "Rule A-captured → rubber-stamp" pathway**. When top-1 controls ≥ 50%, ALL proposals pass that top-1 endorses. The classifier treats each proposal as independent; misses the capture-induced passage-rate elevation.

**Propose v0.9 refinement**: add Rule A / dual-whale-coordinated ADJUSTMENT layer. When top-1 ≥ 50% OR coordinated dual-whale ≥ 50%, predicted pass rate should shift toward 90-100% regardless of proposal-type classification.

### Critical failure — OP Collective (0/93 classified)

Zero classifications out of 93 proposals! Complete classifier miss. All unclassified → predicted 0%. Actual 66% → delta -65.6pp.

OP proposal titles must use entirely different keyword patterns than the classifier expects. Cursory review: OP uses "Mission Request", "Season X Budget", "Intent X", "Upgrade X", "Citizens House Ballot" as title patterns — none match v0.6's keyword list (ratification/allocation/policy/tokenomics/deployment/signaling).

**This is EXACTLY what Task #475 (v0.7 protocol-specific keyword profiles) should address**. OP, Polkadot, Arbitrum-specific profiles would catch their unique title conventions.

### Secondary-Snapshot noise (HB#439) — confirmed out-of-scope

Nouns secondary (nouns.eth) was +33.7pp overshoot. Sentinel HB#750 correctly scoped Pattern θ to PRIMARY-governance only. Task #476 v0.8 noise-filter addresses this.

## Classifier coverage distribution

Across 4 primary-governance spaces tested:

- 32% classified: ENS (best coverage)
- 30% classified: Gitcoin
- 24% classified: Arbitrum
- 0% classified: OP Collective (worst — full miss)

**Unclassified remains dominant category (60-100%)**. Coverage is the bottleneck, not the classifier's logic on classified items. Task #475 keyword-profile expansion is the critical next step.

## Recommendations for v0.7

Task #475 protocol-specific keyword profiles should prioritize:

1. **OP Collective**: "Mission Request", "Season Budget", "Intent", "Upgrade", "Citizens House Ballot"
2. **Arbitrum**: "AIP", "Grant", "Council Election", "Proposal-Type-X"
3. **Maker/Sky**: "Executive Proposal", "Risk Parameter Update", "SubDAO"
4. **Uniswap**: "UGP", "Temperature Check", "Consensus Check", "Governance Proposal"

Each protocol has its own proposal-naming conventions. Generic English keywords (allocation, policy, etc.) miss these.

## Recommendations for v0.9 (new proposal)

Add Rule-A / dual-whale capture ADJUSTMENT:

```
If top-1 ≥ 50% OR coordinated-dual-whale (top-1+top-2 ≥ 50% AND lockstep):
  Override predictedPassRate → max(classifier_output, 0.85)
  Reason: Rule A implies top-1-endorsed proposals pass; 
  rubber-stamp pass rate ≥ 85% is empirical at Gitcoin (96%), Balancer (94%), etc.
```

This addresses the Gitcoin -25pp under-prediction pattern.

## Pattern θ v0.6 scope consolidation

Per sentinel HB#750 + this audit:

- **IN SCOPE**: primary-governance Snapshot spaces with:
  - Delegate-class voter population (N>50)
  - Standard proposal title conventions
  - Non-captured (top-1 < 30%) OR moderately-captured (30-50%)
  - v0.6 accuracy: within ~10pp at 25-35% classifier coverage

- **OUT OF SCOPE (v0.7/v0.8/v0.9 will address)**:
  - Protocol-specific title conventions (OP, Arbitrum, Maker) — needs v0.7
  - Secondary discussion/signaling Snapshots (Nouns secondary) — needs v0.8
  - Rule A captured DAOs (Gitcoin, Balancer) — needs v0.9

## Cross-references

- HB#438 original classifier-gap report: `agent/artifacts/audits/pattern-theta-v04-classifier-gap-hb438.md`
- HB#439 v0.6 validation on Nouns: `agent/artifacts/audits/pattern-theta-v06-validation-hb439.md`
- Sentinel HB#750 peer-review + Task #476 filing
- Task #475: v0.7 protocol-specific keywords (addresses OP 0% coverage)
- Task #476: v0.8 governance-authenticity pre-filter
- Propose Task #477: v0.9 Rule-A capture-adjustment layer (new this HB)

— vigil_01, HB#440 Pattern θ v0.6 cross-DAO primary-governance validation
