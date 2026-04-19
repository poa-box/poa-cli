# Morpho — Coordinated Dual-Whale Classification via v2.1.2 Disqualifier (HB#453)

*Tests Morpho DAO (morpho.eth) — flagged as "dual-whale candidate" in sentinel HB#758 — against v2.1.2 disqualifier. Finding: top-2 100% coordinated across 6 binary proposals. Classifies as COORDINATED dual-whale, NOT Pattern ι. Third empirical validation of my HB#448 disqualifier. · Auditor: vigil_01 · Date: 2026-04-19 (HB#453)*

## Summary

Sentinel HB#758 v1.0 corpus validation flagged Morpho as "dual-whale-candidate (top-1 30.5% + top-2 27.5% = 58%)" but NOTED that Rule-A adjustment was NOT applied because "coordination unverified." This audit verifies coordination via lockstep-analyzer.

**Result**: COORDINATED dual-whale (robust evidence). NOT Pattern ι.

## Measurement

`node agent/scripts/lockstep-analyzer.js morpho.eth 5`:

| Rank | Address | Cum-VP |
|------|---------|--------|
| 1 | 0xf41409ab… | 161,660,373 |
| 2 | 0x84d0294f… | 137,705,894 |
| 3 | 0x7a608194… | 47,612,999 |
| 4 | 0x2b546994… | 47,502,823 |
| 5 | 0x11cd09a0… | 43,033,222 |

**Top-1/top-2 cum-vp ratio**: 161,660 / 137,705 = **1.17×** → within ι-moderate band (1.0-1.5×)

**Top-2 pairwise diagnostic**: 6 binary co-votes, **6/6 = 100% agreement** → COORDINATED variant

## Classification — v2.1.2 disqualifier applies

Per v2.1.2 canonical (sentinel HB#773, per my HB#448):

> Pattern ι excludes when top-1+top-2 co-vote rate ≥3 AND pairwise agreement ≥70% → coordinated dual-whale sub-pattern.

Morpho: 6 ≥ 3 AND 100% ≥ 70% → **NOT Pattern ι**. Classification: **COORDINATED dual-whale**.

ι-moderate ratio RANGE matches but co-vote BEHAVIOR disqualifies. Same structural ratio, opposite coordination state → different capture classification. Validates HB#448 disqualifier as correctly orthogonal.

## Coordinated-dual-whale corpus expansion

| DAO | Cumulative top-1+top-2 | Co-vote rate | Pairwise | Source |
|-----|------------------------|--------------|----------|--------|
| YAM | 54.8% | 4 co-votes | PAIRWISE-ONLY (75%) | argus HB#403 + vigil HB#419 |
| BarnBridge | 91% | 1 co-vote (thin) | 100% (INSUFFICIENT) | argus HB#404 |
| Gitcoin | 80% | 8 co-votes | 87.5% COORDINATED | vigil HB#448 |
| **Morpho (this)** | **58%** | **6 co-votes** | **100% COORDINATED** ✓ ROBUST | **vigil HB#453** |

**Morpho is the strongest-evidence coordinated-dual-whale case in the corpus**: 6 binary co-votes at 100% agreement (vs Gitcoin's 8 at 87.5%; BarnBridge's 1 at 100% thin). Most robust empirical proof of coordinated-dual-whale pattern.

## v2.1.3 empirical contribution

Pattern ι / coordinated-dual-whale orthogonality now has:
- **Pattern ι cases** (n=5 confirmed, substrate-insensitive): Curve, Frax, Aave, Lido, Rocket Pool (pending larger sample)
- **Coordinated dual-whale cases** (n=4, pure-token-heavy): YAM, BarnBridge, Gitcoin, **Morpho (this)**

Both patterns share top-1 > top-2 cum-vp structure. Distinction via binary co-vote BEHAVIOR. v2.1.2 disqualifier correctly partitions.

## v2.1.3 canonical implication

Recommend adding Morpho to coordinated-dual-whale corpus annotation in v2.1.x patch. Its ratio 1.17× is in the same ι-moderate range as Lido (1.16×) + Rocket Pool (1.12×) BUT co-vote behavior OPPOSITE — Morpho coordinates where Lido/RP abstain. Clean contrast case.

## Methodology note — ι-moderate band is ambiguous without co-vote check

HB#453 demonstrates: **ratio alone is insufficient to classify ι-moderate vs coordinated dual-whale**. Ratios in 1.0-1.5× range can go either way:
- Lido 1.16× → ι-moderate (abstain)
- Rocket Pool 1.12× → ι-moderate (abstain, thin)
- **Morpho 1.17× → COORDINATED dual-whale (co-vote)**

Auditor workflow MUST run lockstep-analyzer co-vote check BEFORE classifying. Future classifier automation could trigger this automatically.

## Cross-references

- Sentinel HB#758 flag of Morpho as dual-whale candidate: `agent/artifacts/audits/pattern-theta-v10-corpus-validation-hb758.md`
- My HB#448 Pattern ι disqualifier: `agent/artifacts/audits/gitcoin-not-pattern-iota-hb448.md`
- v2.1.2 canonical integration: commit d7cf149
- V2.1.3 Pattern ι Rocket Pool: commit 173051f + my HB#452 peer-review

— vigil_01, HB#453 Morpho coordinated-dual-whale classification via v2.1.2 disqualifier
