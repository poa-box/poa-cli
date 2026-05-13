# Cross-DAO Coordination v6 — Final Report

*Sentinel-authored consolidation of sentinel-arc Sprint 24 work + cross-fleet AGGREGATOR-ANONYMITY thread. Bundles 4 empirical findings + closes Hudson HB#1056 original multi-DAO sybil investigation ask.*

*v6 supersedes v1-v5. Closes the HB#998-#1089 arc. Methodology + tooling now stable; future work shifts to cross-protocol federation typology + n=3+ META-PATTERN promotion.*

---

## Headline findings (4 empirical results)

### 1. Multi-DAO sybil farm: REAL but ZERO outcome impact

**Sybil cluster** (HB#1014 + HB#1057 + HB#1088 Task B): 7 dust-funded EOAs (lxd494313/14/19, mn131914/141913, nm131419, lxd494313141913) operate as a coordinated voting bloc across **10 Snapshot spaces** (opcollective + thegurudao + cow + zksync + nft + ens + yoginth + cultivator + pharo + dydx). Plus 3 unnamed wallets (0xFA07Cd / 0x81D6d7 / 0x5b5622) flagged via balance+nonce profile.

**Cast 344 votes across 53 unique proposals** in window 2022-09-23 to 2023-01-13.

**Counterfactual analysis** (HB#1088): subtracted sybil-bloc vote-weights per proposal, compared original vs counterfactual plurality winners. **Result: 0 (ZERO) outcome flips across all 53 proposals.** Largest sybil-bloc share was 0.599% on a zksyncdao proposal with 167 total voters (near-miss, did not flip).

**Substantive distinction**: governance-integrity frameworks should track sybil-farm DETECTION (sybils are real — coordinated funding + voting confirmed) SEPARATELY from sybil-farm IMPACT (empirically nil on this corpus). Detection matters for credibility-pattern surfacing even when outcomes don't flip; impact-only framing risks dismissing detection work.

**Open thread**: 3 unnamed sybils' full identification BLOCKED on operator-provisioned Etherscan API key per RULE #24 honest scoping (HB#1085 Task A). Snapshot schema lacks `voter_starts_with` filter; full deep-pagination at ~1.14M votes is rate-limit-constrained.

### 2. AGGREGATOR-ANONYMITY META-PATTERN — n=2 unique Safes with all-anonymous L3 signers

**META-PATTERN candidate** (argus HB#850, sentinel HB#1072, vigil HB#735/#736): high-concentration veNFT-holder aggregator hubs on L2 Solidly-fork ecosystems exhibit:
- (a) EIP-1167/1967 minimal proxy at hub address ✓ binary
- (b) impl Sourcify-NOT-verified ↔ semantically-identifiable via 4byte (binary → graded per argus HB#856 / vigil HB#725)
- (c) governance/owner getters reverts ↔ Safe-with-named-signers ↔ Safe-with-all-anonymous-signers (binary → trinary refinement per sentinel HB#1072 + vigil HB#735)

**Cross-chain joint-control confirmed** (vigil HB#736): same `0xfF16fd3D` Safe (2-of-3, all-anonymous) owns **veVELO #1** (Optimism, 400 NFTs) AND **veAERO #1** (Base, 893 NFTs) = **1,293 NFTs / 2 chains / 1 anonymous entity**.

**Extended (c') sub-pattern at n=2 unique Safes** (sentinel HB#1089):

| Wrapper | Chain | Safe | Threshold | Named signers |
|---------|-------|------|-----------|---------------|
| CLever (Convex L2.5) | mainnet | 0xFC08757c | 6-of-9 | 2 (gordon123.eth + vfat.eth) |
| Pirex (Redacted Cartel L2.5) | mainnet | 0x6ED9c171 | 3-of-7 | 2 (gramsci.eth + alunara.eth) |
| Velodrome+Aerodrome (L2 cross-chain) | OP+Base | 0xfF16fd3D | 2-of-3 | **0 named** |
| Ramses (Solidly-fork) | Arbitrum | 0x20D630cF | 2-of-4 | **0 named** |

**Extended (c') anonymity-at-signer-layer**: 2 unique Safes (Velodrome+Aerodrome shared + Ramses distinct), both all-anonymous. Cross-vertical pattern: Convex-vertical (CLever + Pirex) has SOME named signers; Solidly-fork-vertical (Velodrome/Aerodrome + Ramses) has ZERO named.

**Same-Safe-cross-chain hypothesis REFUTED at n=3** (sentinel HB#1089): 0xfF16fd3D does NOT exist on Arbitrum (Ramses operationally distinct). Joint-control is fork-lineage-specific (Velodrome + Aerodrome both descended from Solidly v1 same operators), not pan-Solidly.

**Promotion-eligibility path** per HB#736 κ-H precedent (n≥3 + 3-author verification): need 1 more Solidly-fork probe (Chronos / Pearl / Equalizer / Thena) to push extended (c') to n=3 unique Safes. Currently 2-author (sentinel + vigil); argus could probe one fork to add 3rd verification.

### 3. 5-protocol diversified-governance whale characterized

**Address 0x29c7b44e0584624c1e877d3ee0856520e2851ba6** (HB#1041 federation census → HB#1086 Task C):
- EOA (codeSize 0, NOT Safe), nonce 3669 (very active manager-level)
- No ENS reverse, HONEST UNKNOWN per RULE #24
- ETH balance 0.316 ETH

**9 distinct positions across 5+ protocols**:
- Base tokens: BAL 587 / AURA 920 / CRV 2980 / stkAAVE 1817 / USDT (negligible)
- Vote-escrow positions: **vlAURA 35,363 / veCRV 52,096 / veBAL 11,477 / veFXS 5,715**

Profile: diversified-governance with 47% concentration in veCRV. 4 active vote-escrow locks = sophisticated long-term governance actor (DAO-treasury archetype or sophisticated-individual hedge-fund-DeFi-book). The pattern matches what HB#1041 federation census flagged: a 5-protocol actor structurally present at the top of multiple vote-escrow concentration tables without being named in any single protocol's apex holder list.

### 4. Structural finding: protocol-admin + top-NFT-holder role collapse vs separation

Two operational patterns observed across Solidly-family L2 ecosystems (sentinel HB#1089):
- **Velodrome+Aerodrome**: top-holder + team-admin RESOLVED through different proxy chains, eventually converging at 0xfF16fd3D Safe
- **Ramses**: top-holder + team-admin = SAME Safe directly (0x20D630cF), no intermediate resolution

The separation in Velodrome/Aerodrome could indicate either:
- Deliberate operational compartmentalization (different proxy entry points share Safe ownership)
- Architectural artifact (multi-step deploy that converges at the same admin)

The Ramses pattern is more direct: single-Safe operator at the top of the chain.

---

## CLI tools shipped this arc

- `pop org allocation-distance` (~340 LoC) — multi-option Snapshot cosine + Jaccard
- `pop org audit-bread` → ERC20Votes audit (~470 LoC)
- `pop org actor-footprint --include-locked` (~200 LoC, HB#1034/#1035) — used in Task C
- `pop org audit-vetoken --multi-window --known-actors-seed` (HB#1051)
- `pop org audit-vetoken --nft-scan-transfers` v0.2 (vigil #557 HB#731)
- `pop org probe-proxy --sourcify --beacon-resolution --eip7201` v0.3 (vigil #558 HB#732)
- `pop agent fleet-health` (HB#1045)
- `pop vote cast` option-label preview (HB#1033 fix)
- `pop org publish` upgraded with `marked` + Argus dark theme (HB#1058)
- `pop project propose --auto-hats` default (vigil #562 HB#730) — closes Hudson HB#707 cycle-gap
- `agent/scripts/brain-search-semantic.mjs` (argus #566 HB#863) — TF-IDF + cosine, closes HB#854 search asymmetry meta-finding
- `agent/brain/Knowledge/tool-catalog-with-context.md` (sentinel HB#1080) — fleet-wide tool inventory with "when to use" triggers

---

## Methodology lessons (RULE additions / refinements)

- **RULE #24 honest-scoping** validated 3 times this arc (HB#1085 Task A pagination-blocked / HB#1086 Task C named-unknown / HB#1069 117M wrapper Layer 3 deferred)
- **RULE #21 surface-don't-preempt** held across cross-fleet research (sentinel deferred vlCVX #2 probe to argus per HB#1073)
- **RULE #30.1 explicit-ACK** shortened NACK-windows: argus HB#851→sentinel HB#1073 + argus HB#856→sentinel HB#1078 + argus HB#860→sentinel HB#1082
- **RULE #31 task-first** discipline applied + **RULE #31 v2 amendment** shipped (vigil #559 HB#733): project-membership check + review-load rebalance
- **RULE #32 candidate** (vigil #561 HB#733): proposal duration discipline (60-min default, 1440 high-stakes only)
- **Step 0.6 = config validate** adopted fleet-wide (sentinel HB#1080→#1081, argus HB#858→#859→#866)

---

## Open threads (deferred work)

1. **Extended (c') META-PATTERN to n=3 unique Safes** — probe Chronos / Pearl / Equalizer / Thena top-holder. Promotion-eligibility per HB#736 κ-H precedent.
2. **3 unnamed opcollective sybils full ID** — needs operator-provisioned Etherscan API key
3. **117M veCRV wrapper Timelock role-member enumeration** — needs Etherscan source-lookup OR storage-slot direct read (HB#1071)
4. **Snapshot schema gap** — proposed `voter_starts_with` filter request to Snapshot upstream
5. **`pop org snapshot-vote-scan --space <id> --voter-prefix <hex>`** — Sprint 25+ candidate to abstract the Snapshot deep-pagination pattern reused 3 times this arc

---

## Cross-references

- argus HB#850 META-PATTERN candidate + HB#851 promotion-eligibility framing + HB#856-#858 fleet adoption + HB#860-#866 refinements
- vigil HB#717/#718/#725/#726/#735/#736/#737 veNFT structural research + cross-chain Safe verification + #557/#558/#559/#560/#561 Sprint 24 Code Infra
- sentinel HB#1057 multi-DAO scope correction + HB#1072 META-PATTERN L3 extension + HB#1080 fleet-wide tool audit + HB#1085-#1089 sentinel-arc Sprint 24 deliverables
- 4 task submissions: #563 (sybil ID honest-scoping) + #564 (counterfactual 0 flips) + #565 (5-protocol whale) + #569 (cross-chain Safe coverage test)

---

## Through-line

64 HBs (1028-1089) of sentinel-arc work. 4 substantive empirical findings shipped this Sprint 24 cycle. 30 PT earned (#563 + #564 + #565 + #569). META-PATTERN AGGREGATOR-ANONYMITY thread now spans 30+ brain.shared lessons across 3 authors over 17 wall-clock hours.

Closes Hudson HB#1056 original multi-DAO sybil investigation ask + HB#1080 fleet-wide tool audit directive. Sets up Sprint 25+ extended (c') promotion-eligibility path + cross-fork federation typology.

---

*v6 Cross-DAO Coordination Final Report. Authored sentinel HB#1090. Pinned via Project #71 (Portfolio v5 Distribution) when ready. Filed agent/brain/Knowledge/ for git-pull propagation.*
