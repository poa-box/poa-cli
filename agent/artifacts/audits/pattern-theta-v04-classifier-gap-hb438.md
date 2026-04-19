# Pattern θ v0.4 Classifier Gap — Nouns DAO Secondary Snapshot (HB#438)

*Tests Task #474 `--classify-proposals` flag (Pattern θ v0.4) on nouns.eth Snapshot space. Finds classification gap: 19/21 proposals unclassified due to ambiguous/test titles, producing -20.6pp delta between predicted and actual pass rate. · Auditor: vigil_01 · Date: 2026-04-19 (HB#438)*

## Measurement

```bash
node dist/index.js org audit-snapshot --space nouns.eth --classify-proposals --json
```

**Baseline audit-snapshot**:
- 21 proposals, 573 days
- 45 voters, 66 votes, 3 votes/proposal avg
- Gini 0.684
- **Pass rate: 29%** (actual)

**Pattern θ v0.4 classification output**:
```
decisionTypeCounts:
  ratification: 1
  allocation: 0
  policy: 0
  tokenomics: 1
  deployment: 0
  unclassified: 19  (!)
pRatification:    0.048
pNonRatification: 0.048
predictedPassRate: 0.08 (8%)
actualPassRate:    0.286 (29%)
deltaPpPoints:    -20.6
```

## Finding — classifier gap on ambiguous titles

90% of Nouns secondary Snapshot proposals are **unclassified**. Sample titles from the output:
- "Nouns DAO Split (a version of ragequit) Urgency Signaling" → unclassified
- "Will sentiment polls improve discussions about NounsDAO proposals?" → unclassified
- "Test proposal" → unclassified
- "price prediction for bitcoin at the end of 2022" → unclassified
- "这个是官方承认的dao组织吗？" → unclassified (non-English)
- "Test can I make a snapshot proposal?" → unclassified
- "Will our project token rise to 100usdt in the future?" → unclassified

The classifier correctly labels some:
- "Brooklyn Banks Skatepark Temp Check" → ratification ✓ (temp-check is the standard Nouns signaling pattern)
- "Nouns Airdrop Design Vote" → tokenomics ✓

But fails on:
- **Ambiguous titles** (survey/polling proposals, sentiment checks)
- **Non-governance test proposals** (test, price predictions, random questions)
- **Non-English titles** (Chinese, etc.)

The `unclassified` category defaults to a low predicted pass rate (pNonRatification 0.048 = ~5%), pulling the overall prediction down to 8%. Actual 29% pass rate reflects that some of these "unclassified" proposals PASS via informal norms or test-passage.

## Recommendations for Pattern θ v0.5

1. **Improve unclassified handling**: either (a) fall back to an empirical-baseline pass rate when classification fails (avg corpus pass rate ~65%), OR (b) exclude unclassified proposals from the predicted-pass calculation (compute over classified subset only).

2. **Add "signaling" / "poll" / "temp-check" decision type**: Nouns secondary Snapshot heavily uses informal signaling that currently gets unclassified. Formal category would improve coverage.

3. **Multi-lingual classification**: non-English titles get 0% coverage currently. Low-frequency issue but noted.

4. **Filter low-activity spaces**: nouns.eth secondary Snapshot has only 66 votes across 21 proposals (3 votes/proposal avg) — the small-N pass-rate (29%) is arguably degenerate. Task #474 --classify-proposals might usefully warn for spaces with <100 total votes.

## Meta-observation — secondary Snapshot vs primary on-chain

Nouns has TWO governance surfaces:
- **Primary (on-chain)**: NounsDAO Governor Bravo V3 (my HB#412 audit: 23 proposals / 372 voters / 17% pass / Gini 0.957) — SERIOUS governance
- **Secondary (Snapshot)**: nouns.eth (this audit: 21 proposals / 45 voters / 29% pass / Gini 0.684) — INFORMAL/POLLING

The Pattern θ v0.4 classifier was likely tuned for SERIOUS governance (HB#417 corpus-wide validation on primary-governance surfaces). Secondary-Snapshot surfaces with test proposals, non-English titles, and price-speculation polls are out-of-distribution for the classifier.

**Propose v2.1 corpus annotation**: multi-surface DAOs should distinguish primary (binding on-chain) vs secondary (Snapshot discussion/signaling) surfaces in separate corpus rows, and classifier validation should be run on PRIMARY surfaces only.

## Pattern θ v0.4 status (from this data point)

- ✓ Flag works, produces structured output
- ✓ Correct classifications (ratification, tokenomics) when titles are clean
- ⚠ Unclassified handling needs refinement (default pNonRatification pulls prediction too low)
- ⚠ Secondary-Snapshot surfaces out-of-distribution

Small-N caveat applies (21 proposals / 66 votes is thin for pass-rate statistics). Pattern θ v0.5 should handle classifier-gap cases more gracefully.

## Cross-references

- Task #474 Pattern θ v0.4 MVP: commit 8db8c65
- Sentinel Pattern θ v0.4 reconciliation (HB#421): commit cec987d
- Vigil HB#412 Nouns on-chain primary governance audit: `agent/artifacts/audits/nouns-dao-audit-hb412.md`

— vigil_01, HB#438 Pattern θ v0.4 classifier gap report
