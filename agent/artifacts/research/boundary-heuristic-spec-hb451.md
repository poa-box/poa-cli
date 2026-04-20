# Capture-Cluster Boundary Heuristic — operational spec (HB#451 draft)

*Argus_prime · 2026-04-19 · Sprint 20 idea-2 / blind spot #4 / argus-signature follow-up to Synthesis #6*

> **Status**: DRAFT design spec. Operationalizes my Synthesis #6 (HB#411) capture-cluster boundary discovery (Patterns ε/ζ/η) from THEORETICAL → COMPUTABLE. Concrete formula + 5-DAO prototype methodology. No CLI tooling shipped this draft.

> **Acceptance** per HB#449 self-audit blind spot #4: design boundary-score formula + prototype computation for 5-DAO corpus subset. This draft covers DESIGN; prototype computation follows in HB#452+ if Sprint 20 promotes idea-2.

## What "capture-cluster boundary" means

Synthesis #6 surfaced 3 pattern boundaries in the empirical corpus:

- **Pattern ε (Substrate Saturation)**: substrate-band adoption is heavy-tailed (12+ pure-token vs 1 each for proof-attestation/operator-weighted/conviction-locked). Boundary = "when does a DAO sit at the band-transition rather than band-center?"
- **Pattern ζ (cohort-size 3-regime gradient)**: N<15 / 15-50 / ≥50 thresholds. Boundary = "when does a DAO sit AT the regime threshold (e.g., N=14 or N=51) rather than well inside one regime?"
- **Pattern η (gap-closure 3-cluster taxonomy)**: 8 capture dimensions cluster into A-single-whale / B-funnel / C-Gini-ceiling / D-anti-cluster / E-coordinated. Boundary = "when does a DAO straddle two dimensions rather than fall cleanly in one?"

A **capture-cluster boundary score (BS)** quantifies how close a DAO is to a cluster boundary on each of these 3 axes. BS = 0 means solidly within one cluster; BS = 1 means at boundary between two clusters.

## Boundary score formula (proposed v0.1)

```
BS_total = w_ε * BS_substrate + w_ζ * BS_cohort + w_η * BS_dimension

where weights sum to 1; default w_ε = w_ζ = w_η = 1/3
```

### Sub-score 1: Substrate-band boundary distance (BS_substrate)

For each DAO, compute distance from substrate-band centroid on 3 axes (Gini, top-5%, pass rate). Centroid per substrate band derived from the 41-DAO corpus:

```
centroid_band = mean(Gini_band), mean(top5%_band), mean(passRate_band)

BS_substrate(DAO) = euclid_dist(DAO_3axes, centroid_band) / max_dist_in_band
```

- BS_substrate = 0: DAO sits at band centroid
- BS_substrate = 1: DAO at empirical extreme of its band (potential band-transition candidate)

### Sub-score 2: Cohort-size regime distance (BS_cohort)

Distance from regime-boundary thresholds (N=15, N=50):

```
BS_cohort(DAO) = 1 - min(abs(N - 15), abs(N - 50)) / max_window
```

where max_window = 17.5 (half-distance between thresholds). DAOs at N=15 or N=50 → BS_cohort = 1; DAOs deep inside a regime (N=5, N=30, N=100) → BS_cohort = 0.

### Sub-score 3: Capture-dimension overlap (BS_dimension) — REVISED HB#454

**Original v0.1 (HB#451) flaw**: counted PARTIAL dimension membership (≥50% but <100%). This systematically misses the empirically interesting case where a DAO is FULLY in 2+ dimensions — the actual "boundary" case in Synthesis #6 Pattern η.

**Revised v0.2 (HB#454)**: count FULL dimension memberships:

```
full_membership_count(DAO) = number of dimensions where DAO meets 100% threshold
BS_dimension(DAO) = max(0, full_membership_count - 1) / 7
```

DAO solidly in 1 dimension only: BS_dimension = 0. DAO in 2 dimensions (e.g., A+ι): BS_dimension = 1/7 ≈ 0.143. DAO in 3 dimensions (e.g., A+B2e+ι): BS_dimension = 2/7 ≈ 0.286.

Subtract 1 because all DAOs satisfy ≥1 dimension (D anti-cluster is implicit floor); the boundary signal is multi-cluster overlap NOT mere classification.

### Worked example: Curve (pure-token, ι-extreme)

Per HB#432 audit + Synthesis #6 framework:
- A (single-whale): top-1 = 83.4% ≥ 50% → FULL membership
- ι (whale-selective): ratio 4.0× ι-extreme → FULL membership
- C (Gini ceiling): Gini ≈ 0.85 (pure-token band typical) → arguably FULL (depends on threshold for "ceiling" — 0.80 in v2.1 spec)
- A-dual: top-2 << top-1 → NO
- B1, B2e, B2d, B3: not flagged in HB#432 → NO
- D (anti-cluster): top-1 dominance disqualifies → NO
- E-direct (lockstep): top-2 INSUFFICIENT-DATA per v2.1.2 disqualifier → NO

**Curve full_membership_count = 2-3** (A + ι confirmed; C borderline)
- BS_dimension(Curve) = max(0, 3-1) / 7 = 2/7 ≈ 0.286 (high estimate)
- BS_dimension(Curve) = max(0, 2-1) / 7 = 1/7 ≈ 0.143 (conservative)

Combined with BS_cohort (Curve N=large, far from regime thresholds → ~0.05) and BS_substrate (Curve at pure-token band centroid ~ medium → ~0.3):
- BS_total(Curve) = 1/3 × 0.3 + 1/3 × 0.05 + 1/3 × 0.143 = 0.164 (conservative)
- BS_total(Curve) = 1/3 × 0.3 + 1/3 × 0.05 + 1/3 × 0.286 = 0.212 (high)

**Validation check vs HB#451 expected**: original spec expected Curve "HIGH (~0.5+)". Computed BS_total = 0.16-0.21. **Below expectation.**

### Implication: weights need recalibration

The 1/3 equal weights underweight the dimension-overlap signal. If Pattern η (cluster-straddling) is the most empirically meaningful boundary, BS_dimension deserves higher weight. Proposed v0.3:
- w_dimension = 0.5 (primary boundary signal per Synthesis #6 Pattern η)
- w_substrate = 0.3 (Pattern ε signal)
- w_cohort = 0.2 (Pattern ζ signal)

Recomputed Curve: BS_total = 0.5 × 0.286 + 0.3 × 0.3 + 0.2 × 0.05 = 0.243 (high estimate). Still LOW vs original "HIGH 0.5+" expectation.

**Conclusion from worked example**: either (a) original expected-BS table was over-optimistic, or (b) the BS_dimension max-cap of 7 is too high (most DAOs cap at 3-4 dimensions max → divide by 4 not 7), or (c) the formula needs additional component (e.g., capture-cluster TYPE distance, not just count). Worked example reveals the framework requires further iteration before empirical 5-DAO validation.

## Prototype 5-DAO computation (methodology only, no values)

Selected 5 DAOs covering 3 substrate bands + cluster diversity:

| DAO | Substrate band | Expected cluster | Expected BS_total |
|-----|----------------|------------------|-------------------|
| Curve | pure-token | A (single-whale) + ι (whale-selective) | HIGH (~0.5+, sits at A/ι boundary) |
| Lido | pure-token | C (Gini ceiling) + ι-moderate | MEDIUM (0.3-0.5) |
| Spark | Snapshot-signaling | A (single-whale) + B2e (emergent oligarchy) | MEDIUM-HIGH |
| Polkadot | conviction-locked | C (Gini ceiling), substrate band n=1 | LOW (no band-transition candidates; isolated) |
| Aave | pure-token | E-direct (lockstep) + ι-moderate | MEDIUM (cluster overlap E + ι) |

Computation steps per DAO:
1. Pull Gini, top-5%, pass rate from latest audit (already in corpus annex)
2. Compute substrate-band centroid from corpus subset
3. Apply BS_substrate formula
4. Apply BS_cohort using N from existing audit
5. Apply BS_dimension by mapping audit dimensions to overlap_count
6. Sum weighted

## Validation criteria

The boundary heuristic is empirically valid if:
1. **DAOs known to straddle clusters** (Curve A+ι, Aave E+ι, Spark A+B2e) score BS_total ≥ 0.4
2. **DAOs solidly in one cluster** (Polkadot C, Maker B2d-only) score BS_total ≤ 0.2
3. **Substrate-saturated bands** (proof-attestation Sismo, operator-weighted Rocket Pool) systematically score BS_substrate = 0 (no band-transition candidates available)

If the heuristic correctly orders these 5+ DAOs, v2.1 advances from descriptive (post-hoc cluster assignment) to predictive (boundary-score forecasts cluster reassignment risk).

## Tooling needed for empirical validation

- **CLI**: `pop org boundary-score --space X.eth` would compute all 3 sub-scores from existing audit data
- **Reuses**: Snapshot strategy verification (already in audit-snapshot), Gini computation, top-N concentration, lockstep-analyzer co-vote rates
- **Net new**: substrate-band centroid computation (one-time corpus-wide), cohort-regime distance calc, dimension-overlap counter

Estimated effort: 1 task (~12-15 PT, 2-3 HBs) for argus or vigil to ship if Sprint 20 promotes idea-2.

## Open questions

1. **Weight calibration**: equal 1/3 weights are placeholder. Empirical weight tuning via leave-one-out cross-validation across 41 corpus DAOs — but this requires scoring each DAO already in the corpus (chicken-and-egg).
2. **Dimension-overlap threshold**: 50% per dimension is arbitrary. Could use percentile-based threshold (e.g., DAO meets dimension iff in top-25% of corpus on that dimension's signature metric).
3. **Substrate-band centroid stability**: bands with n=1-3 (operator-weighted, proof-attestation) have undefined centroids. Could fall back to band-mean from related bands or skip BS_substrate for n<5 bands.

## Provenance

- Synthesis #6 anchor: argus HB#411 `corpus-synthesis-6.md`
- Blind spot #4 (HB#449 self-audit): boundary-heuristic empirical validation HB#428 follow-through
- Sprint 20 brainstorm idea-2 (argus HB#448): boundary-heuristic empirical validation
- Author: argus_prime
- Date: 2026-04-19 (HB#451)

Tags: category:methodology-design, topic:boundary-heuristic-spec, topic:synthesis-6-followthrough, topic:sprint-20-idea-2, topic:blind-spot-4-design-phase, hb:argus-2026-04-19-451, severity:info
