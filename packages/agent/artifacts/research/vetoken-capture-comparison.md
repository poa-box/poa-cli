# veToken Governance Capture: Cross-Protocol Comparison

**Author:** vigil_01 (Argus)
**Date:** 2026-04-16 (HB#243-244)
**Method:** On-chain `balanceOf` measurement via `pop org audit-vetoken` (task #383)

---

## TL;DR

Meta-governance aggregators capture 50-70% of binding veToken governance power. This is not a Curve-specific phenomenon but a structural consequence of the veToken architecture. Convex controls 53.69% of veCRV; Aura controls 68.39% of veBAL. Both are smart contracts, not EOAs — governance power flows through a 2-layer system where users delegate to aggregators who vote as a single block.

---

## Methodology

**On-chain measurement** via `pop org audit-vetoken --escrow <addr> --enumerate --top N --chain 1`. This reads `balanceOf(holder)` and `totalSupply()` from the VotingEscrow contract at the current block, returning current decayed veToken balances.

**Important distinction**: this measures the **binding governance surface** (on-chain vote-escrow balances), NOT Snapshot signaling votes. Snapshot measures who *participates* in off-chain polls. `audit-vetoken` measures who *controls* the on-chain voting power. Both are governance surfaces; the on-chain one is the binding one.

**Limitation**: the `--enumerate` mode scans recent Deposit events to discover holders. For mature protocols (Frax veFXS), most deposits occurred years ago and fall outside the default window. A wider `--from-block` or pre-compiled whale list is needed for comprehensive coverage.

---

## Findings

### Curve veCRV

| Metric | Value |
|--------|-------|
| Total supply | 781.0M veCRV |
| Top holder | Convex vlCVX (0x989AEb4d...) |
| Top holder share | **53.69%** (419.3M veCRV) |
| Lock expiry | 2030-04-04 |
| Holder type | Smart contract (meta-governance aggregator) |

**Interpretation**: Convex is a meta-governance protocol. Users deposit CRV into Convex, receive vlCVX, and Convex locks the CRV for the maximum 4 years. Convex then votes the consolidated veCRV position based on vlCVX governance. The result: over half of Curve's binding voting power is controlled by a single contract, which itself has its own governance layer (CVX token holders voting on gauge weights via Votium/Hidden Hand bribes).

### Balancer veBAL

| Metric | Value |
|--------|-------|
| Total supply | 5.36M veBAL |
| Top holder | Aura Finance VoterProxy (0xaf52695e...) |
| Top holder share | **68.39%** (3.67M veBAL) |
| #2 holder share | 9.83% (0x9cc56fa7...) |
| Top-2 aggregate | **78.23%** |
| Lock expiry | 2027-04-15 |
| Holder type | Smart contract (meta-governance aggregator) |
| Owner | 0x5fea4413... |
| Operator | 0xa57b8d98... |

**Interpretation**: Aura Finance is to Balancer what Convex is to Curve. The concentration is even higher (68% vs 54%). The top 2 holders control 78% of all veBAL, leaving only 22% for all other participants. Balancer governance is more concentrated than Curve governance.

### Frax veFXS (partial)

| Metric | Value |
|--------|-------|
| Total supply | 35.35M veFXS |
| Recent depositors found | 1 (174 veFXS, 0.00% share) |
| Assessment | Insufficient data from recent window |

**Interpretation**: Most FXS locks occurred years ago. The `--enumerate` event scan over a 193K-block window (~27 days) found only 1 recent depositor. A comprehensive measurement requires either scanning from contract deployment or using known whale addresses (Convex's cvxFXS, StakeDAO's sdFXS, etc.).

---

## The Meta-Governance Pattern

The data reveals a structural pattern in veToken governance:

1. **veToken design concentrates power by design**: Lock-for-weight mechanisms reward long-term commitment but create barriers to entry for small holders. The rational individual response is to delegate to an aggregator.

2. **Aggregators become the governance layer**: Convex (for Curve) and Aura (for Balancer) accumulate veTokens from thousands of individual users and vote as single blocks. The underlying protocol's governance is effectively replaced by the aggregator's governance.

3. **2-layer governance emerges**: The binding votes on Curve/Balancer are cast by 1-2 smart contracts. The *actual* governance decision-making happens one layer up, in the aggregator's own system (vlCVX votes on Convex, auraBAL governance on Aura). The veToken layer becomes a delegation pass-through.

4. **Concentration exceeds what Snapshot signaling shows**: The Capture Cluster v1.2 measured Curve at 83.4% concentration via Snapshot. The on-chain measurement is 53.69% via balance-weighted veCRV. Different surfaces, different numbers — but both point to single-entity majority capture.

---

## Implications for Governance Design

- **veToken =/= decentralized governance.** The architecture structurally incentivizes aggregator capture. Any protocol adopting veCRV-style governance should expect 50-70% of voting power to consolidate into 1-2 meta-governance contracts within 2-3 years of launch.

- **Auditing the base layer is necessary but insufficient.** Argus's probe-access corpus audits the *access control* of VotingEscrow contracts (who can call admin functions). The capture measurement audits *who holds the power*. Both are needed for a complete governance health picture.

- **The Solidly family (Velodrome/Aerodrome) may resist this pattern.** Solidly-style veNFT governance uses non-fungible vote-escrow positions (ERC-721 instead of ERC-20). This makes aggregation architecturally harder — you can't pool NFT positions the way you can pool fungible veToken balances. Whether this translates to lower capture is an empirical question for Sprint 15.

---

## Data Sources

- Curve veCRV: `pop org audit-vetoken --escrow 0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2 --holders 0x989AEb4d175e16225E39E87d0D97A3360524AD80 --top 5 --chain 1`
- Balancer veBAL: `pop org audit-vetoken --escrow 0xC128a9954e6c874eA3d62ce62B468bA073093F25 --enumerate --top 10 --chain 1`
- Frax veFXS: `pop org audit-vetoken --escrow 0xc8418aF6358FFddA74e09Ca9CC3Fe03Ca6aDC5b0 --enumerate-transfers --underlying 0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0 --top 10 --chain 1`

## Follow-up Work

1. Complete Frax veFXS measurement with wider window or known whale list
2. Measure Velodrome/Aerodrome veNFT concentration (test the Solidly hypothesis)
3. Cross-reference with Snapshot participation data for a dual-surface comparison
4. Integrate into Governance Health Leaderboard v4 as a "capture dimension"
