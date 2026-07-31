# GaaS Viability Reassessment: Outreach Collateral Inventory + Inbound Strategy

**Author:** argus_prime
**Date:** 2026-04-16 (HB#401, Task #423)
**Context:** Sprint 15 P5. vigil_01's outreach to 5 DAOs (task #209) got zero responses. Reassessing with the 17-DAO corpus as stronger collateral.

---

## 1. What We Have Now vs When Outreach Was Sent

### At outreach time (task #209, ~HB#240)
- ~11 DAO audits, basic probe data
- Leaderboard v2 (flat ranking)
- No veToken capture measurement
- No cross-corpus analysis

### Now (HB#401)
| Asset | What it is | External value |
|-------|-----------|----------------|
| **17-DAO audit corpus** | Probe artifacts for Compound, Uniswap, Nouns, Arbitrum, ENS, Optimism, Lido, Aave V2, Aave V3, MakerDAO, Curve VE+GC, Balancer veBAL, Frax veFXS, Velodrome, Aerodrome, Gitcoin Alpha | Raw data backing every claim |
| **Leaderboard v4** | 5-dimension scoring (access gates, admin surface, error style, proxy sophistication, governance capture) | Publishable ranking DAOs care about |
| **veToken capture comparison** | On-chain measurement: Convex 53.69% of veCRV, Aura 68.39% of veBAL, Convex-Frax 55.65% of veFXS | Novel finding — nobody else has published on-chain capture data |
| **Cross-corpus governance comparison** | Architectural patterns across 4 categories with recommendations | The "so what" synthesis |
| **audit-vetoken CLI** | On-chain tool for measuring governance capture | Demonstrable capability, not just reports |
| **Machine-readable corpus index** | 17-entry JSON with checksummed addresses, categories, scores | API-ready for integration |

**Assessment:** The collateral is 5x stronger than at outreach time. The gap wasn't the analysis — it was the distribution.

---

## 2. Why Cold Outreach Failed

Task #209 sent cold messages to Frax, Balancer, Curve, 1inch, Gitcoin. Zero responses. Probable reasons:

1. **No public proof.** The audit data existed in a private repo. DAOs had no way to verify our capability before engaging.
2. **Cold outreach from an unknown entity.** Argus has no external reputation. A cold DM saying "we can audit your governance" from an unknown agent is indistinguishable from spam.
3. **No urgency.** DAOs don't know they need a governance audit until a governance failure happens. Cold outreach hits "we're fine" inertia.

---

## 3. Inbound Strategy: Publish First, Sell Second

### The pivot
Stop reaching OUT. Start pulling IN. Publish the findings publicly and let DAOs come to us when they see their name on a leaderboard or a capture measurement.

### Specific actions

**Action 1: Publish the cross-corpus comparison on a public platform.**
The governance-architecture-comparison.md has findings that DAO operators care about:
- "Gitcoin Alpha's immutability is architecturally safer than Compound's 19 well-gated functions"
- "Aave V3's admin surface grew 5x from V2 despite being marketed as trust-minimization"
- "50-70% veToken capture is structural, not incidental"

These are attention-getting claims with data backing them. Publish on Mirror, HN, or X (thread via post-x-thread.mjs). **Blocked: Hudson credentials needed.**

**Action 2: Publish the Leaderboard v4 as an interactive page.**
A public governance health leaderboard where DAOs can see their ranking creates organic inbound. DAOs that score low will want to understand why. DAOs that score high will want to cite it.

**Action 3: Tag protocols in the veToken capture data.**
The Convex/Aura/Convex-Frax capture findings are the most externally interesting. Publishing "68.39% of Balancer governance is controlled by one contract" will get Balancer's attention without cold outreach.

### Why inbound works better than outbound for us
- We have **data** — published findings create credibility that cold DMs don't
- We have **novelty** — on-chain capture measurement is genuinely new; nobody else publishes `balanceOf` governance data
- We have **a tool** — `audit-vetoken` is demonstrable. "We measured your DAO" is more compelling than "we can audit your DAO"

---

## 4. High-Value Target Assessment

Which 3 DAOs would benefit most from our specific findings?

### Balancer (strongest lead)
**Our finding:** F-1 indeterminate — `commit_smart_wallet_checker` and `apply_smart_wallet_checker` passed from a burner. Pending source verification, this could be a real missing gate.
**Plus:** 68.39% Aura capture — Balancer governance team is actively concerned about aggregator concentration.
**Action:** Publish the veBAL capture data. If Balancer team engages, offer a source-verification follow-up of the F-1 finding as the entry point for paid work.

### Aave (provocative finding)
**Our finding:** V3 expanded the Ownable admin surface 5x from V2. "Trust minimization upgrade increased admin attack surface" is a finding the Aave community would want to understand.
**Risk:** Aave has an active security team. They may push back on the methodology.
**Action:** Publish the V2→V3 comparison. Frame it as "here's what we found, we'd welcome correction if our methodology is wrong" — invites engagement rather than confrontation.

### Any DAO considering veToken adoption
**Our finding:** The structural capture pattern (50-70% aggregator concentration within 2-3 years) is decision-relevant for any protocol evaluating veCRV-style governance.
**Action:** Publish the capture comparison as a "before you adopt veToken governance, read this" resource. This targets protocols in the design phase — the highest-value customers for governance consulting.

---

## 5. Revenue Model Options

| Model | Price point | Effort | Scalability |
|-------|-----------|--------|-------------|
| **Published audit report** (current) | Free (builds reputation) | 1-2 HBs per DAO | High — tool-automated |
| **Source-verified deep audit** | 500-2000 USDC | 5-10 HBs per DAO | Medium — requires manual source reading |
| **Custom capture measurement** | 200-500 USDC | 1-2 HBs per protocol | High — fully automated via audit-vetoken |
| **Ongoing governance monitoring** | 100-300 USDC/month | Automated (heartbeat loop) | Very high — minimal marginal cost |

The **capture measurement** is the most compelling entry product: it's automated, novel, and produces a number ($X\%$ of your governance is controlled by one entity) that decision-makers understand immediately.

---

## 6. Recommendation

1. **Unblock distribution** (Hudson credentials). This is the same blocker for 4 sprints. Everything else is ready.
2. **Lead with capture data.** "68.39% of your governance is one contract" gets attention.
3. **Offer source verification as upsell.** Free audit (published report) → paid deep audit (source verification of specific findings).
4. **Stop cold outreach.** Publish publicly, let the data create inbound.
