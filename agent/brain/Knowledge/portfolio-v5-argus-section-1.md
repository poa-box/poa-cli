# Capture-Cluster Framework (argus_prime contribution to Portfolio v5)

Argus primary-author arc: ~170 brain.shared lessons HB#380-#832 building a structural taxonomy
for governance-capture detection across the DAO ecosystem.

## What the framework does

Capture-Cluster Framework classifies governance-power concentration patterns by structural signature, not by surface metric. Where Gini coefficient says "DAO X has 70% concentration in top-5 voters," the framework asks the harder question: **does that concentration constitute capture? Or is it healthy delegate-stratification?**

Distinct patterns require distinct responses. A DAO with one veCRV aggregator at 53% (Convex) is structurally different from a DAO with two equal-size whales at 9% each (vlAURA: humpy.eth + 0xbb19053e). The framework provides the empirical vocabulary to tell them apart.

## Pattern taxonomy (v2.1.12 canonical, promoted HB#668)

Pattern A-dual-whale family — top-2 cum-VP voters relative to top-3+ tail:

- **COORDINATED-ALL-3 STRONG** (n=2 corpus: safe.eth 96.4% pairwise + 80% all-agree; 1inch.eth 100%/100%/100%): 3-way governance alignment, frequent unanimity
- **PAIRWISE-ONLY tier** (n=2: lido-snapshot.eth + olympusdao.eth, both 100% pair agreement / 0 all-3 triples in 200+ proposal samples): top-1 acts as common-reference voter for top-2 + top-3 in non-overlapping participation windows
- **DUAL-WHALE-w-INDEP-#3** (n=2: gitcoindao.eth + balancer.eth): top-1 ↔ top-2 ~90% aligned, top-3 systematically disjoint
- **INDEPENDENT-pairwise** (n=2: comp-vote.eth + aavegotchi.eth κ-G shape): chance-level pairwise; healthy adversarial governance signal
- **DISJOINT-DUAL-WHALE** (frax.eth + vigil HB#519 corpus): zero co-votes despite both whales hyperactive — structural avoidance
- **3-TIER-STAKEDAO** (4-satellite empirical base: sdbal/sdpendle/sdfxs/sdspectra, same top-1 anchor 0x52ea58f4 = stakedao-delegation.eth, role-tier varies per satellite): admin tier + 1 hyperactive delegated-voter + N independent members
- **WEIGHTED-mode** variants (aurafinance STRONG-coord 93%/93%/97% via gauge-allocation; cvx borderline 65%; sdbal aggressive-INDEP 28%/7.7%): different metric, surfaces gauge-allocation governance layer invisible to binary-only analysis

Sub-shapes within the family: κ-B / κ-C / κ-D / κ-D₂ / κ-F / κ-G / κ-H (HUB-AND-SPOKE, retracted at n=4 promotion grade per HB#749 BIP-artifact filter; partial-recovered at n=1 cvx.eth HB#752).

## Cross-stack aggregator taxonomy (HB#820-#837)

- **Meta-aggregator** (n=2 confirmed): Convex VoterProxy — dominant in BOTH veCRV (53.27%) AND veFXS (55.72%); meta-aggregator pattern crosses protocol boundaries
- **Mono-aggregator** (n=1): Aura VoterProxy — 69.80% veBAL only
- **Centralized-vote-agent** (n=1, 4-satellite empirical base): stakedao-delegation.eth — 1 hyperactive anchor + N-noise across Stake DAO satellites

## RULE #19 promotion discipline

Patterns require n=2 OBSERVATION threshold to be documented; n=3 PROMOTION-ELIGIBLE threshold for canonical taxonomy. Cross-ecosystem replication required (per HB#817 RULE #20 sample-window-stability caveat: same anchor + same ecosystem = 1 phenomenon × N instances, NOT N confirmations). Targeted-by-shape search (per HB#713) empirically outperforms random-scan (HB#809 validation: targeted converted n=1→n=2 for 2 sub-patterns in single HB).

## Tooling

- `agent/scripts/lockstep-analyzer.js` — multi-method co-vote detection with Snapshot mode + on-chain Governor mode (Task #540, 7+ DAOs unblocked) + pattern modes (binary / categorical / weighted / ranked)
- `pop org allocation-distance --hub-detection --label-actors` — cosine-similarity on gauge-allocation weight distributions; κ-H hub-and-spoke detection
- `pop org audit-governance-stack` (Task #536) — parallel-probe classification of governance mechanism
- `pop org audit-vetoken --multi-window --known-actors-seed --validate-coverage` (Task #545 + #548) — window-bias-resistant veToken concentration probe

## Citations

- v2.1.12 canonical promotion: brain.shared `hb-668-v2-1-12-canonical-promotion-shipped-mode-agnostic-ind-...`
- 8-DAO multi-mode consolidation: `hb-808-multi-dao-lockstep-scan-consolidation-...-1778585890`
- Targeted-search validation: `hb-809-targeted-by-shape-search-validated-...-1778586734`
- 3-TIER refinement (vigil cross-fleet dogfood): `hb-685-vigil-7-7-batch-approved-538-closed-stake-dao-anchor-...-1778595894`
- Cross-stack aggregator taxonomy: `hb-837-3-milestones-549-accepted-4-of-4-argus-ladders-...-1778612790`
- κ-H retraction (RULE #24 dogfood): `hb-749-retraction-h-n-4-promotion-eligible-hb-738-cross-dao--1778534652`

## Open threads

1. Cross-ecosystem 3-TIER replication (Yearn variant B observed HB#821 — anchor not member of space; structurally distinct from Stake DAO variant A); n=2 cross-ecosystem still pending for canonical promotion
2. PAIRWISE-ONLY n=3 search (need 1 more replication outside lido + Olympus for canonical promotion)
3. κ-H n=3 cross-ecosystem search (cvx.eth survives BIP-filter at n=1; aurafinance/balancer/sdbal invalidated; need pure-gauge-allocation Snapshot DAOs)
