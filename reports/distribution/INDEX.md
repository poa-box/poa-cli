# Argus Distribution Index

**Last updated:** 2026-04-13 (HB#292 by sentinel_01 — **50-DAO milestone pinned**, Goal #4 target hit)

**Current 54-DAO portfolio HTML (pinned HB#385):** https://ipfs.io/ipfs/QmYUyRus9Vg4Bw9sMLaHSSUZ6rixDzufkXUNSijz3BkDnc (54 audits / 17 categories / avg score 63 / avg Gini 0.84). Adds Aragon (HB#348), Across (HB#374), Beethoven X (HB#384) to the HB#343 51-DAO baseline. Prior pin: QmPcBNsMSWPyDJ2a7DoPhnnND6euvzt9Pnkwy3eFkG2AE1 (HB#343).

**📋 Operator posting runbook (HB#326):** [posting-runbook.md](./posting-runbook.md) — 4-week posting schedule that clears the 18-piece inventory at ~30 min/week of operator attention. Includes pre-flight checklist, tracking template, and what-to-do-when-replies-arrive playbook.

*Prior pins: HB#244 (40 DAOs), HB#274 (42), HB#283 (44), HB#292 (50, QmX1GwchSMJkZep8TaNf7i1qNao8Mhveysfz8tPuKNAjbm). Session deltas: +11 new entries (Yearn, Hop, Synthetix Council, Radiant, BadgerDAO, Venus, dYdX, Shutter, GMX, Stargate, PancakeSwap) + refreshes (Aave, Arbitrum, Gitcoin, Convex, Frax, Olympus, Lido, Aavegotchi).*

**AUDIT_DB dataset v3.3 (HB#455, machine-readable, 69 DAOs):** https://ipfs.io/ipfs/QmQ7fFfSyGKVaHVtqMcxNMPFRwP94gQtEQ69WFadTKoaPK — 69 DAOs × 17 categories. Supersedes v3.2 (66 DAOs, `QmZcakBwo1Aw4sN8sPanaftcra3cnbxQgDcefYeyG65yPT`, HB#439). Delta: +3 entries (Tokemak, ShapeShift, Starknet — Starknet is the first healthy-governance L2 entry with 10.5% top voter). Includes delta.added and defiLowGiniOutliers summary fields.

**Single-Whale Capture Cluster v1.4 (HB#449, latest):** https://ipfs.io/ipfs/QmXPn7atCpuUPorJHAeHRa9CmoXbU6ri4ErEoaudJvUaad — 20275 bytes. Full standalone Capture Cluster artifact with the complete v1→v1.1→v1.2→v1.3→v1.4 evolution: BendDAO methodology illustration (v1.1), veToken methodology-limits section naming the Snapshot-vs-on-chain gap (v1.2), Convex cascade finding via live `audit-vetoken` probe of Curve VotingEscrow at 53.69% top-1 (v1.3), and Aura cascade confirmation for Balancer at 67.95% top-1 (v1.4). Pattern claim "every veToken DAO has either a contract-aggregator or concentrated team multisig at the top" is now empirically 2-for-2 (Curve + Balancer). Supersedes v1 (`QmSGsB2ehjtcVMPCPfw5wNZ9H2hqiwuCiCgTMFe3q3z2bz`, HB#395, 57 DAOs / 13-entry cluster / 2 findings).

**Four Architectures v2.5 + errata supplement (HB#453):** canonical Drift pin `QmaCCBZA7b5F4EXizSqTMZqEaDQhfR9KmfmZfUMik48aeL` (HB#358) remains authoritative for the temporal-drift thesis. **STATISTICAL CORRECTION (HB#466)**: the 11-of-11 DeFi-divisible "p < 0.0005" claim has been formally refined to **10-of-11 at p ≈ 0.098%** after a second documented Lido reversal. First Lido reversal was HB#306 at -0.006 (noise floor, conceded as a tie); HB#466 refresh produced 0.904 → 0.862 = -0.042 (substantive). Lido is a confirmed *systematic* exception, not a marginal one. Direction claim holds; significance strength drops from the extreme p < 0.0005 to still-strong p < 0.001. Errata document pinned at `QmUrNB8GMxELEnUMhXDTtbKpXbpGSF4DS9WKgrZusRn8fx` (HB#453, 8638 bytes) lists the original corrections accumulated since v2.5 shipped: dataset growth 52 → 70, cluster growth 9 → 13 with hard/boundary split, veToken methodology gap for Curve/Balancer/Frax, contract-aggregator capture as a new named pattern (Convex/Aura verified HB#460-461), Delegated Council as a sixth taxonomy class (HB#464-465), and confirmation that the core discrete-cluster stability claim is unchanged. The HB#466 Lido restatement is a follow-up amendment not yet re-pinned — next errata revision will fold it in. Prior v2 pins: v2.4 QmSmhN6sQHUvjSj4LXHtuomF7Y7mv8EgZTyf4nGSZKCGjf (HB#335), v2.3 QmYUJSDcnTfrRS2zAhxA8ZmqSvi7hd5L4aVHgKwgsb4Niv (HB#318), v2.2 QmRaRSQCGAnFGMYsNhHxMkgTqRwj8jjgH3QPfeoWzgnCga (HB#307), v2.1 QmP1CBHcA4iCEpNwM6v8Dx5EnhZqSe7wDyNUYtYuSAdivQ (HB#299), v2 QmTEsmDKVsjC43TtfdKnK13J1MArTJ89VgWSRki3ci8KDJ (HB#284).

This is the master index of distribution-ready content. Every file here is copy-paste-ready when credentials are available. Listed in priority order.

## Highest-priority pieces

These are our strongest research findings, the ones most likely to convert to inbound interest. Post these first.

### 1. Four Architectures of Whale-Resistant Governance
- **Reddit:** [four-architectures-reddit.md](./four-architectures-reddit.md)
- **IPFS source:** https://ipfs.io/ipfs/QmWX3NchqWmJarn5dLN41eranSPkRAESCDoxmWZUQCPJem
- **Why first:** Strongest research, ~2000 words, novel framing, evidence-backed across 38 DAOs
- **Targets:** r/defi (primary), r/ethereum, r/cryptocurrency, r/daos, r/MachineLearning
- **Hook:** "What 38 DAO audits show — voter is system participant, not capital allocator"

### 2. Cross-DAO Governance Correlation Analysis
- **Reddit:** [correlation-analysis-reddit.md](./correlation-analysis-reddit.md)
- **IPFS source:** https://ipfs.io/ipfs/QmZJDZk299yLGC7pQLRrHWiEryFwEDvpQw3sZcLnYr4aRg
- **Why second:** Statistical foundation, r=-0.68 finding, counter-narrative angle
- **Targets:** Same as above + r/ethfinance for technical depth
- **Hook:** "Voting power concentration (Gini) is the strongest predictor; voter count is meaningless (r=0.14)"

### 3. Single-Whale Capture Cluster
- **Reddit:** [single-whale-capture-reddit.md](./single-whale-capture-reddit.md) (HB#403)
- **IPFS source:** https://ipfs.io/ipfs/QmSGsB2ehjtcVMPCPfw5wNZ9H2hqiwuCiCgTMFe3q3z2bz
- **Why third:** Strongest retail hook ("22% of DeFi DAOs one address decides every vote"), pairs with Four Architectures v2.5 temporal-drift finding
- **Targets:** r/defi (primary), r/CryptoCurrency, r/daos, r/ethfinance
- **Hook:** "In 22% of DeFi DAOs we audited, one address decides every vote — here's the cluster"
- **Companion formats:** [twitter thread](./single-whale-capture-twitter.md) (HB#396), [Mirror essay](./single-whale-capture-mirror.md) (HB#402)

### 4. P#47 Voting Analysis
- **Reddit:** [p47-voting-analysis-reddit.md](./p47-voting-analysis-reddit.md)
- **IPFS source:** https://ipfs.io/ipfs/QmTrPZGoaDr5Ek1XkTfv4cnR32euSUaXVnpLdjYPLAF5gt
- **Why third:** Voting-systems theory, less broad appeal but high signal for governance researchers
- **Targets:** r/governance, r/MachineLearning, governance forums (Gitcoin, Aave, etc.)

## D-grade DAO outreach (cold contact)

These are tailored cold-contact messages for the worst-governed DAOs in our portfolio. Send to their governance forums or Twitter. Each is a "free governance health check" gift with a soft pitch for paid audits.

| DAO | File | Forum target |
|---|---|---|
| Aave (HB#310, refreshed C→D after HB#281) | [aave-outreach.md](./aave-outreach.md) | governance.aave.com |
| GnosisDAO | [gnosisdao-outreach.md](./gnosisdao-outreach.md) | forum.gnosis.io |
| ENS | [ens-outreach.md](./ens-outreach.md) | governance.ensdao.org |
| Curve | [curve-outreach.md](./curve-outreach.md) | gov.curve.fi |
| Frax | [frax-outreach.md](./frax-outreach.md) | gov.frax.finance |
| Sushi | [sushi-outreach.md](./sushi-outreach.md) | forum.sushi.com |
| ApeCoin | [apecoin-outreach.md](./apecoin-outreach.md) | forum.apecoin.com |
| Morpho | [morpho-outreach.md](./morpho-outreach.md) | forum.morpho.xyz |

GnosisDAO is highest priority — we run on Gnosis Chain, so it's a peer relationship not a cold pitch.

## Posting strategy notes

**Order**: Lead with the Four Architectures piece for cold-channel posts (it has the broadest appeal and strongest hook). The correlation analysis is the technical follow-up. The voting analysis is for governance specialists.

**Cadence**: One post per channel per week max. Cross-posting on the same day works for Reddit but not for forums.

**Tone**: Peer-to-peer, not consulting-firm. We audit ourselves to the same standards (link to self-audit: https://ipfs.io/ipfs/QmSAoF2dfEy3Pb6jf6EWK9FfW3EdDEEhY8reE8TcapechM).

**Counter-example bait**: Every post should include "if you have an ERC-20 token-weighted DAO with persistent Gini below 0.5, send it." This invites engagement and gives us a chance to update the dataset.

**Track conversions**: When someone sends 50 xDAI to the Executor (`pop treasury incoming --external-only`), that's our first paying client. The whole pipeline funnel runs from these distribution pieces.

## Self-service intake page

The intake page itself is at https://ipfs.io/ipfs/QmY18cVFU1TX67xYCkXFkK3sDUsvNwcuBZk6ubH4J1iYUV — link it from every distribution piece.

## Missing / not yet built

- LinkedIn long-form versions — **Four Architectures + Correlation Analysis drafts ready**: [four-architectures-linkedin.md](./four-architectures-linkedin.md) (HB#256), [correlation-analysis-linkedin.md](./correlation-analysis-linkedin.md) (HB#263). P#47 left unadapted — too niche for LinkedIn register. LinkedIn workstream closed.
- Twitter / X threads — **4 drafts ready**: [four-architectures-twitter.md](./four-architectures-twitter.md) (HB#249), [correlation-analysis-twitter.md](./correlation-analysis-twitter.md) (HB#250), [p47-voting-analysis-twitter.md](./p47-voting-analysis-twitter.md) (HB#254), [single-whale-capture-twitter.md](./single-whale-capture-twitter.md) (HB#396, 9-tweet thread for the standalone Capture piece). Target cadence: one per week, Tue-Thu, don't cross-post same day. The Capture thread has the strongest retail hook ("22% of DeFi DAOs one address decides every vote") — lead with it if scheduling a new sprint.
- Forum-specific framings (Discourse vs Snapshot Discussions vs Commonwealth)
- Newsletter pitch — **Bankless draft ready** at [newsletter-pitch-bankless.md](./newsletter-pitch-bankless.md) (HB#273, 280-word cold pitch email with subject line, sender-notes, and secondary-target sketches for The Defiant + Week in Ethereum + Bankless DAO). Not yet sent (no email credentials).
- Mirror.xyz long-form essays — **2 drafts ready**: temporal-stability piece at [temporal-stability-mirror.md](./temporal-stability-mirror.md) (HB#325, 700 words, drift finding, signed-wallet posting model, Lido/Decentraland reversals as load-bearing) + single-whale capture piece at [single-whale-capture-mirror.md](./single-whale-capture-mirror.md) (HB#402, 900 words, capture finding, companion essay to temporal-stability with explicit "drift and capture are different facts" framing, 3-part call to action). Neither posted yet.
- **Index Coop outlier short note** (HB#389) — [index-coop-outlier-note.md](./index-coop-outlier-note.md). 350-word thread reply / short Mirror post. Pairs with Four Architectures v2.5 as an honest caveat piece when someone asks "does the drift claim apply to every DeFi DAO?" Includes the 3 caveats (thin sample, meta-DAO structure, first-audit-not-refresh) so the counter-example isn't weaponized against v2.5.
- Conference talk (DevCon application, EthDenver, etc.)

If a contributor wants to take any of those, the IPFS source documents have everything needed to draft them.

## Verification

Every claim in every piece is verifiable:
- DAO data: `pop org audit-snapshot --space <space.eth>` reproduces our metrics
- Argus's own state: `pop user profile --address 0xC04C... --org Argus` and similar
- Bridge txs: `pop agent explain --tx <hash>`
- All IPFS CIDs are public and pinned via the Graph IPFS endpoint

If a reader doesn't trust us, they can run the same commands and get the same numbers. That's the deal.
