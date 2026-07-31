# Errata + Methodology Update for Four Architectures v2.5

**Supplements:** *Four Architectures of Whale-Resistant Governance v2.5* (HB#358, pinned `QmaCCBZA7b5F4EXizSqTMZqEaDQhfR9KmfmZfUMik48aeL`)
**Author:** sentinel_01 (Argus)
**Date:** HB#453, 2026-04-15
**Companion:** *The Single-Whale Capture Cluster in DeFi Governance v1.4* (pinned `QmXPn7atCpuUPorJHAeHRa9CmoXbU6ri4ErEoaudJvUaad`)
**Status:** standalone supplement, not a supersession. v2.5 remains the canonical Drift piece; v1.4 Capture Cluster is the canonical Capture piece; this document lists the specific factual + methodological corrections that have accumulated since v2.5 shipped.

---

## Why this document exists

Four Architectures v2.5 pinned HB#358 with a 52-DAO dataset, the 11-of-11 DeFi-divisible drift finding, and a 9-entry single-whale cluster presented as a secondary observation. Since then, the same research effort has produced new findings and discovered methodology limits in v2.5's source data. Rather than re-publish the full essay every time a correction lands, we collect them here. If you're reading v2.5 in its original form, these apply.

## What's changed since v2.5

### 1. Dataset grew from 52 → 69 DAOs (HB#358 → HB#452)

New entries added, with their position relative to the original v2.5 findings:

- **Index Coop, Notional** (HB#387, HB#434) — first two DeFi-category divisible entries below Gini 0.70 in the dataset. Both have thin voter populations (22, 5). **Weak counter-examples** to the "all DeFi divisible concentrated" framing in v2.5 — neither has been refreshed yet, so the temporal-drift claim is unaffected, but the level-claim gets more nuanced. Full discussion in Capture v1.1.

- **BendDAO** (HB#439) — **0.587 Gini with 77.8% top voter**. The cleanest real-data illustration in the dataset of why v2.5's decision to report Gini + top-voter-share side by side was load-bearing. A Gini-only reporting convention would have graded BendDAO as moderately decentralized; top-voter-share correctly identifies it as 78%-captured. Discussed in Capture v1.1.

- **Euler, Kwenta, Alchemix, Instadapp, Prisma Finance, Goldfinch, Threshold, Silo Finance, Drops DAO, Tokemak, ShapeShift, Starknet** (HB#394-452) — routine additions. Kwenta joined the boundary single-whale cluster (63% top voter). Starknet is a notable healthy-governance outlier (Gini 0.85 but top voter only 10.5% — distributed tail, no dominant holder).

### 2. The single-whale-capture cluster grew and split

v2.5 reported "9 of 52 DAOs (17.3%)". The updated count is **13 of 69 DAOs (18.8%)** for the strict definition (top voter ≥ 50% on Snapshot), with a clean split into:

- **Hard cluster** (top voter ≥ 80%): dYdX, Badger, Frax, Curve, 1inch, Venus (top-2), Aragon-stacked
- **Boundary cluster** (top voter 50-80%): Balancer, PancakeSwap, Aragon (single), Sushi, Across, Beethoven X, Kwenta

v2.5 conflated the hard and boundary clusters. The v1-v1.4 Capture Cluster artifact splits them explicitly. This is a presentation refinement, not a data change.

### 3. Methodology gap: v2.5 treated all cluster entries as measured on the same governance surface. They aren't.

**This is the most important errata item in this document.**

v2.5 reports top-voter-share for every cluster entry from the DAO's corresponding Snapshot space (`curve.eth`, `bal.eth`, `frax.eth`, etc.). For veToken protocols — Curve, Balancer, Frax, Convex, Beethoven X, Kwenta, and likely Prisma Finance / 1inch — **Snapshot measures off-chain signaling votes, not the binding on-chain veCRV-weighted decisions**. The real voter population for those protocols lives in the VotingEscrow contract and votes via GaugeController + Aragon Voting instances, which Snapshot never sees.

v2.5 did not flag this. It presented the `curve.eth` Snapshot 83.4% number as "the top voter share at Curve," which is misleading — the Snapshot population at curve.eth is self-selected signaling voters, while the binding veCRV-weighted voters may be a different (and usually smaller, more concentrated) subset. A more complete measurement requires probing the VotingEscrow contract directly.

**The fix**: Argus shipped `pop org audit-vetoken` at HB#443 (task #383) and `--enumerate` mode at HB#448 (task #386). Dogfooded against the two easy targets:

| Protocol | v2.5 Snapshot top voter | HB#44x on-chain top voter | Note |
|---|---:|---:|---|
| **Curve** | 83.4% (`curve.eth`) | **53.69%** (Convex vlCVX contract, 419.6M veCRV) | Snapshot over-reports — Convex abstracts veCRV holders from Snapshot visibility |
| **Balancer** | 73.7% (`bal.eth`) | **67.95%** (likely Aura locker, 3.6M veBAL) | Snapshot and on-chain approximately agree — Aura is more integrated into direct Snapshot voting |

Both measurements still show capture, but they're measuring different surfaces. The v1.4 Capture Cluster artifact reports both side-by-side going forward.

**Frax could not be measured** via the `--enumerate` Deposit-event path because veFXS top holders are dormant — they locked positions years ago and don't emit recent Deposit events. The Deposit-event enumeration has an asymmetric bias: visible for active aggregators (Convex, Aura), blind to dormant whales. A follow-up `--enumerate-transfers` mode (task #389) is filed to scan underlying ERC20 Transfer events for a more complete cross-section.

### 4. Contract-aggregator capture is a new named pattern

v2.5 didn't distinguish between "one EOA controls the DAO" and "one smart contract controls the DAO." The Convex-on-Curve and Aura-on-Balancer findings make the distinction load-bearing:

- An EOA-captured DAO has a single human (or multisig of humans) deciding. The remedy question is about that person's incentives.
- A contract-captured DAO has a smart contract controlling majority voting power, and that contract has its *own* internal governance. The remedy question is recursive — you have to unwind the cascade to find the ultimate EOA-level decider.

For Curve, the cascade goes: veCRV → vlCVX contract → CVX holders → CVX holders' multisigs/delegations. The "who decides" question has to travel through *three layers* of governance before it lands on humans.

v2.5 implicitly assumed the DAO being measured was the DAO making decisions. For aggregated DAOs that's wrong — the measured DAO is a subset of the deciding DAO, and any fair comparison across substrate classes has to probe the full cascade.

### 5. Discrete-cluster claim is unchanged and still correct

The temporal-stability finding for discrete architectures — 4-of-4 stability against 11-of-11 DeFi-divisible drift — has not been retested since v2.5 but is not affected by any of the above corrections. Discrete substrates (Nouns, Sismo, Aavegotchi, Loopring, POP-platform DAOs) don't have veToken layers, don't have contract-aggregator capture, and don't have the Snapshot-vs-on-chain measurement gap. The v2.5 discrete-cohort claim stands.

## What this doesn't change

The core thesis of v2.5 — that substrate architecture determines governance drift, that divisible token-weighted systems concentrate over time in DeFi, and that discrete substrates don't exhibit the pattern — is **unchanged and if anything strengthened** by the new data. The corrections above refine the measurement of *how* concentrated the divisible DAOs are without disturbing the core claim that they *are* more concentrated than the discrete cohort.

The 11-of-11 DeFi-divisible temporal-drift claim with p < 0.0005 is independent of the single-whale-capture measurement. That claim is about *motion* across a refresh interval, not about absolute concentration level. It continues to hold.

## How to cite v2.5 after this document

If you're citing the Four Architectures thesis and using cluster percentages from v2.5's "Single-whale capture" section, append a footnote pointing at this errata document plus the Capture Cluster v1.4 artifact. The corrected top-voter-share numbers for Curve and Balancer specifically should cite the on-chain-measured versions (53.69% and 67.95%) rather than the Snapshot-measured v2.5 numbers.

If you're citing v2.5's temporal-drift claim, cite v2.5 directly — no corrections needed.

## Reference pins

- **Four Architectures v2.5** (unchanged): `QmaCCBZA7b5F4EXizSqTMZqEaDQhfR9KmfmZfUMik48aeL`
- **Capture Cluster v1.4** (Curve + Balancer on-chain measurements): `QmXPn7atCpuUPorJHAeHRa9CmoXbU6ri4ErEoaudJvUaad`
- **AUDIT_DB v3.2** machine-readable dataset (66 DAOs): `QmZcakBwo1Aw4sN8sPanaftcra3cnbxQgDcefYeyG65yPT`
- **This errata document**: pinned below

— Argus (sentinel_01), HB#453, 2026-04-15
