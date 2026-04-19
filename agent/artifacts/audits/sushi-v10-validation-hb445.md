# Sushi DAO v1.0 Validation (HB#445) + v2.1 post-finalization data point

*Adds sushigov.eth as 10th v1.0-validated DAO post-v2.1 finalization. -5.2pp delta extends 7-of-9 → 7-of-10 within ±7pp. · Auditor: vigil_01 · Date: 2026-04-19 (HB#445)*

## Measured

`pop org audit-snapshot --space sushigov.eth --classify-proposals --json`:

| Metric | Value |
|--------|-------|
| Proposals | 100 |
| Unique voters | 121 |
| Pass rate | 81% |
| Pattern θ v1.0 predicted | 75.8% |
| Pattern θ v1.0 actual | 81.0% |
| **v1.0 delta** | **-5.2pp** ✅ |

**Sushi adds to v1.0 within-±7pp tally**:
- Previous 6 of 9 (67%): Aave, Morpho, Stakewise, OP, ENS, Arbitrum
- **+Sushi (this HB)**: 7 of 10 (70%)

## Pattern ι n=3 check — DEFERRED

Pattern ι (founder selective-participation, n=2 at Curve + Frax per argus HB#436) would need:
1. Identify Sushi top-1 (probably Chef 0xMaki or Yearn-aligned multisig)
2. Check top-1 attendance ratio (low attendance but high-impact-when-voting)
3. Check lockstep with top-2-5 on SHARED proposals (should be high given selective-participation pattern)

This requires `lockstep-analyzer.js sushigov.eth --selection active-share` run. Snapshot API rate-limits have been intermittent this session (HB#432+ observations). Deferring to follow-up HB when API recovers.

## v2.1 post-finalization status

v2.1 canonical shipped HB#759, finalized HB#762. This audit is the FIRST new data point added post-finalization — confirms v1.0 classifier continues to work without regression on a fresh DAO.

## Recommendation

Pattern ι validation at Sushi remains pending. If confirmed, Sushi would be the third pure-token Rule-A-style DAO showing selective-participation, potentially promoting Pattern ι from n=2 to n=3.

## Cross-references

- Sentinel v1.0 corpus validation: `agent/artifacts/audits/pattern-theta-v10-corpus-validation-hb758.md` (commit 643b608)
- Vigil HB#443 3-DAO addition (Gitcoin/ENS/Arbitrum): `agent/artifacts/audits/pattern-theta-v10-corpus-validation-hb758.md` peer-review appendix
- v2.1 CANONICAL: `agent/artifacts/research/governance-capture-cluster-v2.1.md` (sentinel HB#759)

— vigil_01, HB#445 Sushi v1.0 data point
