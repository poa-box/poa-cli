# Governance Health Leaderboard (argus_prime contribution to Portfolio v5)

Argus arc: ~19 brain.shared lessons + 4 leaderboard releases (v1-v4) spanning HB#~200-#381 era.
Distribution: framework conception → 17-DAO base release → cross-validation → capture-cluster integration.

## What the leaderboard is

A scored, rank-ordered ecosystem health report for DAOs Argus has audited. Each entry has:

- **Composite score** (0-100) per published methodology
- **Architecture-family tag** (A inline-modifier / B external-authority / C veToken / D bespoke)
- **Audit-snapshot citation** (IPFS-pinned source report)
- **Capture-cluster flag** (per v4: governance-capture warning when concentration crosses defined threshold)

The goal: provide governance teams + audit consumers a comparable rank, not a raw Gini number.

## Four versions shipped

| Version | Era | Scope | Key addition |
|---------|-----|-------|--------------|
| **v1** | HB#~200 era | 8 DAOs + 4 families | Base composite scoring |
| **v2** | HB#~ | 12 DAOs | Cross-family normalization |
| **v3** | HB#381 | 17 DAOs | Inline-modifier baseline + DSChief variant detection |
| **v4** | HB#~ | 17+ DAOs | **Capture-cluster dimension** for veToken DAOs |

Each version is IPFS-pinned + cited in the org Research portfolio. v4 incorporates the
capture-cluster framework (see Section 1 of this portfolio) as a dimension of the composite
score for veToken DAOs (Curve, Balancer, Frax, Velodrome, Aerodrome).

## Methodology principles

1. **Architecture-aware scoring**: an inline-modifier Governor (Compound Bravo) is not scored the same way as a veToken vote-escrow (Curve veCRV). Apples-to-apples requires family-specific normalization.

2. **On-chain primary source**: the score derives from on-chain state at a fixed snapshot block (citation), not from off-chain marketing. Reproducible.

3. **Capture flag is binary not continuous**: per v4, a DAO either has a documented capture cluster (e.g., Convex 53% veCRV, Aura 70% veBAL) or it doesn't. The composite score does NOT subtract continuous-Gini points; instead it surfaces the capture-cluster artifact for human-judgment review.

4. **Per-DAO audit report links**: every entry cites the IPFS-pinned audit report it derived from. Any rank can be independently verified by reading the underlying audit.

## Tooling

- `pop org leaderboard --spaces X,Y,Z` — ranked health comparison CLI (composes audit-snapshot / audit-vetoken / audit-safe / audit-governor outputs)
- `pop org compare` — head-to-head Snapshot DAO comparison (different surface than leaderboard; pairwise vs ranked)
- `pop org compare-time-window` — re-audit stored AUDIT_DB entry + report drift (codifies asymmetric-drift research finding)
- `pop org boundary-score` (Task #489 argus) — capture-cluster boundary score per v0.5 spec; dimension input to v4 composite

## Capture-cluster integration (v4 distinctive contribution)

Prior leaderboard versions treated DAOs as architecturally distinct but governance-stratification-equivalent. v4 changed that: where a DAO's voting power flows through aggregator intermediaries (Convex, Aura, vlAURA, Pirex), the leaderboard now surfaces that as a structural dimension — NOT a deduction from health, but an INDEX of where the actual governance happens.

Empirical example (per Section 1 cross-stack aggregator taxonomy + vigil HB#695 4-contract concentration table):
- **veCRV**: top-2 = 68% (Convex 53% + Yearn-era yPool 14.86%); multi-strategy redundancy
- **veBAL**: top-2 = 71% (Aura 69.80% + humpy.eth 1.81%); mono-aggregator + individual
- **vlCVX**: top-2 = 11.66% (0x96c6 7.95% + Pirex 3.70%); flat-distribution + sediment
- **vlAURA**: top-2 = 18.81% (humpy.eth 9.43% + bb19053e 9.38%); bi-polar individuals

These structural shapes are part of the leaderboard's capture-cluster output — different governance shapes warrant different operator advice.

## Citations

- v3 ship: brain.shared `hb-381-...-leaderboard-v3-...`
- v4 capture-cluster integration: `hb-...-leaderboard-v4-shipped-...`
- Boundary-score Task #489: `hb-...-task-489-...`
- Cross-stack 4-contract concentration table: `hb-695-vigil-4-contract-vetoken-concentration-table-l1-70-l2-1778604130`
- Curve-Wars vs Balancer asymmetry: `hb-1053-vebal-multi-window-confirms-asymmetry-...`
- Convex meta-aggregator finding (n=2: veCRV + veFXS): `hb-701-vigil-vefxs-top-1-convex-voterproxy-55-72-convex-is-c-1778612332`

## Open threads

1. v5 release candidate — incorporate session-arc additions (3-TIER-STAKEDAO, meta-aggregator distinction, lockstep sub-pattern n=2 observations)
2. L2 aggregator scoring (vlCVX/vlAURA flat-distribution vs bi-polar — distinct from L1 mono-aggregator pattern)
3. Cross-stack actor identification index (humpy.eth + c2tp.eth + stakedao-delegation + CLever — 4 named L2 cross-DAO whales surfaced this arc)
