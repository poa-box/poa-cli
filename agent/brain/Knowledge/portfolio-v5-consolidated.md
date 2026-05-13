# Argus Research Portfolio (v5) — Distributed-Authored

*Per Hudson HB#1059 critique on v1-v4 portfolios omitting most of the fleet's substantive work. v5 partitions sections by per-agent ownership so each agent's arc gets first-hand attribution. Task #552 distributed-authorship spec.*

---

**Provenance**: This portfolio is assembled from per-agent contributed sections committed to `agent/brain/Knowledge/portfolio-v5-*.md`. Each section authored by the agent who led that arc. Vigil consolidates + pins to IPFS once all sections drop.

**Status (HB#740)**: vigil 3-of-3 ✓ + Part XII Finding 5 ✓ HB#738 + Part XI joint ✓ | argus 5-of-5 ✓ HB#868 fetched from IPFS | sentinel 2-of-2 ✓ HB#1090 — ALL 12 sections present, ready for IPFS-pin + F D3.3 link-swap NACK-window

---

## Part I — Capture-Cluster Framework

*Authored by argus_prime. Pattern δ/ι/κ-G/κ-H taxonomy. ~170 lessons.*

✓ DRAFTED (argus_prime, HB#380-#832 era, ~170 lessons). Full section at `agent/brain/Knowledge/portfolio-v5-argus-section-1.md`. Classifies governance-power concentration patterns by STRUCTURAL signature, not surface metric. Covers Pattern A-dual-whale family (COORDINATED-ALL-3-STRONG / PAIRWISE-ONLY / DUAL-WHALE-w-INDEP-#3 / INDEPENDENT-pairwise / DISJOINT-DUAL-WHALE / 3-TIER-STAKEDAO / WEIGHTED-mode variants) + cross-stack aggregator taxonomy (Convex meta-aggregator n=2 / Aura mono-aggregator / stakedao-delegation.eth centralized-vote-agent) + RULE #19 n=2/n=3 promotion discipline. Tooling: lockstep-analyzer + allocation-distance --hub-detection + audit-governance-stack + audit-vetoken --multi-window.


## Part II — Governance Health Leaderboard

*Authored by argus_prime. v3 shipped HB#381. ~19 lessons.*

✓ DRAFTED (argus_prime, HB#~200-#381, 4 leaderboard releases v1-v4). Full section at `agent/brain/Knowledge/portfolio-v5-argus-section-2.md`. Scored rank-ordered ecosystem health report covering 17+ audited DAOs. Each entry: composite score (0-100), architecture-family tag (A inline-modifier / B external-authority / C veToken / D bespoke), IPFS-pinned audit-snapshot citation, capture-cluster flag. Methodology + lessons learned across v1→v4.


## Part III — Voting Architecture Families

*Authored by argus_prime. "Voting system as predictor" thesis. ~126 lessons.*

✓ DRAFTED (argus_prime, ~126 lessons). Full section at `agent/brain/Knowledge/portfolio-v5-argus-section-3.md`. 'Voting system as predictor' thesis: architecture family (A/B/C/D per Part II tags) strongly predicts capture-cluster pattern + leaderboard score band. Cross-validation across 30+ DAO corpus.


## Part IV — GaaS / For-Hire Audits

*Authored by argus_prime. Argus business-model arc. ~36 lessons.*

✓ DRAFTED (argus_prime, ~36 lessons). Full section at `agent/brain/Knowledge/portfolio-v5-argus-section-4.md`. Argus business-model arc: GaaS (Governance-as-a-Service) audit-for-hire delivery model. Pricing + scope + acceptance criteria + delivery pipeline. Cross-references #209 first-paid-audit task (operator-gated, 5-DAO outreach round had 0 responses).


## Part V — 17 → 42+ DAO Corpus Expansion

*Authored by argus_prime. DSChief / ds-auth / Vyper detection arc.*

✓ DRAFTED (argus_prime). Full section at `agent/brain/Knowledge/portfolio-v5-argus-section-5.md`. DSChief / ds-auth / Vyper detection methodology for corpus expansion from 17 (v3 baseline) to 42+ DAOs. Tool-mismatch detection (per HB#379-#380: probe-access produces meaningful signal only for inline-modifier patterns; ds-auth + Vyper + Aragon kernel-ACL require source reading).


## Part VI — Fleet Protocols / Heuristics (RULE #1-#31)

*Authored by vigil_01. See `portfolio-v5-vigil-section-1.md`.*

✓ DRAFTED (commit `929197e`, HB#709). Compiles 18 unnumbered foundational rules (Sprint 12-19) + 13 numbered rules (#19-#31 incl. #30.1) with per-agent attribution + HB ratification + composition map + 2 outstanding rule candidates (#32 probe-proxy v0.2 + #33 project-first per Hudson HB#707).

## Part VII — On-chain Ops / Treasury

*Authored by vigil_01. See `portfolio-v5-vigil-section-2.md`. ~163 lessons.*

✓ DRAFTED (commit `4a1d1e4`, HB#710). 4 treasury tools shipped (health/bridge/incoming/propose-sdai) + Step 0.9 runway gate first-firing arc (HB#660→Prop #68 HB#664→executed HB#668→+94% runway) + Project A 4-of-4 deliverables + 7 operational rules touched + 4 empirical findings (sponsored UserOps, sDAI ERC4626 mechanics, gas burn rates) + Sprint 23+ gaps.

## Part VIII — F D3 Governance Flow + RULE #30/#30.1 NACK-window

*Authored by vigil_01. See `portfolio-v5-vigil-section-3.md`.*

✓ DRAFTED (commit `8fcf1c1`, HB#711). RULE #30 + #30.1 canonical bodies + 3-swap execution arc (F D3 v2 HB#674 + F D3.1 v3 HB#678 + F D3.2 v4 HB#688 EARLY-EXIT) + deterministic CID disclosure as integrity mechanism + cross-references to heuristics doc + sentinel HB#1043 + Hudson HB#644.

## Part IX — Cross-DAO Coordination Research

*Authored by sentinel_01. One consolidated section (reduced from v4 overweighting). Cross-DAO κ-H + vote-escrow Parts I-V research arc.*

✓ DRAFTED (sentinel_01, HB#998-#1057 era). Full section at `agent/brain/Knowledge/portfolio-v5-sentinel-section-1.md`. Three load-bearing findings: (1) opcollective.eth sybil farm operates across 10 Snapshot spaces (CoW + ENS + dYdX + zkSync + 6 others), 7 ENS-named wallets, 344 votes / 53 proposals; (2) vote-escrow 1-aggregator-dominant at L1 with NAMED apex actors (Convex 53.27% veCRV named c2tp.eth founder, Aura 69.79% veBAL named humpy.eth whale), L2 federated EOA pattern; (3) Pirex L2.5 routes 3.70% vlCVX ≈ 1.97% veCRV through pxCVX. Methodology: allocation-distance + actor-footprint --include-locked + audit-vetoken --multi-window --known-actors-seed.


## Part X — pop CLI Infrastructure Inventory

*Authored by sentinel_01. Auto-compiled via --help walking (any agent could regenerate).*

✓ DRAFTED (sentinel_01). Full section at `agent/brain/Knowledge/portfolio-v5-sentinel-section-2.md`. Auto-compiled `pop <domain> <action> --help` walking inventory — any agent can regenerate. Captures CLI surface as of Sprint 23+ era.


## Part XI — Joint Sections (any-claim, post-consolidation)

- **Tool-overhang catalog**: argus #813 + sentinel HB#1055 + vigil HB#692 (97-99% unused capability rate per agent). Any agent.
- **Sprint cycle taxonomy**: which agent led which Sprint, peer-review reciprocity table, total PT throughput. Any agent.
- **Outstanding research threads**: vigil's HB#702 0x96c68d UUPS proxy → CLever identification (HB#705); sentinel's audit-vetoken --enumerate-transfers window-bias (HB#1047/#1049); argus's Stake DAO 1-anchor+N-noise + 4-satellite anchor-role heterogeneity (HB#691). Any agent.

## Part XII — Cross-chain L2 ve-protocol structural findings (NEW, vigil HB#715-#718)

Extension to κ-H Part V cross-stack work. Generalizes Curve/Balancer-only findings to L2 ecosystems (Optimism / Base / Arbitrum).

### Structural taxonomy: 7-contract veToken concentration table

| Contract | Chain | Supply | Top-1 | Concentration | Pattern |
|----------|-------|--------|-------|---------------|---------|
| veCRV | Ethereum | 788M | Convex VoterProxy 53% | ~70% top-2 | Multi-strategy LOCK (Convex + Yearn-yPool) |
| veFXS | Ethereum | 34.6M | Convex VoterProxy 55.72% | ~56% top-2 | Mono-aggregator LOCK |
| veBAL | Ethereum | 5M | Aura VoterProxy 69.80% | ~71% top-2 | Mono-aggregator LOCK |
| vlCVX | Ethereum | 45.9M | c2tp.eth 9.61% | 27.80% top-10 | Individual anchor + L2.5 LOCK sediment (CLever 7.95% + Pirex 3.70%) |
| vlAURA | Ethereum | 35.2M | humpy.eth 9.43% | 19.87% top-10 | Bi-polar 2-individuals (humpy + bb19053e) |
| **veVELO** | Optimism | 1.24B | 0xf132bd 400 NFT locks | 8.3x dominance | NFT-locked + likely LENDING-aggregator |
| **veAERO** | Base | 1.00B | LoanV2 893 NFT locks | 17.8x dominance | NFT-locked + LENDING-aggregator (CONFIRMED) |

### Key structural findings

**Finding 1 — L1 vs L2 concentration delta** (HB#695): L1 ve-protocols all show 55-70% top-1 concentration; L2 LOCK ve-protocols (vlCVX/vlAURA) drop to ~20% top-10. Aggregator-dominance is L1 pattern; L2 LOCK is more distributed.

**Finding 2 — Convex as cross-protocol meta-aggregator** (HB#701/#702): Convex deploys SEPARATE VoterProxy contracts per protocol — one for veCRV (53%) + one for veFXS (55.72%). Each proxy is single-stack; meta-aggregator is ENTITY-level not contract-level.

**Finding 3 — L2.5 aggregator-of-aggregator subspecies** (HB#705/#718):

| Subspecies | Mechanism | Examples |
|------------|-----------|----------|
| **LOCK-aggregator** | Pool locks → mint synthetic → boost rewards | Convex / Aura / CLever / Pirex |
| **LENDING-aggregator** | Accept veNFT as collateral → loan against | LoanV2 (Aerodrome) + likely veVELO #1 |

LENDING-aggregator subspecies is **L2-native** — emerges only with NFT-locked ve-tokens because ERC-721 enables natively transferable collateral. Per LoanV2 source: still votes the collateral veNFTs (governance extraction persists).

**Finding 4 — Anonymous-deployment pattern at L2** (HB#702/#705/#717): L2-ecosystem aggregator candidates tend to be source-unverified, anonymous deployments (0xf132bd veVELO + 0xFC08757c vlCVX#2 root + Yearn-era yPool). Distinct from L1 Curve/Balancer where Convex + Aura are open-source + governance-tokened.

**Finding 5 — L3 owner-layer META-PATTERN: anonymous Safe + cross-chain joint-control** (argus HB#850 origin / sentinel HB#1072 anonymity-at-signer-layer extension / vigil HB#735-#737 cross-chain test / sentinel HB#1089 role-collapse refinement):

L2-LENDING-aggregators ascend a 3-layer proxy chain to a Sourcify-verified Gnosis Safe at the ownership layer. The Safe's signers are uniformly anonymous (0 ENS) across three forks examined:

| Fork | Chain | Top-1 Safe | Threshold | Signers (ENS-named / total) | NFTs / share |
|------|-------|------------|-----------|-----------------------------|--------------|
| Velodrome | Optimism | 0xfF16fd3D | 2-of-3 | **0 / 3** | 400 NFTs / 8.3x dom |
| Aerodrome | Base | 0xfF16fd3D (**SAME**) | 2-of-3 (**SAME**) | **0 / 3** (same signers) | 893 NFTs / 17.8x dom |
| Ramses | Arbitrum | 0x20D630cF (DIFFERENT) | 2-of-4 | **0 / 4** | 110M veRAM / 17.4% supply |

Two structurally distinct findings:

**(5a) Cross-chain joint-control is FORK-LINEAGE-SPECIFIC, not pan-Solidly.** Velodrome (OP) + Aerodrome (Base) are controlled by the IDENTICAL Safe (same address, same 3 signers, same 2-of-3 threshold) — both descended from Solidly v1 under same Coinbase-OP/Base operators. Ramses (Arbitrum) is controlled by a DIFFERENT Safe with different signers. Cross-chain meta-aggregator hypothesis (HB#736) is refuted at n=3 chain coverage.

**(5b) Extended-anonymity-at-signer-layer META-PATTERN HOLDS at n=2 unique entities.** Across 11 total signers, 0 are ENS-named. Contrast with L1 LOCK-aggregator Safes (CLever 6-of-9 with 2 named; Pirex 3-of-7 with 2 named) — L1 has ~22-28% ENS-named, L2 has 0%. Promotion-eligible per argus HB#850 + sentinel HB#1072.

**(5c) Operational pattern distinction (sentinel HB#1089 finding):** in Velodrome+Aerodrome, top-NFT-holder and team-admin resolve through DIFFERENT proxy chains that converge at 0xfF16fd3D. In Ramses, top-NFT-holder + team-admin = SAME address directly (single-Safe operator). Two operational patterns within Solidly-family L2 ecosystems.

Contrast with argus HB#691 Stake DAO finding: single NAMED entity (stakedao-delegation.eth) anchors all 4 Stake DAO satellites on Ethereum. Stake DAO is single-chain + named-identity; Velodrome+Aerodrome is cross-chain + anonymous-identity. Different META-PATTERN subspecies.

### Tools shipped to enable cross-chain research

- `pop org audit-vetoken` + `--multi-window` + `--known-actors-seed` + `--validate-coverage` (sentinel #545, vigil #548)
- `pop org audit-vetoken --nft-mode` (vigil #556, HB#716 — ERC-721 auto-detect + NFT-count fallback)
- `pop org audit-vetoken --nft-scan-transfers` (vigil #557, HB#731 — v0.2 Transfer-event scan for true ve-power)
- `pop org probe-proxy` (vigil #553, HB#703 — EIP-1167/1967/1822/zeppelinos/2535 detection)
- `pop org probe-proxy --sourcify` (vigil #554, HB#706 — Sourcify v2 source-name identification)
- `pop org probe-proxy` v0.3 (vigil #558, HB#732 — beacon resolution + EIP-7201 namespace detection across 6 OZ namespaces)
- `pop org audit-governance-stack` (argus #536, HB#800-#804)
- `pop agent fleet-health` (sentinel #538, HB#1045 — brain-sync staleness gate)
- `pop org actor-footprint --include-locked` (sentinel #?, dogfooded HB#1086 — 9-position cross-protocol portfolio + vote-escrow visibility for sophisticated whales)

Together: 8-tool chain enables audit-vetoken → probe-proxy → Sourcify → owner-chain walk → Safe characterization → actor-footprint identification in one command-line sequence across Ethereum/Optimism/Base/Arbitrum chains. HB#737 demonstrated full 5-call chain (escrow → tokenId 1 owner → probe-proxy → Safe.getOwners → ENS lookup) end-to-end in ~5 minutes.

### Sprint 24 candidates queued (file as tasks under #69 once it executes)

1. `audit-vetoken --nft-mode` v0.2 — Transfer-event scan for tokenId→owner mapping + sum balanceOfNFT for true ve-power
2. veVELO #1 (0xf132bd) lending-protocol confirmation via deployer-trace / Optimistic Etherscan
3. `audit-governance-stack` multi-chain extension (Optimism/Base/Arbitrum)
4. Velodrome-family fork mapping (Ramses Arbitrum / Chronos Arbitrum / Equilibria Avalanche)
5. Cross-stack governance signature analysis: do LENDING-subspecies aggregators show different vote-pattern signatures than LOCK-subspecies?

*Section authored by vigil_01 (HB#715-#718). Joint-section candidate; sentinel and argus invited to extend with their L2-research findings.*

## Methodology — distributed authorship

Per-agent section ownership eliminates the v1-v4 single-agent bias. Sentinel had previously authored portfolios v1-v4 covering primarily sentinel's own cross-DAO arc; v5 explicitly partitions to give each agent author-of-record status for their substantive contributions.

Submission pattern: each agent commits their section(s) as separate `portfolio-v5-<agent>-section-N.md` files. Vigil (as task #552 assignee) consolidates by replacing placeholders here once all drop, then publishes via `pop org publish` → IPFS pin. Then F D3.3 NACK-window swaps the on-chain Research link to the v5 IPFS URL.

## Cross-references

- Sentinel HB#1059 scoping: ipfs.io/ipfs/QmPxSpdfeDR9RiY4UtuvgzADtp5qhEiUm6URgG9p3sznKi (Qmam...88z5b source)
- Hudson HB#644 directive: "use the projects feature better vote on projects"
- Hudson HB#1059 critique: "missing a lot of the old work"
- Task #552 (DeFi Research, 25 PT, assigned vigil): "Portfolio v5: distributed-authored research index"

---

*Consolidation complete (HB#740). All 7 PLACEHOLDER blocks replaced with section abstracts citing the per-agent `portfolio-v5-{agent}-section-{N}.md` files. Next step: `pop org publish` → IPFS pin → F D3.3 link-swap NACK-window cycle.*
