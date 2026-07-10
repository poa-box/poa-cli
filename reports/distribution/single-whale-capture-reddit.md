# Reddit Post: The Capture Cluster — one address decides every vote in 22% of DeFi DAOs

**Subreddit targets:** r/defi (primary), r/ethereum, r/CryptoCurrency, r/daos, r/ethfinance

**Title (<300 chars):** In 22% of DeFi DAOs we audited, one address decides every vote — here's the cluster

**Suggested flair:** Research (r/defi), Discussion (r/daos)

**Post body:**

---

We audited 57 governance systems across every major category (DeFi, NFT, Gaming, L2, Infrastructure, Public Goods, Bridges, Climate) and asked a single question against each one: **when this DAO votes, who is actually deciding the outcome?**

The answer: in 13 of the 57 DAOs we looked at (22.8%), a single address controls majority or near-majority voting power across the last 100 proposals. All 13 are in the DeFi category. The non-DeFi categories are clean.

## The cluster

**Hard cluster — top voter ≥ 80%:**

| DAO | Top voter share |
|---|---:|
| dYdX | 100.0% |
| Badger | 93.3% |
| Frax | 93.6% |
| Curve | 83.4% |
| 1inch | ≥80% (top-2 aggregate) |
| Venus | 99.3% (top-2 aggregate) |
| Aragon | ≥80% (top stack) |

**Boundary cluster — top voter 50–80%:**

| DAO | Top voter share |
|---|---:|
| Balancer | 73.7% |
| Kwenta | 63.0% |
| PancakeSwap | 50.5% |
| Aragon (single holder) | 50.4% |
| Sushi, Across, Beethoven X | ≥50% each |

Seven hard-cluster + six boundary-cluster = thirteen total.

## Methodology

"Top voter share" is **not** a token-holdings statistic. It's the fraction of voting power that this single address cast across the last 100 proposals (or 63 for dYdX, which only has 63 proposals in its governance contract). If a DAO's top voter has 63% of the cast power, every outcome this DAO produced recently was decided by one entity, as arithmetic.

We deliberately avoided leading with Gini. Gini averages the whole distribution and obscures the single-capture case — Curve at Gini 0.983 and dYdX at Gini 0.000 look radically different under Gini but identical under top-voter-share (both captured). The cluster is only visible when you report top-voter-share separately.

Full methodology, caveats, and reproduction steps: https://ipfs.io/ipfs/QmSGsB2ehjtcVMPCPfw5wNZ9H2hqiwuCiCgTMFe3q3z2bz

## Caveats we'd flag up front

- **This is a snapshot, not a trajectory.** Some cluster DAOs could de-capture if a new delegator emerges. A separate finding (the *Four Architectures v2.5* temporal-drift research) measures motion and finds DeFi divisible DAOs drift further toward concentration over time. Drift and capture are different facts.
- **Some of the most extreme entries have very few unique voters** — dYdX has one, Venus has twelve in the last 100 proposals. The cluster membership is robust because the fraction is so extreme, but the exact percentages for those entries should be treated as indicative.
- **Capture is not malice.** The top voter is often the team multisig that was always intended to retain veto power, or a large early investor whose position is public. The question isn't whether the concentration is secret — it's whether the mechanism is meaningfully open.

## Why DeFi-specific

Zero of the 5 discrete-substrate DAOs in our dataset (POP participation tokens, Nouns NFT-per-vote, Sismo identity badges, Aavegotchi gameplay-tied tokens, Loopring early-distribution LRC) show capture. 13 of the 52 divisible token-weighted DAOs do. The substrate matters — DeFi's default (tradeable token = vote weight) is the failure mode.

## Reproduce it yourself

Every entry in the cluster is reproducible in one command:

```
pop org audit-snapshot --space dydxgov.eth
pop org audit-snapshot --space curve.eth
pop org audit-snapshot --space frax.eth
# … and so on
```

Each returns a signed JSON with `topVoters`, `uniqueVoters`, `votingPowerGini`, and pass-rate data. Pin it to IPFS and you have an independently-verifiable cluster membership claim. If a reader doesn't trust our numbers, they can run the same commands.

## Counter-example bait

If you can name a DeFi divisible DAO with top voter < 50% that we haven't audited, tell us. We'll add it to the dataset and publish the result, whether or not it supports the finding. One named counter-example either proves the methodology sound (if it confirms) or improves the measurement (if we can't audit it and it exposes a gap). The dataset is the deal.

---

**OP note:** happy to answer methodology / cluster-membership questions in the comments. Source audits, dataset, and `pop org audit-snapshot` command are all at the Argus repo.

## Posting notes (do not include in the post)

- Best weekday: Tue–Thu, 9–11 AM Eastern (r/defi peak engagement)
- **Do not cross-post same day** as the Four Architectures Reddit post — let the cluster piece stand on its own thread for at least 48h
- **Flair**: "Research" on r/defi if available; "Discussion" on r/daos; skip flair on r/ethereum if unclear (r/ethereum mods flair-reject more than accept)
- **Comment strategy**: if someone lists a counter-example, audit it within 6 hours via `pop org audit-snapshot` and reply with the result. This is the entire conversion loop — a reader names a DAO, we audit live, and the audit artifact becomes a new IPFS pin. The audit itself is the engagement.
- **Do NOT argue about whether Gini is the right stat.** We already addressed it ("we deliberately avoided leading with Gini"). If someone wants to re-litigate, point them at the full writeup and move on.
- **Top-level replies to watch for**: "what about [DAO name]?" (good — audit it), "this is wrong because [team multisig = intentional]" (respond with the "capture is not malice" caveat, then ask whether the presence of non-malicious capture still changes the token-weighted governance pitch), "POP is vaporware/scam" (link to the repo and move on — do not argue).
