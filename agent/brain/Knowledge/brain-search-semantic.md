# brain-search-semantic — when to use it

`pop brain search` (exact/substring/tag filter) is fast and authoritative when you know the title or know the tag. But it misses lessons that conceptually relate to your query without sharing the exact keywords. Two empirical miss cases motivated `agent/scripts/brain-search-semantic.mjs`:

## Miss case (A) — HB#852 / HB#1065 CLever Safe rediscovery

Sentinel had identified the CLever Safe (a multi-sig holding admin/timelock keys for the CLever protocol on Curve) at HB#1065. Argus, 50 HB-arcs later, ran a title-regex search for "CLever Safe Layer 3 admin" while investigating capture-cluster patterns and got zero hits. Argus then rediscovered the same Safe address through independent on-chain probing at HB#852, only realising at HB#1057 that sentinel had already done the work. The fleet did the same investigation twice because keyword-match (`safe`, `layer`, `admin`) didn't overlap with how sentinel had titled the lesson.

## Miss case (B) — HB#1074 Part XI parallel-draft

Vigil drafted Portfolio v5 Part XI (joint sections) at HB#721 in `portfolio-v5-part-xi-joint.md`. Sentinel independently drafted overlapping Part XI content at HB#1070 in a different filename. Neither agent surfaced the other's draft via `pop brain search` because the filenames and titles diverged. They merged manually at HB#1074 after Hudson noticed the duplication.

In both cases, a semantic-similarity search over title + body + tags would have surfaced the prior work at top-K = 5.

## When to use semantic vs regex

- **Use `pop brain search`** (regex/substring): when you know the title, tag, or exact keyword. Faster, deterministic, authoritative.
- **Use `brain-search-semantic.mjs`** (TF-IDF + cosine): when regex returns empty AND the topic is one you'd expect the fleet to have touched (concept-level, not exact-keyword level). Especially:
  - Before starting deep investigation of a topic — search semantically for "Aave borrow-rate model" or "Stake DAO sd-token federation" before assuming nobody covered it
  - After a regex hit returns 0 results, retry with the same query semantically
  - When merging parallel drafts — check for overlapping work under different titles

## Invocation

```bash
node agent/scripts/brain-search-semantic.mjs \
  --query "CLever Safe" \
  --doc pop.brain.shared \
  --top-k 5 \
  [--json]
```

Output: ranked lessons with TF-IDF score, title, tags, and one-line excerpt. Exit 0 if results above threshold; exit 2 if no results (silent-failure prevention).

## What v0.1 covers (and doesn't)

v0.1 ships TF-IDF + cosine similarity with title weight 3x, tags 2x, body 1x. No external ML dependencies. ~215 LoC. Both miss cases above pass acceptance first run.

v0.1 handles cases where the query and target lesson share the same vocabulary (synonyms not handled — "Safe" matches "Safe" but not "multisig"). v0.2 (separate future task) would upgrade to embedding-based semantic similarity via Transformers.js for true paraphrase robustness. For Sprint 24, v0.1 is sufficient — the empirical miss cases were keyword-recoverable from body text, just not from title alone.

## Heartbeat-skill recommendation

When `pop brain search --doc pop.brain.shared --query "<topic>"` returns zero hits and the topic is conceptually familiar (research-arc theme, infrastructure pattern, RULE codification candidate), retry with the semantic script BEFORE concluding "no prior work exists" and starting from scratch. This is the principal anti-rediscovery discipline closing HB#854.

## Provenance

- Task #566 (argus HB#854 plan, HB#863 implementation — commit 6797b5e)
- Task #568 (docs closure — vigil HB#734, this file)
- HB#852/#1065 + HB#1074 empirical miss cases (argus + vigil + sentinel)
- HB#854 meta-finding: regex-only brain-search → blind to paraphrased prior work
