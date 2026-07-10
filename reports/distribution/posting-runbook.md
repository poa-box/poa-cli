# Argus Distribution Posting Runbook

**Author:** sentinel_01 (HB#326 initial draft, refreshed HB#406 after Capture-cluster distribution arc)
**Audience:** Hudson (operator) — the only person with the credentials to actually post the inventory
**Purpose:** convert the now-22-draft inventory in `INDEX.md` into a concrete, time-boxed posting schedule that requires ~30 min/week of operator attention to clear.

**HB#406 refresh summary:** 4 new Capture-cluster pieces shipped HB#395-403 (standalone IPFS artifact + Twitter thread + Mirror essay + Reddit post). Plus the Index Coop outlier note (HB#390) as an honest caveat companion. Inventory grew from 18 → 22. The Capture-cluster pieces now have the strongest retail hook we've produced all session ("22% of DeFi DAOs have one address that decides every vote") and are the new lead priority over the Four Architectures v2.5 trio. Post them as a coherent week-1 block.

---

## The current inventory

11 distribution drafts, all reproducible from the `docs/distribution/` directory:

| # | File | Channel | Format | Audience | Status |
|---|---|---|---|---|---|
| 1 | four-architectures-reddit.md | Reddit | Post | r/defi, r/ethereum, r/daos | Ready |
| 2 | correlation-analysis-reddit.md | Reddit | Post | r/defi, r/ethfinance | Ready |
| 3 | p47-voting-analysis-reddit.md | Reddit | Post | r/governance, r/MachineLearning | Ready |
| 4 | four-architectures-twitter.md | X / Twitter | Thread | crypto-Twitter, governance researchers | Ready |
| 5 | correlation-analysis-twitter.md | X / Twitter | Thread | r/defi crossover | Ready |
| 6 | p47-voting-analysis-twitter.md | X / Twitter | Thread | governance specialists | Ready |
| 7 | four-architectures-linkedin.md | LinkedIn | Long-form | DAO operators, compliance | Ready |
| 8 | correlation-analysis-linkedin.md | LinkedIn | Long-form | analysts, institutional | Ready |
| 9 | newsletter-pitch-bankless.md | Email | Cold pitch | David Hoffman, Ryan Sean Adams | Ready |
| 10 | temporal-stability-mirror.md | Mirror.xyz | Essay | crypto-Twitter, Farcaster, Lens | Ready |
| 11 | aave-outreach.md | governance.aave.com | Discourse forum post | Aave gov forum | Ready |

Plus 7 D-grade outreach files (curve, ens, frax, sushi, apecoin, morpho, gnosisdao) that are simpler cold-message templates.

**Total inventory: 18 ready-to-post pieces.** Currently posted externally: 0.

The bottleneck is not draft production; it is operator attention to credentials and posting cadence. This runbook is the bridge.

## The minimum-viable posting schedule

This schedule assumes ~30 min/week of operator attention. If you have more time, accelerate. If less, drop the cadence not the order.

### Week 1 (highest leverage first)

**Day 1 (Tuesday) — Reddit + Bankless newsletter pitch**
- Post `four-architectures-reddit.md` to **r/defi** (primary). Use the body verbatim. Don't add disclaimers.
- 30 minutes later, send `newsletter-pitch-bankless.md` from your operator email to David and Ryan. Subject line is in the file. The 7-day soft deadline is real: if no reply by Day 8, send the same pitch to The Defiant.
- Track: did the Reddit post get any comments? Did the email get any reply?

**Day 3 (Thursday) — Mirror.xyz**
- Post `temporal-stability-mirror.md` from the sentinel_01 wallet (0xc04c860454e73a9ba524783acbc7f7d6f5767eb6) for cryptographic attribution. The honesty paragraph about Lido / Decentraland reversals is load-bearing — do not edit.
- Post will auto-syndicate to Farcaster + Lens. No additional posting needed.
- Track: cross-platform reach.

### Week 2

**Day 1 — X / Twitter thread**
- Post `four-architectures-twitter.md` as 11 tweets (the v2 update tweet is in the appendix). Pre-write all 11 in a TweetDeck draft before posting so the thread doesn't break mid-post.
- Best window: Tue-Thu 14:00-17:00 UTC.

**Day 3 — LinkedIn long-form**
- Post `four-architectures-linkedin.md` as a LinkedIn long-form article. The first sentence is optimized for LinkedIn's preview truncation.
- Best window: Tue 08:00-10:00 ET.

### Week 3

**Day 1 — Aave forum**
- Post `aave-outreach.md` to governance.aave.com as a top-level thread. The "we are not selling you a delegation tool" framing is the differentiator from consulting pitches; don't soften it.
- Day 2-7: respond to replies in-thread, never DM.

**Day 3 — Reddit #2**
- Post `correlation-analysis-reddit.md` to r/defi or r/ethfinance. Cross-post with care; one venue at a time, separated by 24 hours minimum.

### Week 4

- X thread #2 (correlation-analysis), LinkedIn #2 (correlation-analysis), Reddit #3 (p47-voting-analysis).

### After Week 4

- The 7 D-grade outreach files are individual-DAO cold messages. Send 1 per week to the relevant DAO's governance forum. They are intentionally low-volume, peer-to-peer, and scale with reply rate not your time budget.

## Per-post pre-flight checklist

Before posting any piece, run this 3-step check (~2 minutes per post):

1. **Verify the IPFS CIDs in the draft are still resolvable.** Run `curl -I https://ipfs.io/ipfs/<cid>` for each link. If any return 404, run `pop org portfolio --pin --json` to re-pin and update the draft before posting.
2. **Check that the cited DAO numbers are still current.** For pieces that cite specific Gini values (e.g., "Aave 0.957"), run `pop org compare-time-window --space <relevant-space>` to confirm the stored value matches the live value. If drift > 0.01, update the draft inline before posting.
3. **Check that the v1/v2/v2.x research piece CIDs are the latest.** The `INDEX.md` header always shows the current pin; cross-reference any in-draft pin against the header.

## Tracking what works

After each post, log to a simple spreadsheet (or to brain doc `pop.brain.distribution-log` if that exists by then):

- Date posted
- Channel + URL
- 24-hour engagement (upvotes, comments, replies, profile visits)
- 7-day engagement (same metrics, plus any inbound DMs / emails)
- Conversion: did anyone send xDAI to the Argus Executor? Did anyone request a paid audit?

The conversion field is the only one that ultimately matters. Engagement is upstream noise; revenue is the signal.

## What to do if posting reveals problems

- **A reply pushes back on a number.** Run `pop org audit-snapshot --space <X>` to verify. If they're right, post a correction. Errors recovered honestly are credibility-positive.
- **A reply asks for the dataset.** Send the current Four Architectures IPFS CID from `docs/distribution/INDEX.md` header (v2.5 at time of writing HB#358: `QmaCCBZA7b5F4EXizSqTMZqEaDQhfR9KmfmZfUMik48aeL`). Always check INDEX.md first in case a newer version has shipped. Don't summarize; the link is the answer.
- **A reply offers a counter-example DAO.** Audit it immediately with `pop org audit-snapshot` and reply with the result regardless of whether it confirms or falsifies. The falsifiability invitation is load-bearing — honor it.
- **No replies at all.** That's the most likely outcome for the first 2-3 posts. Engagement on cold-channel research takes weeks of consistent posting to build. Don't change strategy after one zero-reply post; change strategy after 5.

## What sentinel_01 cannot do for you

- Post anything (no credentials)
- DM anyone (no credentials)
- Receive replies (cannot read inboxes you don't share)
- Track engagement automatically (no scraper infrastructure)
- Negotiate pricing (no signing authority outside the Argus org)

What sentinel_01 CAN do once you've started posting:

- Generate per-DAO outreach in the same format as the existing 7 + Aave drafts
- Re-pin the portfolio when AUDIT_DB updates
- Run `pop org compare-time-window --space X` for any DAO before posting to verify numbers are current
- Refresh research artifacts when reviewer feedback comes in
- Audit any counter-example DAO that arrives via reply

## Bottom line

The distribution funnel is dramatically over-supplied for the current zero-posting rate. Adding more drafts is no longer the bottleneck. The bottleneck is the 30 min/week of operator attention to credentials and posting cadence. This runbook makes the path to clearing the inventory concrete and time-boxed.

— sentinel_01
