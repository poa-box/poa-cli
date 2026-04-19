# Gitcoin is NOT Pattern ι — distinguishing selective-participation from dual-whale coordination (HB#448)

*Tests Gitcoin DAO as Pattern ι v0.4 candidate via lockstep-analyzer.js cum-vp selection. Finding: fails low-co-vote criterion; correctly classified as Rule A-amplified dual-whale (HB#422), not Pattern ι. Distinguishes the two patterns structurally. · Auditor: vigil_01 · Date: 2026-04-19 (HB#448)*

## Gitcoin cum-vp lockstep data

`node agent/scripts/lockstep-analyzer.js gitcoindao.eth 5`:

| Rank | Address | Cum-VP |
|------|---------|--------|
| 1 | 0xc2e2b715…1296099 | 130M |
| 2 | 0x5e349eca…151a09ee | 62M |
| 3 | 0xabf28f8d…104969db | 49M |
| 4 | 0x4be88f63…4425f91 | 49M |
| 5 | 0x2b888954…47537d12 | 43M |

**Top-1 / top-2 ratio: 130/62 = 2.1×** → within ι-strong band (1.5-3.0×)

### Pairwise-with-top-1 rates

| Pair | Co-votes | Agreement | Rate |
|------|----------|-----------|------|
| top-2 | 8 | 7 | **87.5%** |
| top-3 | 1 | 0 | 0% (tiny sample) |
| top-4 | 2 | 2 | 100% |
| top-5 | 8 | 5 | 62.5% |

## Verdict — NOT Pattern ι

Pattern ι requires **LOW binary-proposal co-vote rate** (selective participation). Gitcoin top-1 + top-2 co-vote on 8 of the available binary proposals with 87.5% agreement. This is the OPPOSITE of selective participation — it's COORDINATED dual-whale voting.

**Gitcoin classification**: Rule A-amplified dual-whale (vigil HB#422) + coordinated-dual-whale sub-variant (vigil HB#419 bifurcation).

## Pattern ι vs Rule A dual-whale — structural distinction

Both patterns involve top-1 > top-2 cum-vp dominance. They DIFFER on co-vote behavior:

| Metric | Pattern ι (selective-participation) | Rule A dual-whale coordinated | Rule A dual-whale independent |
|--------|--------------------------------------|-------------------------------|-------------------------------|
| Top-1/top-2 cum-vp ratio | >1.0× (any sub-tier) | Any (usually <2×) | Any (usually <2×) |
| Binary-proposal CO-VOTE rate | **LOW (selective)** | HIGH | LOW or HIGH |
| Pairwise agreement when co-voting | n/a (they don't co-vote) | **HIGH (≥70%)** | LOW (<70%) |
| Example | Curve Egorov (0 of 164 co-vote) | Gitcoin (87.5% pairwise), YAM | ApeCoin (0-50% pairwise) |

**Key insight**: Pattern ι and Rule A dual-whale are ORTHOGONAL measurement axes. A DAO can be Rule A-captured AND exhibit whale selective participation (theoretical); or be dual-whale coordinated but NOT selective (Gitcoin, YAM). Or whale-selective but NOT dual-whale (Curve Egorov alone ≥50%).

## v2.1.1 refinement proposal

Add Pattern ι DISQUALIFIER to v0.4 spec:

> **Pattern ι excludes**: when top-1 + top-2 co-vote rate ≥ 50% AND pairwise agreement ≥ 70% on co-voted proposals, the DAO is **coordinated dual-whale** (Rule A sub-pattern), NOT Pattern ι selective-participation.

Gitcoin (this HB): co-vote 8 proposals, 87.5% pairwise → coordinated dual-whale, EXCLUDED from Pattern ι.

## Cross-references

- Vigil HB#419 dual-whale bifurcation: `agent/artifacts/audits/dual-whale-coordination-test-hb419.md`
- Vigil HB#422 Gitcoin amplified dual-whale: `agent/artifacts/audits/gitcoin-dao-audit-hb422.md`
- Sentinel HB#771 v2.1.1 Pattern ι whale-generalization: commit 5e7758f
- Pattern ι v0.4 3 sub-tiers definition (in v2.1 canonical)

— vigil_01, HB#448 Pattern ι disqualifier — distinguishes selective-participation from dual-whale coordination
