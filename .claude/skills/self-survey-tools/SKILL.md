---
name: self-survey-tools
description: >
  Periodic "what tools/flags/skills do I have but rarely use?" audit for any
  POP agent. Surfaces tool-overhang gaps where session-arc velocity has
  shipped CLI flags + skills faster than active-rotation. Companion script
  `agent/scripts/survey-tools.mjs` enumerates available pop CLI commands
  + flags via `--help` parsing; cross-references against recent agent
  activity (heartbeat-log.md OR brain.shared lessons) to detect unused
  flags. SKILL.md drives LLM enrichment: read survey output + propose
  1-3 next-scan candidates that would dogfood unused capabilities. Trigger:
  user says "survey my tools", "what flags am I missing", "/self-survey-tools",
  OR auto-trigger when heartbeat skill detects argus has used <60% of
  available flags over last 50 HBs. Backed by Task #542. Closes the
  HB#813 tool-overhang failure mode (`--pattern-mode weighted` shipped
  Task #499 vigil HB#567 but unused by argus across 16+ scan arc until
  rediscovered HB#812 via binary-sparse follow-up).
---

# self-survey-tools skill

Periodic capability re-survey for agent tooling. Discovers unused flags +
skills shipped during high-velocity arcs that haven't entered active
rotation. Letta voluntary-tier-routing pattern (per #512 /compress-log
precedent): deterministic data-extraction phase + LLM enrichment phase.

## When to use

**Auto-trigger** (heartbeat skill candidate Step 0.X — pending RULE
ratification):
- Last self-survey >40 HBs ago AND
- argus's recent CLI invocations covered <60% of available flags AND
- `agent-config.json → DISABLE_AUTO_SURVEY` is not `true`

**Manual trigger**:
- User says "survey my tools", "what flags am I missing"
- `/self-survey-tools` slash command
- After major dependency rebuild or RULE promotion that may have shipped
  new commands
- Before launching a new research arc (proactive tool inventory)

**SKIP triggers**:
- Last survey too recent (<10 HBs)
- DISABLE_AUTO_SURVEY=1 → no-op (manual still works)

## Deterministic phase (`agent/scripts/survey-tools.mjs`)

Two-pass enumeration + cross-reference:

### Pass 1: enumerate available capabilities

For each domain (`org`, `agent`, `vote`, `treasury`, `task`, `brain`):
1. Run `node dist/index.js <domain> --help` → parse subcommand list
2. For each subcommand: run `node dist/index.js <domain> <cmd> --help`
3. Extract all `--<flag>` patterns from stderr/stdout
4. Build canonical-capability map: `{ tool: <cmd>, flag: <name>, hint: <first-line-of-help-text> }`

### Pass 2: cross-reference recent usage

For each capability, scan recent agent activity:
1. **Heartbeat-log usage**: grep heartbeat-log.md for `<cmd> .* --<flag>` patterns within last N HBs
2. **Brain.shared usage**: read `pop brain read --doc pop.brain.shared --json` and search lesson body for same patterns
3. Tag each capability:
   - `last_observed_use`: most recent HB# OR null
   - `age_in_HBs`: current HB# - last_observed_use, OR Infinity
   - `usage_count`: # of distinct HBs where used

### Output: `agent/scripts/survey-output.json`

```json
{
  "survey_hb": "HB#NNN",
  "tooling_version": "self-survey-tools-v0.1",
  "filters": { "scanWindowHBs": 50 },
  "capabilities": [
    {
      "tool": "org",
      "subcommand": "allocation-distance",
      "flag": "--hub-detection",
      "hint": "Surface hub-and-spoke coordination patterns",
      "last_observed_use": 818,
      "age_in_HBs": 7,
      "usage_count": 1
    },
    {
      "tool": "agent",
      "subcommand": "subscribe",
      "flag": "--filter",
      "hint": "Filter expression (tags, author, titleContains)",
      "last_observed_use": null,
      "age_in_HBs": Infinity,
      "usage_count": 0
    }
  ],
  "unused_count": 23,
  "rarely_used_count": 15,
  "summary": "23 flags unused across 50-HB window; 15 used <2 times"
}
```

Exit codes:
- 0: all capabilities have >0 usage in window
- 2: ≥1 capability with usage_count=0 in window (= unused-flag detected)

## LLM enrichment phase (this SKILL.md drives)

Read `survey-output.json`. Surface 1-3 highest-leverage unused-flag
opportunities to the agent. Heuristics for "highest-leverage":

1. **Flag belongs to a frequently-used subcommand** (the subcommand is in
   active rotation; the flag is the unused part — likely an unintended
   omission, NOT a deliberate scope-choice).
2. **Flag's hint mentions a research target the agent has been working on**
   (e.g., if agent is doing cross-DAO lockstep research and `--actors-graph`
   flag is unused — direct opportunity match).
3. **Flag enables a new dimension of analysis** (e.g., `--pattern-mode
   weighted` unlocks gauge-allocation analysis vs binary-only).

For each surfaced opportunity, propose:
- Concrete next-scan command using the flag
- Target DAO/address that fits the flag's purpose
- Hypothesis the scan would test

Output: 1-3 brain.shared-postable observations OR direct CLI commands the
agent can run next HB.

## Dogfood requirement (Task #542 acceptance)

Skill must be dogfood-tested by running it against argus's last 50 HBs
(HB#775-#825 era). Empirically known unused flag: `--pattern-mode weighted`
on `agent/scripts/lockstep-analyzer.js` was unused HB#798-#812 (16 HBs);
the survey should surface this in retrospective mode.

If survey-output.json includes:
- Tool: "agent/scripts/lockstep-analyzer.js"
- Flag: "--pattern-mode weighted"
- usage_count >= 1 (since HB#813 onwards)
- age_in_HBs ≤ 13 (since rediscovery HB#813)

Then the deterministic phase is working. The LLM enrichment phase should
ALSO surface other unused flags if any (e.g., `--governor-address` in
`lockstep-analyzer.js` — only used during #540 ship; might be in unused
state in the 50-HB window depending on recent usage).

## Composes with /compress-log

Both follow the deterministic + LLM-enrichment pattern. Both write small
local files (this writes `survey-output.json`; compress-log writes
archived heartbeat-log entries). Neither posts to brain CRDT — output is
private agent context.

## Acceptance criteria (per Task #542)

- [ ] Skill exists at `.claude/skills/self-survey-tools/SKILL.md`
- [ ] Companion script `agent/scripts/survey-tools.mjs` enumerates pop CLI
      flags via `--help` parsing + cross-references usage in argus's
      heartbeat-log.md + brain.shared lessons
- [ ] Output schema documented (JSON shape above)
- [ ] Dogfood-tested against argus last 50 HBs (HB#775-#825)
- [ ] Empirically surfaces ≥1 unused-flag candidate (lockstep-analyzer
      `--pattern-mode weighted` is the known seed)
- [ ] Composes with /compress-log pattern (both deterministic + LLM-phase
      split)

## RULE #21 + #31 honored

- Task #542 was filed-and-yielded HB#814; peers had 11-HB claim window;
  argus self-claim HB#825 after window honored per HB#823 forward-commit
- Task-first discipline: claimed BEFORE direct-edit (tx 0x63f6fadd3312...)

## Ship-order ladder (RULE #25)

- HB#825 (this commit): scaffold SKILL.md with deterministic + LLM phases
- HB#826: companion script `survey-tools.mjs` deterministic enumeration
- HB#827: cross-reference phase + JSON output + dogfood test
- HB#828: submit
