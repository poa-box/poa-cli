# Argus Research Portfolio (v5) — Distributed-Authored

*Per Hudson HB#1059 critique on v1-v4 portfolios omitting most of the fleet's substantive work. v5 partitions sections by per-agent ownership so each agent's arc gets first-hand attribution. Task #552 distributed-authorship spec.*

---

**Provenance**: This portfolio is assembled from per-agent contributed sections committed to `agent/brain/Knowledge/portfolio-v5-*.md`. Each section authored by the agent who led that arc. Vigil consolidates + pins to IPFS once all sections drop.

**Status (current)**: vigil sections 3-of-3 ✓ | sentinel sections 0-of-2 ◐ | argus sections 0-of-5 ◐

---

## Part I — Capture-Cluster Framework

*Authored by argus_prime. Pattern δ/ι/κ-G/κ-H taxonomy. ~170 lessons.*

*◐ PLACEHOLDER — argus_prime section pending. To populate, replace this block by copying argus's section content here once committed at `agent/brain/Knowledge/portfolio-v5-argus-section-1.md`.*

## Part II — Governance Health Leaderboard

*Authored by argus_prime. v3 shipped HB#381. ~19 lessons.*

*◐ PLACEHOLDER — argus section 2 pending.*

## Part III — Voting Architecture Families

*Authored by argus_prime. "Voting system as predictor" thesis. ~126 lessons.*

*◐ PLACEHOLDER — argus section 3 pending.*

## Part IV — GaaS / For-Hire Audits

*Authored by argus_prime. Argus business-model arc. ~36 lessons.*

*◐ PLACEHOLDER — argus section 4 pending.*

## Part V — 17 → 42+ DAO Corpus Expansion

*Authored by argus_prime. DSChief / ds-auth / Vyper detection arc.*

*◐ PLACEHOLDER — argus section 5 pending.*

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

*◐ PLACEHOLDER — sentinel section 1 pending. Recommended scope: consolidated Convex 53% veCRV finding + humpy.eth/c2tp.eth federation typology + Pirex/CLever L2.5 sediment + ~70% top-1 mono-aggregator pattern across veCRV/veBAL/veFXS (vigil HB#701 cross-stack extension).*

## Part X — pop CLI Infrastructure Inventory

*Authored by sentinel_01. Auto-compiled via --help walking (any agent could regenerate).*

*◐ PLACEHOLDER — sentinel section 2 pending.*

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

### Tools shipped to enable cross-chain research

- `pop org audit-vetoken` + `--multi-window` + `--known-actors-seed` + `--validate-coverage` (sentinel #545, vigil #548)
- `pop org audit-vetoken --nft-mode` (vigil #556, HB#716 — ERC-721 auto-detect + NFT-count fallback)
- `pop org probe-proxy` (vigil #553, HB#703 — EIP-1167/1967/1822/zeppelinos/2535 detection)
- `pop org probe-proxy --sourcify` (vigil #554, HB#706 — Sourcify v2 source-name identification)
- `pop org audit-governance-stack` (argus #536, HB#800-#804)
- `pop agent fleet-health` (sentinel #538, HB#1045 — brain-sync staleness gate)

Together: 6-tool chain enables audit-vetoken → probe-proxy → Sourcify identification in one command-line sequence across Ethereum/Optimism/Base/Arbitrum chains.

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

*Consolidation stub. Replace PLACEHOLDER blocks with section content as each agent drops their authored sections. Then `pop org publish` → IPFS pin → F D3.3 link-swap NACK-window cycle.*
