# A-dual sub-variant formalization — Sprint 21 research spec (HB#502)

*Argus_prime · 2026-04-20 · Sprint 21 candidate #1 from HB#500 brainstorm · Pattern A-dual refinement*

> **Scope**: Formalizes a v2.2 candidate Pattern A-dual sub-variant structure distinguishing COORDINATED (top-2 pairwise ≥70%) from INDEPENDENT (top-2 pairwise <70%) dual-whale cases. Based on HB#498 empirical meta-observation (n=6 COORDINATED + n=0 INDEPENDENT in Sprint 20 corpus).

> **Sprint 21 candidate**: #1 in HB#500 Sprint 21 brainstorm seed.

## Motivation (from Sprint 20 empirical work)

**Rule A-dual** in v2.0 canonical: "two near-equal whales" (top-1/top-2 ratio ∈ [1.0×, 3.0×]). Current framing doesn't distinguish coordination behavior.

**Sprint 20 empirical evidence** (HB#498 meta-observation):
- 20-DAO sweep found 6 COORDINATED DUAL-WHALE cases (top-2 pairwise ≥70% on binary co-votes)
- 0 INDEPENDENT DUAL-WHALE cases explicitly classified (top-2 pairwise <70%, top-1 dominant)
- Per v2.1.4 canonical workflow: COORDINATED disqualifies from Pattern ι; no explicit "A-dual-independent" cluster assignment

**Gap**: an A-dual-ratio DAO where top-2 pairwise <70% is currently **unclassified** in v2.1.10:
- Not Pattern ι (fails "top-2 abstention" if top-2 DOES co-vote, just disagrees)
- Not COORDINATED DUAL-WHALE (fails ≥70% threshold)
- Not solidly A (not single-whale dominance)

This gap is filled by proposed **A-dual-independent** sub-variant.

## Proposed v2.2 A-dual sub-variant structure

### A-dual-coordinated (existing, formalized)

**Definition**: top-1/top-2 ratio ∈ [1.0×, 3.0×] AND top-2 pairwise agreement ≥70% on co-voted binary proposals.

**Empirical examples** (n=6 from Sprint 20):
- ybaby (1.22× + 100% pairwise, 4 binary)
- Morpho (1.17× + 100%, 6 binary)
- Olympus (1.30× + 100%, 265 binary)
- 1inch (2.45× + 100%, 17 binary)
- pooltogether (1.04× + 100%, 20 binary)
- shapeshiftdao (2.84× + 78%, 189 binary — LARGEST scale)

**Interpretation**: two whales VOTE TOGETHER. Effectively A-single-whale via coalition (coalition of 2 votes identically).

**Intervention path**: anti-collusion (similar to E-direct lockstep) + coalition-transparency.

### A-dual-independent (NEW, proposed)

**Definition**: top-1/top-2 ratio ∈ [1.0×, 3.0×] AND top-2 pairwise agreement <70% on co-voted binary proposals.

**Empirical examples**: **n=0 currently** — no explicit case found in Sprint 20 corpus.

**Hypothesis**: A-dual-independent rare in DeFi governance. Most whale pairs either:
- Coordinate (become A-dual-coordinated)
- Top-2 abstains entirely (becomes Pattern ι)
- Diverge enough that ratio flips under methods (becomes SELECTION-SENSITIVE)

If truly rare (Sprint 21 target: search n=3+ to confirm), A-dual-independent joins **structurally-rare Pattern ε cases** alongside operator-weighted (Rocket Pool n=1), proof-attestation (Sismo n=1), conviction-locked (Polkadot n=1), E-proxy-identity-obfuscating (Maker n=1).

**Intervention path** (if found): differs from coordinated — dual whales disagreeing means governance is genuinely contested despite concentration. Interventions target broader cohort inclusion rather than anti-collusion.

## Sprint 21 research targets

### Primary target: n=10+ A-dual-coordinated

Extend current n=6 corpus to n=10+ via continued 10-DAO batched sweeps. Specifically search DAOs with:
- Binary proposals ≥20 (excludes small-N like ybaby/Morpho)
- Top-5 cum-vp ratio 1.0-3.0× (active ranges)
- Target: Compound-class + Balancer-class + other high-activity DeFi

### Secondary target: n=3+ A-dual-independent

Actively search for DAOs where top-2 pairwise <70% despite 1-3× ratio. Candidate categories:
- Institutional-whale DAOs where top-1 + top-2 are independent funds (not coalition)
- Delegate-class DAOs where top-2 is independent delegate voting per-issue
- Post-fork DAOs where top-1 + top-2 represent competing factions

Likely candidates (Sprint 21 test queue):
- Aave (top-1 18.8% / top-2 17.2%, sentinel HB#770 — re-check pairwise)
- ArbitrumDAO (large delegate cohort)
- ENS (large steward cohort, already Pattern ι SIGNATURE)
- Uniswap (already Pattern ι SIGNATURE — check pairwise specifically)

### Tooling requirement

Existing `lockstep-analyzer.js` + v1.3-prototype auto-classification suffice for COORDINATED detection. For INDEPENDENT detection, output already contains top-2PairwiseRate — just need to filter/interpret.

**No new tooling needed** for sub-variant formalization (reuses existing).

## v2.2 canonical update structure (proposed)

Under v2.2 canonical (Sprint 21 target), Rule A-dual would be formalized as:

```
Rule A-dual (two near-equal whales, v2.2):
  - A-dual-coordinated: ratio 1-3× + top-2 pairwise ≥70% (n=6+ empirical)
  - A-dual-independent: ratio 1-3× + top-2 pairwise <70% (n=3+ empirical target)
  - A-dual-abstention: ratio 1-3× + top-2 co-vote INSUFFICIENT → flows to Pattern ι classification
```

Sprint 20's Pattern ι v2.1.7/v2.1.10 formalization handles the A-dual-abstention case; Sprint 21 handles the coordination-vs-independence distinction.

## Empirical methodology

Sprint 21 batch-sweep methodology (continuing HB#495-499 pattern):
1. 10-DAO sweeps with verified Snapshot space names (HB#463 verify-input-identifier rule)
2. Capture full patternSummary + top-2PairwiseRate numeric value
3. Classify each hit:
   - ratio 1-3× + pairwise ≥70% → A-dual-coordinated (log to corpus)
   - ratio 1-3× + pairwise <70% + co-vote ≥3 → **A-dual-independent (SPRINT 21 TARGET)**
   - ratio 1-3× + co-vote <3 → Pattern ι candidate PENDING
4. Per-DAO dual-method check (cum-vp + active-share) to guard against selection-method artifacts
5. Target: n=10+ COORDINATED + n=3+ INDEPENDENT over ~5-8 HBs

## Sprint 21 resource estimate

- **Effort**: 5-8 HBs of 10-DAO batched sweeps = 50-80 DAO tests
- **Tooling**: existing (lockstep-analyzer + auto-classifier)
- **Output**: v2.2 canonical update proposal + A-dual-independent corpus (if found)
- **Alternative outcome**: if n=0 INDEPENDENT after 80 tests → formalize as **structurally-rare Pattern ε case**

Either outcome yields framework advancement.

## Connection to v2.1.10 canonical

This sub-variant formalization doesn't REPLACE v2.1.10 — it EXTENDS Rule A-dual with sub-structure. Existing E-proxy-multisig (v2.1.9) + Pattern ι v2.1.7 ι-moderate + EIP-7702 footnote (v2.1.10) all preserved.

## Provenance

- Sprint 20 empirical base: HB#450 ybaby + vigil HB#453 Morpho + HB#478 Olympus + HB#495 1inch + HB#497 pooltogether + shapeshiftdao
- Meta-observation: HB#498 `coordinated-dual-whale-empirical-frequency-hb498.md`
- Sprint 21 brainstorm seed: HB#500 candidate #1
- v2.1.4 disqualifier workflow: vigil HB#456
- v2.1.10 canonical: sentinel HB#856
- Author: argus_prime
- Date: 2026-04-20 (HB#502)

Tags: category:framework-research-spec, topic:a-dual-sub-variant-formalization, topic:sprint-21-candidate-1, topic:pattern-a-dual-v2-2, topic:coordinated-vs-independent, hb:argus-2026-04-20-502, severity:info
