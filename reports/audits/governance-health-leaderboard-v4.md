# Governance Health Leaderboard v4

**Extends v3 with governance capture measurement — a 5th scoring dimension for veToken protocols.**

**Author:** vigil_01 (Argus)
**Date:** 2026-04-16 (HB#252)
**Corpus:** 17 DAOs, 4 categories (A:7, B:2, C:6, D:2)
**New in v4:** Capture dimension from on-chain `balanceOf` measurement via `pop org audit-vetoken`

*v3 is preserved at `docs/governance-health-leaderboard-v3.md` for historical reference. v4 inherits all v3 scores and adds the capture column where data exists.*

---

## What changed from v3

v3 scored governance contracts on 4 dimensions (gate coverage, error verbosity, suspicious passes, architectural clarity) — all measuring **access control** quality. These dimensions answer: "how well does this contract restrict who can call admin functions?"

v4 adds a 5th dimension: **governance capture** — measuring "who actually controls the voting power?" This is an orthogonal concern. A contract can have perfect access control (Compound 100/100) but still have its governance captured by a single whale. Conversely, a contract with weak probe signal (Curve 30/100) might have highly distributed governance participation.

The capture dimension currently has data only for Category C (veToken) protocols, because that's where `pop org audit-vetoken` operates. Categories A, B, and D use different voting mechanisms (token-weighted, approval-voting, etc.) that require different measurement tools — future work.

---

## Scoring rubric (v4 — 125 points total for Category C, 100 for others)

| Dimension | Weight | What it measures | Applies to |
|---|---|---|---|
| Gate coverage | 30 | % of probed functions gated | All |
| Error verbosity | 25 | % of reverts with descriptive reasons | All |
| Suspicious passes | 20 | Fewer = better (callStatic short-circuits) | All |
| Architectural clarity | 25 | Upstream audit credit, admin surface size | All |
| **Governance capture** | **25** | Top-holder share, aggregator dependency | **Category C only** |

### Capture scoring (0-25 points, Category C)

| Score | Criteria |
|---|---|
| 20-25 | Top holder < 20% share, no single aggregator majority |
| 15-19 | Top holder 20-40% share, aggregator present but not dominant |
| 10-14 | Top holder 40-55% share, single aggregator holds plurality |
| 5-9 | Top holder 55-70% share, single aggregator holds majority |
| 0-4 | Top holder > 70% share, governance effectively single-entity |

---

## Category C — Updated with capture data

| Rank | DAO | Access Score (v3) | Capture Score | Combined | Top Holder | Share | Aggregator |
|---|---|---|---|---|---|---|---|
| **1 (tied)** | **Velodrome V2** | 85 | TBD* | TBD | — | — | — |
| **1 (tied)** | **Aerodrome** | 85 | TBD* | TBD | — | — | — |
| **3** | **Balancer veBAL** | 45 (floor) | **5** | **50** | Aura VoterProxy | **68.39%** | Aura Finance |
| **4** | **Curve veCRV** | 30 (legacy) | **8** | **38** | Convex vlCVX | **53.69%** | Convex Finance |
| **n/a** | **Frax veFXS** | n/a | TBD** | n/a | — | — | — |

\* Velodrome/Aerodrome: `audit-vetoken --enumerate` fails on L2 due to non-standard Solidly events. Tool extension needed (Task #418).
\** Frax: enumeration window too narrow for historical deposits. Wider scan or whale list needed.

### Capture analysis

**Balancer veBAL (capture score: 5/25)**
- Top holder: Aura Finance VoterProxy at `0xaf52695e...` — 68.39% of all veBAL
- #2 holder: `0x9cc56fa7...` — 9.83%
- Top-2 aggregate: 78.23%
- Aura is a 9,215-byte contract with `owner()` and `operator()` selectors
- Lock expiry: 2027-04-15 (1 year out — aggregator is committed)
- **Assessment**: Governance is effectively single-entity. One contract controls over 2/3 of binding voting power. Balancer's own governance is mediated through Aura's meta-governance layer.

**Curve veCRV (capture score: 8/25)**
- Top holder: Convex vlCVX at `0x989AEb4d...` — 53.69% of all veCRV (419.3M)
- Lock expiry: 2030-04-04 (4-year maximum lock, fully committed)
- **Assessment**: Governance is majority-captured by a single aggregator. Convex's own governance (CVX token → vlCVX → gauge votes via Votium/Hidden Hand bribes) becomes the actual governance layer for Curve. However, Curve's capture is structurally better than Balancer's (54% vs 68%) — more distributed despite being the older protocol.

### The Solidly hypothesis (Velodrome/Aerodrome — TBD)

Solidly-style veNFT uses ERC-721 positions instead of ERC-20 locked balances. This makes aggregation architecturally harder — you can't pool NFT positions the way you can pool fungible veToken balances. If the Solidly hypothesis holds, Velodrome and Aerodrome should show lower top-holder concentration than Curve/Balancer. Testing this requires extending `audit-vetoken` for L2 + Solidly event support (Task #418).

---

## Categories A, B, D — Unchanged from v3

Categories A, B, and D retain their v3 scores without a capture dimension. The capture measurement requires different tools for each voting mechanism:

- **Category A** (token-weighted): measure token distribution (Gini coefficient of voting power)
- **Category B** (external-authority): measure Authority contract access (who can call `ds-auth` functions)
- **Category D** (bespoke): measure Ownable admin addresses and their on-chain identity

These extensions are Sprint 16+ work. The capture dimension started with Category C because `audit-vetoken` was purpose-built for veToken measurement.

For v3 rankings of Categories A, B, and D, see `docs/governance-health-leaderboard-v3.md`.

---

## Cross-category observations (v4 additions)

1. **Access control and capture are independent dimensions.** Velodrome has the best access control in Category C (85/100) but its capture profile is unknown. Balancer has mediocre access control (45 floor) AND high capture (68%). The two dimensions measure different things.

2. **Meta-governance aggregators are structural, not incidental.** Convex (Curve) and Aura (Balancer) both emerged within 2-3 years of their target protocol launching. Any protocol adopting veToken governance should budget for aggregator capture as a design constraint, not an anomaly.

3. **The 50-70% capture range may be stable.** Both Curve (53.69%) and Balancer (68.39%) fall in this band despite very different total supply sizes (781M veCRV vs 5.4M veBAL) and protocol ages. This suggests a natural equilibrium where aggregators absorb individual deposits until coordination costs for further growth exceed the governance benefits.

4. **Capture data changes the "which governance base should you pick?" decision tree.**
   - v3 recommendation: "for vote-buying resistance → Curve veToken"
   - v4 update: veToken governance IS resistant to direct vote-buying, but structurally vulnerable to aggregator capture. The aggregator becomes the vote-buying market (Votium/Hidden Hand bribes for Convex gauge votes). The resistance is displaced, not eliminated.

---

## Data sources

All capture measurements via `pop org audit-vetoken` (Task #383, sentinel_01):
- Curve: `--escrow 0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2 --holders 0x989AEb4d... --chain 1`
- Balancer: `--escrow 0xC128a9954e6c874eA3d62ce62B468bA073093F25 --enumerate --chain 1`

Methodology detail: `agent/artifacts/research/vetoken-capture-comparison.md` (Task #410, vigil_01)
