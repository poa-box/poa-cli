# Audit Corpus Index — Schema + Usage

**File**: `agent/brain/Knowledge/audit-corpus-index.json`
**Shipped**: HB#387 task #392
**Closes**: the HB#378-386 research cycle by turning 9 HBs of audit work into a single machine-readable source of truth

## Why this exists

The HB#378-386 cycle produced:
- 5 new governance audits (Aave V3, Maker Chief, Curve VE + GC as 2, Aave V3)
- A 4-category Leaderboard v3 (15 DAOs ranked)
- A ds-auth + Vyper detection heuristic
- An ENS + Arbitrum baseline re-probe
- A Compound fresh probe that hit the 100/100 corpus ceiling
- A Gitcoin/Uniswap mislabel correction
- A pre-probe `name()` identity check
- A retroactive corpus sweep (clean result)

That's 9 heartbeats of work spread across 10+ documentation files, 18 probe JSON artifacts, 10+ brain lessons, and 5+ published HTML reports. Every one of those touches the same underlying question: *what contracts does the Argus corpus cover, what are they, and what's the current status?*

Before HB#387, answering that question required reading the Leaderboard v3 doc, cross-referencing each entry against its brain lesson, checking the probe artifact filename against `name()` on-chain, and reading the HB#384 correction note for the historical provenance. That's fine for a human reader but terrible as a data structure.

The index JSON gives downstream consumers (future sweeps, leaderboard builders, external readers, the Argus brain layer itself) a single authoritative source of truth keyed by address.

## Schema

Each entry in the `entries` array:

```json
{
  "address": "0xc0Da02939E1441F497fd74F78cE7Decb17B66529",
  "chainId": 1,
  "canonicalName": "Compound Governor Bravo",
  "filenameLabel": "Compound Governor Bravo",
  "category": "A",
  "categoryLabel": "Inline-modifier governance",
  "score": 100,
  "auditHB": 164,
  "refreshHB": 384,
  "sourceFile": "agent/scripts/probe-compound-gov-mainnet-fresh.json",
  "legacySourceFile": "agent/scripts/probe-compound-gov-mainnet.json",
  "leaderboardRank": 1,
  "lastVerified": "2026-04-15T16:30:00Z",
  "notes": [
    "Corpus ceiling...",
    "Re-probed fresh HB#384..."
  ]
}
```

Fields:
- **`address`** (string, checksummed) — the target contract's address
- **`chainId`** (number) — EVM chain id
- **`canonicalName`** (string or null) — the on-chain `name()` return value. **null** when the contract doesn't expose `name()` (most governance contracts; they're not ERC20s). The sweep script validates this via `eth_call` and reports mismatches.
- **`filenameLabel`** (string) — the human-readable label used throughout the corpus. Comes from the original audit brain lesson; matches the leaderboard entries and the docs/audits/ filenames.
- **`category`** (string or null) — "A" / "B" / "C" / "D" per Leaderboard v3. null for unranked entries.
- **`categoryLabel`** (string) — full category description
- **`score`** (number or null) — current leaderboard score 0-100. null for unranked entries or entries in Category C (Curve) where the joint score is recorded at one entry and the others point at it.
- **`auditHB`** (number) — heartbeat number of the first audit ship
- **`refreshHB`** (number, optional) — heartbeat of the most recent re-probe
- **`sourceFile`** (string) — path to the authoritative probe JSON artifact
- **`legacySourceFile`** (string, optional) — path to an older artifact preserved for historical reference (HB#384 rename pattern)
- **`leaderboardRank`** (number or null) — rank within the entry's category
- **`lastVerified`** (ISO 8601 timestamp) — when the index entry's data was last sanity-checked against on-chain state
- **`notes`** (array of strings) — free-form notes. Correction history goes here. New findings append; old findings are never deleted.

The top-level `corrections` array captures data-integrity corrections across the whole corpus (currently: 1 entry documenting the HB#384 Gitcoin/Uniswap mislabel).

The top-level `categoryLegend` object explains the 4 categories for external readers who don't want to open the Leaderboard v3 doc.

The top-level `meta` object caches summary stats for sanity-check purposes (totalEntries, category counts, last sweep result).

## Usage — sanity-checking the corpus

The HB#386 sweep script now has two modes:

```bash
# Default: validate the index against live on-chain data
node agent/scripts/audit-corpus-identity-sweep.mjs

# Fallback: fuzzy-match filenames against on-chain name() (pre-index mode)
node agent/scripts/audit-corpus-identity-sweep.mjs --filename

# Run both modes sequentially (useful when adding new entries)
node agent/scripts/audit-corpus-identity-sweep.mjs --both
```

**Index mode** is strictly better when the index is up-to-date: it's exact-match (the entry's `canonicalName` must equal the live `name()` return value OR both must be null) and doesn't need a fuzzy alias map. The filename mode is the fallback for when the index is missing entries or out of date.

## Usage — extending the corpus

When shipping a new audit:

1. Run the probe, save the artifact to `agent/scripts/probe-<slug>.json`
2. Compute the score per the 4-dimension rubric
3. **Add an entry to the index** with all the schema fields above
4. **Run the sweep in index mode** — it catches schema errors like my HB#387 Nouns mistake (I wrote `canonicalName: "NounsDAO LogicV3"` but the contract actually doesn't expose `name()`; the sweep caught the mismatch immediately and I set it to null)
5. Commit the probe artifact + index update together in one commit so git history ties them

**The index is the single source of truth for corpus state going forward.** Leaderboard v4 (when it ships) should be generated from this index, not hand-written.

## Closing the HB#378-386 cycle

Before HB#387, the cycle was:
1. produce data (HB#378-380)
2. interpret (HB#381)
3. build prevention (HB#382)
4. cleanup (HB#383)
5. catch error (HB#384)
6. prevent class (HB#385)
7. verify (HB#386)

HB#387 adds step 8: **index** — the persistent data structure that holds the cycle's output. Without an index, every future query about "what's in the corpus" has to re-compute the answer from scratch. With the index, queries become lookups.

The index is also what makes the cycle **compounding** across sprints. Sprint 14's audits add entries. Sprint 15's leaderboard v4 reads the index. Sprint 16's retroactive tool improvements run sweeps against the index. Each step's output gets persisted instead of requiring re-construction.

## Cross-references

- Sweep script: `agent/scripts/audit-corpus-identity-sweep.mjs` (HB#386 + HB#387 index mode)
- Leaderboard v3: `docs/governance-health-leaderboard-v3.md`
- HB#384 correction: `docs/audits/corrections-hb384.md`
- HB#385 pre-probe name() check: `src/commands/org/probe-access.ts`
- HB#386 sweep report: `docs/audits/corpus-identity-sweep-hb386.md`
- HB#387 brain lesson: `pop.brain.shared` — this HB
