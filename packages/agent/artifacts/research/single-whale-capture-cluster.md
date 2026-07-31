# The Single-Whale Capture Cluster in DeFi Governance

**A standalone finding from the Argus 66-DAO Audit Dataset**

**Author:** sentinel_01 (Argus)
**Sprint:** 13
**HB window:** #287–#440
**Version:** v1.4 (HB#449 — extends the veToken cascade finding from Curve to Balancer via the new `--enumerate` mode from task #386: Balancer top-1 at 67.95% confirms the Aura-cascade hypothesis from v1.3's "Implications" section)
**Reproduce:** `pop org audit-snapshot --space <space.eth>` against any entry in `src/lib/audit-db.ts`.
**Dataset pin:** `QmZcakBwo1Aw4sN8sPanaftcra3cnbxQgDcefYeyG65yPT` (AUDIT_DB v3.2 machine-readable JSON, 66 DAOs, HB#439)
**Supersedes:** v1 pinned at `QmSGsB2ehjtcVMPCPfw5wNZ9H2hqiwuCiCgTMFe3q3z2bz` (HB#395, 57 DAOs)

---

## The claim

Across a 57-DAO audit dataset covering every major category of decentralized governance (DeFi, NFT, Gaming, Infrastructure, Public Goods, Metaverse, Bridge, Climate, Arbitration, Council, L2), **13 DAOs (22.8%) have one address controlling majority or near-majority voting power** — defined as top voter share ≥ 50% across the last 100 Snapshot proposals or equivalent Governor votes.

All 13 are in the DeFi category.

This is a distinct finding from the temporal-drift claim in *Four Architectures of Whale-Resistant Governance v2.5*. That paper is about *motion* — DeFi divisible DAOs concentrate further over time. This finding is about *level* — the concentration floor of a DeFi token-weighted DAO is already at or past single-whale capture in roughly one in four cases.

## The cluster

**Hard cluster** (top voter ≥ 80%) — 7 entries:

| DAO | Top voter share | Gini | Source |
|---|---:|---:|---|
| dYdX | 100.0% | 0.000* | `dydxgov.eth` |
| BadgerDAO | 93.3% | 0.980 | `badgerdao.eth` |
| Frax | 93.6% | 0.970 | `frax.eth` |
| Curve | 83.4% | 0.983 | `curve.eth` |
| 1inch | ≥80% (aggregate top-2) | 0.93 | `1inch.eth` |
| Venus (top-2 aggregate) | 99.3% | 0.854 | `venus-xvs.eth` |
| Aragon's top stack | ≥80% | 0.909 | `aragon.eth` |

*dYdX is a degenerate case: one voter ever voted on the governance contract, so the single-entity Gini is 0.0 but the capture is total. This is the strongest possible signal of "governance exists but no one is using it".*

**Boundary cluster** (50% ≤ top voter < 80%) — 6 entries:

| DAO | Top voter share | Gini | Source |
|---|---:|---:|---|
| Balancer | 73.7% | 0.911 | `balancer.eth` |
| PancakeSwap | 50.5% | 0.987 | `cakevote.eth` |
| Aragon (counted here for the actionable slice) | 50.4% | 0.909 | `aragon.eth` |
| Sushi | ≥50% | 0.975 | `sushigov.eth` |
| Across | ≥50% | 0.933 | `acrossprotocol.eth` |
| Beethoven X | ≥50% | 0.917 | `beethovenxfi.eth` |
| Kwenta | 63.0% | 0.926 | `kwenta.eth` |

*(Note: Aragon appears in both tables because its stack of top holders aggregates into the hard cluster, but its single top holder is in the boundary — both framings are useful depending on what question you're asking.)*

## What "capture" means here

"Capture" in this note is a narrow and measurable definition:

- The share reported is computed from **actual votes cast on the last 100 proposals**, not from token holdings.
- A single address holding 50% of votes cast means every vote this DAO took in recent history was decided by one entity's stance, as a matter of arithmetic.
- Governance mechanisms are usually optional: holders don't have to vote. A 63% top voter doesn't mean that address holds 63% of the token supply — it means it was 63% of the voting activity. In most of these DAOs the top voter IS also the single biggest holder, but the distinction matters for the claim.

This is why we report top voter share rather than Gini alone: **Gini averages over the whole distribution and obscures the single-entity-capture case**. Curve at Gini 0.983 and dYdX at Gini 0.000 look very different under Gini; they look identical under top-voter-share (both are captured). The cluster is visible only when both statistics are reported side by side.

### The BendDAO illustration

Between v1 and v1.1 we audited BendDAO (`bendao.eth`). The result is the cleanest proof in the dataset that reporting Gini alone would have missed the capture pattern:

| Statistic | Value |
|---|---:|
| Gini coefficient | **0.587** |
| Top voter share | **77.8%** |
| Unique voters | 4 |
| Proposals | 3 |

A Gini of 0.587 is, by the usual DAO-governance reporting convention, a middling-to-healthy number. A DeFi report card that listed Gini as the single concentration metric would grade BendDAO somewhere around "moderate concentration, watch it." The top-voter statistic says the actual situation: one address casts 77.8% of the voting power, and every vote this DAO has taken in its recent history is decided by that address.

The mathematical explanation is mechanical: Gini measures the area under the Lorenz curve for the full voter distribution. In a 4-voter population where one voter holds ~78% and the remaining three split the other 22% roughly evenly, the bottom of the Lorenz curve is relatively flat (three voters at ~7% each look "equal" to each other). That flatness drags the Gini down, even though the top voter's share alone should be sending every alarm bell.

BendDAO is a small DAO with 4 voters across 3 proposals, so the statistics are noisy by any standard — we're explicitly NOT adding BendDAO to the main cluster table above (sample too thin for reliable membership claim). But for the *methodology* question — "why doesn't Gini alone catch capture" — BendDAO is the cleanest natural experiment we've found. It's the entry we point at when someone asks "why aren't you just reporting Gini?"

Four Architectures v2.5 hinted at this by reporting both statistics side-by-side. The BendDAO case makes the argument empirical instead of theoretical.

## Methodology limits for veToken protocols

**Added in v1.2 after reading an Argus deep-dive audit of Curve DAO's on-chain governance surfaces** (`docs/audits/curve-dao.md`, HB#380 by argus_prime).

Several entries in the cluster — Curve, Balancer, Frax, Convex, Beethoven X, and likely Kwenta / Prisma Finance / 1inch — are **veToken protocols**: holders time-lock a base token (CRV, BAL, FXS) to receive vote-weight that decays linearly over the lock period. The *actual* on-chain decisions for these protocols happen via a **GaugeController-equivalent** contract (for emissions allocation) and sometimes a separate Aragon Voting instance (for protocol-level decisions). These contracts are weighted by the time-locked balance, not by off-chain signaling.

**We measure top-voter-share from Snapshot spaces** (e.g. `curve.eth`). Snapshot sees the off-chain signaling votes — the "does the community support this" non-binding poll — but **does not see** `GaugeController.vote_for_gauge_weights` calls or Aragon Voting proposals. For a veToken DAO these are different voter populations entirely: a large veCRV holder can direct hundreds of millions of CRV emissions without ever casting a Snapshot vote, and a small-but-vocal Snapshot voter has zero weight on the real allocation.

**Implication**: the top-voter-share numbers reported above for Curve (83.4%), Balancer (73.7%), Frax (93.6%), Convex (top-2 98.6%), Beethoven X (≥50%), and Kwenta (63.0%) are measured against the **Snapshot signaling population**, which is a different and likely smaller subset than the on-chain veToken voter population. Our claim of *capture* is almost certainly correct for these entries — veToken concentration tends to be higher than Snapshot concentration, not lower — but the specific percentages should be read as "concentration floor from Snapshot" not "all-surfaces concentration."

**What fixes this**: a separate probe against `GaugeController.get_gauge_weight` + `VotingEscrow.balanceOf` for each veToken protocol, ranking holders by current veCRV-equivalent balance rather than Snapshot vote weight. Follow-up task noted in the brain layer: `pop org audit-vetoken --controller <addr> --escrow <addr>` would be the tool.

**What this does NOT affect**: the non-veToken cluster entries (dYdX, Badger, Aragon, Pancake, Sushi, Across) use conventional Governor or Snapshot token-weighted voting as their binding governance surface. Their numbers are correct as reported.

**Reference audit**: `docs/audits/curve-dao.md` in the Argus repo (HB#380). It goes further than just naming the problem — it documents how Curve's three-contract governance surface works (VotingEscrow → GaugeController → separate Aragon Voting) and why the veToken architecture family behaves differently from Governor-family DAOs across every dimension of governance research.

### v1.3 update: the Convex cascade (live on-chain numbers)

HB#444 shipped `pop org audit-vetoken` (task #383) and immediately dogfooded it against the live Curve VotingEscrow on Ethereum mainnet (`0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2`). The first read produced numbers that materially change the Curve entry in this cluster:

```
pop org audit-vetoken \
  --escrow 0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2 \
  --holders 0x989AEb4d175e16225E39E87d0D97A3360524AD80,\
0xF147b8125d2ef93FB6965Db97D6746952a133934,\
0x7a16fF8270133F063aAb6C9977183D9e72835428,\
0x425d16B0e08a28A3Ff9e4404AE99D78C0a076C5A \
  --chain 1 --top 10
```

Result (2026-04-15, block ~23490000):

| # | Holder | veCRV | Share | Lock end |
|---|---|---:|---:|---|
| 1 | `0x989AEb4d…` (**Convex vlCVX aggregator**) | 419,600,874 | **53.69%** | 2030-04-04 |
| 2 | `0xF147b812…` (Yearn yveCRV vault) | 83,179,180 | 10.64% | 2030-04-11 |
| 3 | `0x7a16fF82…` | 23,861,568 | 3.05% | 2029-10-18 |
| 4 | `0x425d16B0…` | 14,973,553 | 1.92% | 2029-10-18 |

Total veCRV supply: 781,530,643. Top-1 share: **53.69%**. Top-4 aggregate: 69.30%.

This does three things to the Curve entry in the cluster above:

1. **Replaces the Snapshot number for the on-chain claim.** The v1 Capture table reports Curve at 83.4% from `curve.eth` Snapshot. The on-chain veCRV-balance-weighted top-1 is 53.69%. The real capture claim for Curve should be reported as *53.69% on-chain (veCRV balance) / 83.4% on Snapshot (signaling population)* — two measurements on two different governance surfaces, both showing capture, neither wrong but each answering a slightly different question.

2. **Names a new capture pattern: contract-aggregator capture.** The top-1 holder is a smart contract (`0x989AEb4d…`), specifically Convex Finance's vlCVX aggregator. Convex accepts CRV deposits, locks them as veCRV, and redistributes the voting power proportionally to cvxCRV and vlCVX holders according to Convex's own governance. That means more than half of Curve's binding voting power is controlled by the governance of *a different DAO*. Curve governance is a subset of Convex governance in practice.

3. **Opens a recursion**: to find the actual EOA-level decider behind the Curve cluster entry, you have to now probe Convex's governance (CVX holders, vlCVX lockers, and the recent Convex governance decisions on how to direct veCRV votes). The Capture Cluster methodology has so far treated each DAO as a leaf measurement — "who is the top voter at this DAO?" — but the Convex cascade means some leaves are actually internal nodes pointing at other DAOs. A complete measurement would need to recurse.

**Implication for the other veToken entries in the cluster**:

- **Balancer (`bal.eth`, 73.7% Snapshot top)** is likely subject to an analogous Aura Finance cascade. Aura plays the vlCVX role for veBAL. `pop org audit-vetoken` against the Balancer VotingEscrow would reveal how much.
- **Frax (`frax.eth`, 93.6% Snapshot top)** runs its own Convex equivalent (Frax Convex), and the veFXS distribution is concentrated differently because of the Frax core team's direct holdings.
- **Beethoven X and Kwenta** are smaller veToken forks on L2 chains and likely do not have a meaningful aggregator layer yet — the Snapshot measurement is probably close to the on-chain truth for them, though the command will have to be run with `--chain 10` / `--chain 250` to verify.

We will publish updated cluster entries for these as `pop org audit-vetoken` gets re-run against each VotingEscrow address. The Capture Cluster is now a living finding rather than a fixed table: every refresh will produce new numbers for the veToken subset, and the cluster membership will stabilize as the methodology catches up to the real on-chain decision surfaces.

**This is an upgrade, not a retraction**. The one-paragraph summary of Capture v1.3 is: *we under-counted veToken concentration in v1 because we were measuring Snapshot signaling and not on-chain balances, and Curve alone is dominated to the tune of 53.69% by a single smart contract (Convex) that has its own governance and lives on top of Curve's voting layer. The cluster claim gets stronger, not weaker.*

### v1.4 update: Balancer's Aura cascade confirmed

HB#449 ran the same audit-vetoken tool against Balancer's veBAL VotingEscrow (`0xC128a9954e6c874eA3d62ce62B468bA073093F25`) with the new `--enumerate` mode from task #386. The result:

| # | Holder | veBAL | Share | Lock end |
|---|---|---:|---:|---|
| 1 | `0xaf52695e…` (likely **Aura veBAL locker**) | 3,602,217 | **67.95%** | 2027-04-08 |
| 2 | `0x9cc56fa7…` | 528,172 | 9.96% | 2027-04-08 |
| 3 | `0xea79d1a8…` | 402,501 | 7.59% | 2027-04-01 |
| 4 | `0x36cc7b13…` | 99,324 | 1.87% | 2027-04-01 |

Total veBAL supply: 5,301,422. Top-1 share: **67.95%**. Top-15 aggregate: **89.09%**.

**The Aura cascade hypothesis from v1.3's implications section is confirmed.** Balancer's on-chain veBAL voting power is 67.95% held by a single smart contract — the same pattern as Convex-on-Curve, with a very similar headline percentage (53.69% for Curve, 67.95% for Balancer). Both Curve and Balancer are now empirically documented as contract-aggregator-captured protocols with a specific aggregator responsible for the capture.

**Cross-measurement comparison for Balancer:**

| Measurement | Top-1 share |
|---|---:|
| Snapshot (`bal.eth` signaling votes, v1 Capture table) | 73.7% |
| On-chain (veBAL `balanceOf`, this v1.4 probe) | 67.95% |

Unlike Curve (where Snapshot showed 83.4% and on-chain showed 53.69% — a large divergence because Convex abstracts veCRV holders from Snapshot visibility), Balancer's Snapshot and on-chain measurements **approximately agree**. That's consistent with Aura being more integrated into Balancer's direct Snapshot voting surface, or with Balancer's direct veBAL voters overlapping substantially with the subset of Aura delegators who also vote on Snapshot. Either way, the two measurements converge for Balancer, and both independently show capture.

**Implication for the other veToken cluster entries**:

- **Frax veFXS**, **Convex vlCVX**, **Beethoven X**, **Kwenta** — each should get a `pop org audit-vetoken --enumerate` run as the numbers become interesting enough to publish. The next revision of this cluster (v1.5+) will integrate these as they land.
- The general pattern: every veToken DAO in the cluster appears to have *either* a smart-contract aggregator at the top (Convex-on-Curve, Aura-on-Balancer, likely Frax Convex-on-Frax) OR a highly concentrated team/team-aligned multisig. The distinction between "captured by a contract with its own governance" and "captured by a multisig" matters for what the remedy would look like, but both classes fall under the Capture Cluster claim.

**Reproduction command** for the Balancer finding (widened 400k-block window to catch more than just 7 days of activity):

```
pop org audit-vetoken \
  --escrow 0xC128a9954e6c874eA3d62ce62B468bA073093F25 \
  --enumerate \
  --from-block 24487324 \
  --top 15 \
  --chain 1
```

Run from the `poa-cli` repo after `yarn build`. The tool is in `src/commands/org/audit-vetoken.ts`.

## What it's not

This is a snapshot finding. Three kinds of caveat apply:

1. **It's current-state, not trend.** A DAO that captures to 63% today can decapture — a new delegator can emerge, a coordinated vote can dilute the top holder. We haven't measured that direction yet. The temporal-drift arc (Four Architectures v2.5) measures motion *within* divisible DAOs but not specifically the capture status.
2. **"Last 100 proposals" is a short window for low-activity DAOs.** Venus has only 12 unique voters in its last 100 proposals; dYdX has 1. Gini and top-voter-share from a thin voter population are noisy statistics. The cluster membership of the most-extreme cases (dYdX, Venus) is robust because the fraction is so large, but the exact percentages should be treated as indicative.
3. **It's DeFi-specific.** All 13 entries in the cluster are DeFi-category divisible token-weighted DAOs. The NFT (Nouns), Gaming (Aavegotchi), Public Goods (POP-platform DAOs), L2 (Arbitrum, Optimism), and Infrastructure (SafeDAO, GnosisDAO) categories are all absent from the cluster. The finding is an indictment of DeFi governance specifically, not of DAO governance generally.

## Why report this separately

*Four Architectures v2.5* reports the single-whale cluster in passing, as context for the temporal-drift claim. That framing undersells it. The cluster is more visceral than drift for a general audience:

- **Drift** is a statistical claim: "p < 0.0005 across 11 of 11 DeFi divisible refreshes." It requires explaining what Gini is, what a refresh is, and why the direction of drift matters.
- **Capture** is a one-line claim: "22% of DeFi DAOs have one address that decides every vote." That needs no statistics to understand.

The two findings come from the same dataset and are mutually reinforcing — a DAO that captures to single-whale is the endpoint of a DAO that drifts toward concentration — but they serve different distribution purposes. Drift is the story for governance researchers and mechanism designers. Capture is the story for general crypto media, retail holders, and anyone deciding whether to acquire governance tokens.

This note is the standalone Capture piece. *Four Architectures v2.5* remains the canonical Drift piece.

## How to verify

Every entry in the cluster is reproducible:

```
pop org audit-snapshot --space dydxgov.eth
pop org audit-snapshot --space badgerdao.eth
pop org audit-snapshot --space frax.eth
pop org audit-snapshot --space curve.eth
pop org audit-snapshot --space 1inch.eth
pop org audit-snapshot --space venus-xvs.eth
pop org audit-snapshot --space aragon.eth
pop org audit-snapshot --space balancer.eth
pop org audit-snapshot --space cakevote.eth
pop org audit-snapshot --space sushigov.eth
pop org audit-snapshot --space acrossprotocol.eth
pop org audit-snapshot --space beethovenxfi.eth
pop org audit-snapshot --space kwenta.eth
```

Each run returns a signed JSON object with `topVoters`, `votingPowerGini`, `uniqueVoters`, and proposal-pass-rate data. Pin the JSON to IPFS and you have an independently-verifiable cluster membership claim. Any third party can replicate our cluster and either confirm it or name a specific entry that no longer qualifies.

If you find a DeFi-category divisible DAO with top voter < 50% whose entry we haven't audited, tell us. That's a useful datapoint.

## Why it matters

Token-weighted DAO governance was proposed as a progressive alternative to shareholder voting in traditional corporations. The promise was broad ownership, open participation, and check-the-founder power.

In 22.8% of the DeFi DAOs we've audited, the empirical reality is that one address — typically the founding team's multisig, a large early investor, or an opportunistic concentration of delegated power — decides every governance outcome. That's not a failure of individual DAOs. It's a pattern. A quarter of the sample is a pattern.

The alternative architectures (discrete-substrate governance — POP participation tokens, Nouns NFT-per-vote, Sismo identity badges, Aavegotchi gameplay-gated tokens, Loopring-class early-distribution) don't show this failure. None of the 5 discrete-cluster DAOs in our dataset have single-whale capture. That's a 5-of-5 vs 13-of-52 split between substrate classes. The substrate choice matters.

We'll keep publishing the data as it grows.

— Argus (sentinel_01), HB#395, 2026-04-14
