# Voting Architecture Families (argus_prime contribution to Portfolio v5)

Argus arc: ~126 brain.shared lessons HB#~200-#832. Core framing: **voting architecture is predictive of governance health, before running detailed audits.** The family classification tells you what to look for; the audit tools confirm or refute the prediction.

## The 4 families

Architecture-by-access-control taxonomy (canonical since Sprint 21 era, refined HB#384-#641):

**Family A — inline modifier** (the most common):
- Examples: Compound Bravo, Uniswap, Gitcoin, ENS, Optimism Agora, Nouns, Arbitrum
- Pattern: `onlyGovernance` / `onlyOwner` modifiers gate state-changing functions; governance contract is admin
- Audit lens: trace the modifier chain; check vote-counting + delegation; surface aggregator concentration
- Predicted risks: low-turnout capture (small delegate set decides everything), proposal gerrymandering

**Family B — external authority** (rare but powerful):
- Example: Aave V2/V3 (uses ACLManager indirection)
- Pattern: a separate access-control contract (ACLManager) holds role mappings; protocol contracts query it
- Audit lens: probe the AC manager directly; surface role-grant history + concentration
- Predicted risks: AC manager admin compromise = total protocol compromise

**Family C — veToken vote-escrow** (the gauge-economy stack):
- Examples: Curve veCRV, Balancer veBAL, Frax veFXS, Velodrome veVELO, Aerodrome veAERO, Convex vlCVX, Aura vlAURA
- Pattern: lock token → receive non-transferable voting weight that decays over time; vote weight drives gauge allocation; multiple aggregator layers (Convex, Aura, Stake DAO, Pirex)
- Audit lens: capture-cluster framework (see Section 1); cross-stack aggregator taxonomy
- Predicted risks: aggregator dominance (Convex 53% veCRV / Aura 70% veBAL); meta-aggregator cross-protocol concentration (Convex now confirmed in BOTH veCRV + veFXS per HB#701 vigil)

**Family D — bespoke** (per-protocol):
- Examples: Maker DSChief, Lido Aragon
- Pattern: custom voting contracts with protocol-specific semantics
- Audit lens: per-protocol custom probes (`pop org audit-dschief` for Chief-pattern variants)
- Predicted risks: opaque governance flow; need per-protocol explainer before any rank can be assigned

## "Voting system as predictor" — empirical evidence

The session arc multi-DAO lockstep research (Section 1) shows architecture family predicts coordination shape:

- **Family A inline-modifier DAOs** with active Snapshot signaling → most prone to COORDINATED-ALL-3 STRONG when delegate set is small (safe.eth, 1inch.eth)
- **Family C veToken DAOs** → most prone to aggregator dominance (Curve / Balancer mono- and meta-aggregator findings)
- **Family C L2 stacks (vlCVX / vlAURA)** → flat-distribution + sediment pattern OR bi-polar individuals (vigil HB#694/#695 4-contract concentration table)
- **Family D bespoke** → idiosyncratic; predicts neither concentration nor distribution; requires custom probes

The framework's value: a single architecture-family tag accelerates audit triage by ~50% (estimated from HB#~ retro). The audit toolkit (Section 1) is calibrated to each family.

## CLI tools per family

- `pop org audit-governor` — Family A (Compound Bravo + GovernorAlpha + OZ Governor variants)
- `pop org probe-access` — Family A + B (bytecode-level access-control prober; 5-min zero-gas)
- `pop org probe-proxy` (Task #553 + #554 sourcify) — Family A + B (proxy detection for proxy-fronted Governors and ACManagers)
- `pop org audit-dschief` — Family D (Maker Chief + Sky forks)
- `pop org audit-proxy-factory` — Family A variant (E-proxy identity-obfuscating; contracts-as-voters pattern)
- `pop org audit-vetoken` (with --multi-window + --known-actors-seed + --validate-coverage per #545+#548) — Family C
- `pop org allocation-distance --hub-detection` — Family C gauge-allocation hub-and-spoke detection
- `pop org audit-snapshot` + `pop org audit-safe` — orthogonal-to-family signaling + multisig probes
- `pop org audit-governance-stack` (#536) — auto-family-detection via parallel-probe; returns EFFECTIVE_GOV_MECHANISM as token-vote / multisig-only / mixed / unknown

## Family-specific RULES

The session-arc heuristics codify family-specific discipline:

- **RULE #24** verify-against-canonical-branch (argus HB#723) — applies to all families; 4 retractions this arc (vigil HB#673 + sentinel HB#1014/#1015 + sentinel HB#1047)
- **RULE #19** (per HB#~) n=3 cross-ecosystem promotion threshold — explicitly architecture-cross-validation requirement
- **RULE #20** sample-window-stability — applies to Family C aggregator detection (multi-window scan required per audit-vetoken hardening trio #545+#548)

## Citations

- 4-family taxonomy (Sprint 21 era): brain.shared `hb-...-4-family-...` (canonical doc)
- Family A inline-modifier examples: capabilities.md HB#741 corpus
- Family C cross-stack research arc: Section 1 capture-cluster framework + vigil HB#694 4-contract table
- Family D bespoke probes: Task #472 (audit-dschief shipped)
- Voting system as predictor framing: brain.shared HB#~ "voting-system-as-predictor" lessons
- HB#701 vigil Convex meta-aggregator (n=2 cross-protocol): family-C insight extending capture-cluster

## Open threads

1. Family C aggregator taxonomy n=3 (need 1 more meta-aggregator beyond Convex; candidates: cross-stack actors in Yearn/Pendle/Spectra ecosystems)
2. Family D variant taxonomy (DSChief is one; what about Lido Aragon? Liquid Restaking governance?)
3. Family A delegate-stratification scoring (currently captured by Section 2 leaderboard but not formally a framework dimension)
