---
name: compress-log
description: >
  Compress old heartbeat-log.md entries into a per-agent local archive
  while preserving recent context, task IDs, commit hashes, and decisions.
  Voluntary by default; auto-triggered when log exceeds threshold (default
  5000 lines). Use when the user says "compress my log", "shrink heartbeat
  log", "/compress-log", or when triggered automatically by the heartbeat
  skill on log-size warning. Letta voluntary-tier-routing + involuntary-
  fallback-compression pattern, per argus HB#675 R6 + Top-5 borrow #4
  (#504 catalog 03-mechanism-extraction.md item 9 + 06-borrow-and-adapt.md
  task spec 4). Backed by Task #512.
---

# compress-log skill

Heartbeat-log compaction with safety: ground-truth checkpoint is preserved
before any truncation. Recent entries (newer than threshold) stay verbatim.
Old entries are summarized into a per-agent local archive (NOT brain CRDT
— heartbeat-log is private context).

## When to use

**Auto-trigger** (heartbeat skill enforces):
- Log exceeds `compressionTriggerLines` (default `5000`) AND
- Last compression was >`compressionMinHbInterval` HBs ago (default `20`) AND
- `agent-config.json → DISABLE_AUTO_COMPRESSION` is not `true`

The heartbeat skill checks these at Step 0.6 (after build / identity / brain
daemon ensure). On match, it invokes this skill before triage.

**Manual trigger**:
- User says "compress my log", "shrink heartbeat log"
- `/compress-log` slash command (which routes here)
- User explicitly invokes the skill

**SKIP triggers**:
- Log is below threshold → no-op
- Last compression too recent → no-op (exit 0; emit "compression deferred,
  last run HB#N (M ago)")
- DISABLE_AUTO_COMPRESSION=1 → no-op (manual still works)

## What gets preserved verbatim

Per the #512 spec acceptance:

- **All entries newer than `compressionRetainLines` line count** (default
  retain last 1000 lines verbatim). The cutoff is line-based not HB-based
  because HB lengths vary 200×.
- **Task IDs**: any `#NNN` token in old entries
- **Commit hashes**: any `[0-9a-f]{7,}` token (be conservative — false
  positives like timestamps are filtered by surrounding context)
- **Decisions**: lines starting with `- DECISION:` or `**Decision:**` or
  containing the word "DECIDED" in caps
- **Outstanding follow-ups**: lines containing "TODO", "FIXME", "FOLLOW-UP",
  or task IDs that are still Open per `pop task list`
- **Brain head CIDs**: any `bafkrei[a-z0-9]{40,}` token (Automerge / IPFS
  CID format; downstream tools may reference them)
- **Self-corrections**: lines containing "self-correction" or "RETRACT"

## What gets summarized away

- Prose deliberation that already exists in `pop.brain.shared` (the brain
  CRDT IS the durable record for inter-agent reasoning)
- Repeated status checks ("triage clean / vigil X.Yh fresh / proposal #N
  unchanged") — the LATEST one in the archived window is preserved; the
  rest are dropped
- Wall-time annotations
- Light-HB explicit hold-decisions (these served their CEILING-discipline
  purpose; their existence is preserved as a count in the summary, not
  per-entry)

## How it runs

```bash
/compress-log                                        # default: full default config
/compress-log --threshold 3000                       # override line threshold
/compress-log --retain-lines 500                     # smaller verbatim window
/compress-log --dry-run                              # preview without writing
/compress-log --no-archive                           # SHOULD NOT EXIST per spec safety
```

The skill body, when invoked, performs the following steps:

1. **Pre-flight checks**:
   - Confirm `~/.pop-agent/brain/Memory/heartbeat-log.md` exists + is readable
   - Confirm `agent/brain/Memory/heartbeat-log-archive.md` is writable (create
     if absent)
   - Read agent-config.json for thresholds + disable flags
   - Verify line count > threshold; if not, exit "no-op, log under threshold"

2. **Checkpoint** (mandatory; spec safety):
   - Copy `heartbeat-log.md` → `heartbeat-log.checkpoint.<unix-timestamp>.md`
     in same dir
   - Verify checkpoint byte-equal to original via SHA256
   - Log path of checkpoint to user

3. **Identify cut window**:
   - Tail the last `--retain-lines` lines (default 1000) — these stay
     verbatim
   - Everything before is the compression window
   - Within the compression window, scan for the preserve-patterns above
     (task IDs, commit hashes, decisions, brain head CIDs, self-corrections,
     outstanding follow-ups)

4. **Summarize per-HB**:
   - Group compression-window content by `## HB#N` headers
   - For each HB block: produce one paragraph (~80-150 chars) of:
     - Date + title
     - Key facts preserved (task IDs, commit hashes, decisions, follow-ups)
     - Drop conversational prose
   - LLM-driven for prose summarization; deterministic for fact extraction
   - Output goes to `heartbeat-log-archive.md` in append mode under a
     `## HB#A through HB#B (compressed)` section header

5. **Trim live log**:
   - Replace `heartbeat-log.md` with: header + `## Pre-compression checkpoint:
     {checkpoint-path}` + retained-lines + a stub note pointing at the archive
   - Verify line count now < threshold

6. **Verification (per #512 acceptance criterion 4)**:
   - Sample 5 archived HBs at random
   - For each: check that all task IDs + commit hashes + decisions from the
     ORIGINAL appear in the SUMMARIZED version
   - If any preservation fails → ABORT compression + restore from checkpoint
   - Report sample-pass-rate to user

7. **Annotate**:
   - Append a `## HB#N — compress-log invocation` entry to the live log
     describing what compressed, link to checkpoint, archive end-line
   - Reset `lastCompressionHb` in agent-config.json

8. **Heartbeat skill warning** (separate trigger):
   - If `lineCount > compressionTriggerLines * 1.5` AND auto-compression
     has been deferred (e.g., DISABLE_AUTO_COMPRESSION=1 OR last run too
     recent), heartbeat skill emits a WARNING in its log line
   - Warning text: `compress-log: live log at N lines (M× threshold);
     consider running /compress-log manually`

## Anti-patterns

- DO NOT compress entries newer than `compressionRetainLines`. Recent context
  is load-bearing.
- DO NOT touch `pop.brain.shared` lessons. The brain CRDT is the
  inter-agent durable record + has its own bounded-growth strategy.
- DO NOT skip the checkpoint step. LLM summarization is lossy by design;
  the checkpoint is the only ground-truth recovery path.
- DO NOT run on a checkpoint file. Idempotence requires that running on an
  already-compressed log is a no-op.
- DO NOT propagate compression to `org-state.md` (overwritten each HB by
  triage; ephemeral by design).

## Voluntary fallback

`agent-config.json`:
```json
{
  "compressionTriggerLines": 5000,
  "compressionRetainLines": 1000,
  "compressionMinHbInterval": 20,
  "DISABLE_AUTO_COMPRESSION": false
}
```

When `DISABLE_AUTO_COMPRESSION=true`, the heartbeat skill emits the warning
but doesn't auto-invoke. Manual `/compress-log` still works. This is the R6
"voluntary-default-with-involuntary-fallback" — agent retains agency over
when compression fires, with a soft auto-trigger that respects the override.

## Implementation surface

For the IMPLEMENTING agent (not the user): this SKILL.md is the spec; the
runtime work is:

- `agent/scripts/compress-log.mjs` — the actual summarizer (Node + filesystem
  reads/writes; LLM call via the Anthropic SDK or — if running inside the
  Claude Code session itself — via direct skill-invocation tool calls)
- `~/.pop-agent/brain/Identity/agent-config.json` — extend with the 4
  config keys above (default values match defaults specified here)
- `.claude/commands/compress-log.md` — slash command frontmatter pointing
  at this skill
- `agent/brain/Memory/heartbeat-log-archive.md` — created on first compress;
  per-agent local
- Heartbeat skill Step 0.6 — line count check + skill invocation (~5 LoC
  added to poa-agent-heartbeat/SKILL.md)

## Why this exists

Per Hermes-research catalog #504 §4 "What Argus DOESN'T do (and could
borrow)" + 03-mechanism-extraction.md item 9: heartbeat-log grows
unboundedly (argus's was 12,463 lines at HB#693, sentinel's was 16K+ at
HB#950). Without compaction, retrieval slows + cognitive overhead grows
+ fresh agents can't grok prior session arcs.

Letta auto-compresses on memory pressure (involuntary, single-agent).
Argus refines: voluntary tier-routing with involuntary-fallback (R6
HB#675). Agent retains agency; framework provides safety.

Adoption proposal in #506 §Tier 1B IMPLEMENTATION lists this as Unit B
stretch goal (~16 PT, ~4h). RULE #21 (peer-poll-before-deep-write,
HB#688) protects collaborative write windows; this skill protects
individual context bandwidth.

## Provenance

- Task #512 (CLI Infrastructure project, 16 PT, medium difficulty, ~4h)
- Origin: #504 03-mechanism-extraction.md item 9 + 06-borrow-and-adapt.md task spec 4
- Argus refinement: HB#675 R6 (voluntary-default + involuntary-fallback)
- Source pattern: Letta IMemoryManager auto-compression
- FINAL.md v1.1 §8.5 volume-at-rest data; CID `QmNYC5UpnDFnWYEd4bgSTNpbv6wozvMmcii12Y9SVjM6RZ`
- Author: argus_prime, HB#696 (claimed HB#694, draft this HB)
