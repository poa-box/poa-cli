---
name: poa-agent-heartbeat
description: >
  Autonomous POP governance agent heartbeat. Use this skill whenever the user
  says "run heartbeat", "check the org", "agent cycle", "observe the org",
  "what's happening in the org", or triggers /heartbeat. Also auto-trigger
  on /loop invocations targeting this skill. Runs the full observe-evaluate-act-remember
  cycle for a POP organization using the pop CLI.
---

# POP Agent Heartbeat (v2 — Lean Protocol)

Each heartbeat: **PERCEIVE → DECIDE → ACT → ENCODE**

## Pacing (Hudson HB#603 directive — codified HB#604)

You are an LLM, not a human. Read/write/grep operations take SECONDS, not minutes. **Do not budget at human pace.** A HB that takes 3 min wall-clock at LLM-pace is NOT inherently full — that's only ~10-15 tool calls; you can do 30+ without strain. The /loop interval is 15 min but **overlap is fine** — if a HB runs long, the cron queues the next fire to start immediately after; nothing is lost. Prefer DENSER HBs over more-frequent shallow ones.

**Two-track structure (REQUIRED every HB)**:
- **Track 1 — Reactive** (~30s typical, time-boxed): delegations check (Step 1.5) + triage + peer activity scan + any pending reviews/votes. If track 1 surfaces a HIGH/CRITICAL action, handle it. If clean: 30 seconds + move on.
- **Track 2 — Proactive (MANDATORY, multi-deliverable)**: ship 2-3 substantive deliverables in parallel. Examples: research output that unblocks a peer, periodic self-audit (HB#388 cadence), vigil/argus/sentinel-lens audit on shipped substrate, philosophy/goals/capabilities update reflecting real shifts, vigil-lens edge-case test scenarios for shipped code, cross-org outreach prep, external-distribution content draft.

**Anti-patterns this corrects**:
- "Single proactive deliverable per HB" framing — too conservative; LLM-pace allows 2-3 in parallel
- "Reactive sufficient when peer activity is high" — peer-engagement ≠ creating value (HB#399 housekeeping-only failure mode; HB#601-#602 vigil instances)
- Long heartbeat-log narrative justifying decisions — the action is the deliverable; framing rotates fast and adds little
- Budgeting deferrals like "do self-audit next HB" when you could pack it now — at LLM-pace, "now" and "next HB" cost the same

**Heartbeat-log discipline**: short factual entries — what shipped, what tx, what brain CID. NO multi-paragraph rationalizations. Reflection lives in philosophy.md, NOT every HB log entry.

## File Reads (lean — read only what you need)

**Always read (every HB):**
1. `pop agent triage --json` — this IS the observation. One command.
2. `goals.md` — goal check: "does my planned action advance a goal?"
3. **`pop brain read --doc pop.brain.shared 2>&1 | tail -60 || true`** — team lessons from the CRDT substrate. See "Dogfood the brain layer" section below.
4. **`pop brain read --doc pop.brain.heuristics 2>&1 | tail -40 || true`** — live shared rules. This CRDT doc contains heuristic changes that ALL agents must follow. Rules here OVERRIDE the static `how-i-think.md` file. When you update a shared heuristic, write it here FIRST (brain CRDT), then update the file (git). Other agents see CRDT changes immediately; file changes only after branch merge.

**Read on trigger:**
4. `philosophy.md` — ONLY when voting (MANDATORY then — never skip)
5. `how-i-think.md` — ONLY when voting (heuristics after philosophy)
6. `shared.md` — ONLY when creating tasks/proposals (for dedup/context)
7. `lessons.md` — ONLY during planning phase (board empty)
8. `projects.md` — ONLY during planning or collaborative work

**Read once per session (not every HB):**
9. `who-i-am.md` — static identity
10. `agent-config.json` — execution mode

## Dogfood the brain layer (HB#311+)

Hudson's directive at HB#311: **the 3 agents here should actually USE the
brain layer so real errors emerge.** Until now the CRDT substrate has been
write-only hygiene (snapshot at end of HB). From HB#311 onward, reads and
writes of lessons go through `pop brain`:

**Writes (lessons):** when you want to record a lesson — something
surprising, a non-obvious design call, a correction — do NOT edit
`lessons.md` by hand. Instead:

```bash
pop brain append-lesson --doc pop.brain.shared \
  --title "Short imperative title (60 char max)" \
  --body "Multi-paragraph body. Explain the lesson, the reason, and
how future agents should apply it. Signs with POP_PRIVATE_KEY,
publishes head CID via gossipsub, seeds blocks for Bitswap."
```

The lesson lands in the local Automerge doc, signs with your agent
key, publishes a gossipsub head announcement. Other agents pick it up
if they are running a brain node at the same instant — which on a
single-machine 3-agent setup where agents run sequentially in 15-min
slots, they probably are NOT. That is exactly the error we want to
surface: sequential-agent brain sync has a peer-overlap gap, and
`pop brain subscribe` is the long-running process you would need to
stay resident to bridge the gap.

**Reads (lessons):** file read #3 above (`pop brain read --doc pop.brain.shared`)
now runs every HB. If you see content the hand-written `lessons.md`
doesn't have, your brain home has merged something a peer published.
If the output is empty or regressed compared to the committed
`agent/brain/Knowledge/pop.brain.shared.generated.md`, you are
running solo (no peer overlap this HB) and seeing only your local
replica. Log the discrepancy in the HB entry — that is data.

**Known gap this wedge will surface:**
- Agents running in sequential 15-min slots never overlap in time.
- Gossipsub is broadcast, not store-and-forward. Missed announcements
  are lost.
- Convergence requires either (a) co-running agents, (b) a persistent
  `pop brain subscribe` daemon, (c) git-as-transport for the raw IPLD
  blocks, or (d) swap transport to Waku (has native store protocol).
- The snapshot regression guard (HB#301, task #328) prevents silent
  disk clobber — any HB where local state is behind the committed
  generated.md will refuse to snapshot with `exit 1`, swallowed by
  the `|| true` wrapper in Step 3. That is the safety rail, not the
  sync mechanism.

**How to surface these errors in your HB log:**
- Count items in `pop brain read` output vs. items in the committed
  `pop.brain.shared.generated.md`. If read < committed, note it.
- Note when `pop brain append-lesson` returns a head CID but no peer
  receives it (you can see "Gossipsub peers: 0" in status output or
  verbose mode).
- Note when `pop brain snapshot` exits 1 with the regression error.
  That is vigil_01's HB#149 bug being caught by the guard.

**Do NOT** delete or bypass the hand-written `lessons.md` yet. Retire
it only after the dogfood phase produces a converged team state
across all 3 agents. Until then, `lessons.md` is the canonical
committed record and the brain layer is a parallel experiment.

## Implementation Intentions (anti-pattern guards)

These if-then rules fire automatically:
- **IF** triage shows same proposal 2+ HBs → **THEN** stop checking it, move on
- **IF** gas warning AND sponsorship env vars set → **THEN** ignore the warning
- **IF** triage shows a review → **THEN** review it, then CONTINUE to next action
- **IF** reviewing a task whose submission text references an integration test
  (`test/scripts/*.js`, `pop ... 2>&1`, `node test/...`, or any "verified
  live" / "ran the test" claim) → **THEN** ACTUALLY RUN the cited test
  before approving. Include the exit code + last 5 lines of output in your
  approve message. If no test exists or the deliverable is doc-only,
  explicitly note `code-review-only approval — no integration test cited`
  in the message. RATIONALE: HB#499 task #435 — vigil filed T1 #429 with
  a test that passed `node --check` but had never been run; sentinel
  approved on code review only; first run on sentinel's machine FAILED
  deterministically. The fix is procedural — record evidence, don't
  assume. Task #451 codified this rule.
- **IF** voting on a proposal → **THEN** first run `pop vote discuss --proposal N`
  to read existing discussion. If no discussion exists and the proposal is
  non-routine, POST a comment first (`--message`, `--stance`) and give other
  agents a heartbeat cycle to respond before voting. Rubber-stamping without
  deliberation led to #43/#46 draining the treasury and #44 failing.
- **IF** creating a non-routine proposal → **THEN** post a `pop vote discuss`
  comment explaining the rationale BEFORE the proposal is created, so agents
  can deliberate before binding votes.
- **IF** creating a task → **THEN** use `/task-create` skill for structured description
- **IF** claiming a medium/hard task → **THEN** invoke `/task-plan` skill before starting work
- **IF** submitting a task that ships repo files → **THEN** use
  `pop task submit --commit --commit-files <comma,list>` so the on-chain
  submission AND the git history land in one step. Task #355 (HB#185)
  added this flag specifically because the HB#172 incident cost two
  follow-up commits backfilling probe-access.ts after #345 + #351 had
  already shipped via IPFS. Pass explicit file paths only — never `.`
  or `-A`. The flag rejects those at runtime to prevent sweeping in
  cross-agent in-flight work. Pre-commit hook failures surface as
  warnings; the on-chain submission is never rolled back over a git
  issue.
- **IF** you just finished a review or governance action → **THEN** keep going.
  A single announce, vote, or review is NOT a full heartbeat. Continue to work/planning.
- **IF** board empty (after governance + reviews done) → **THEN** you MUST either:
  (a) create a task via `/task-create`, claim it, and start working, OR
  (b) plan the next sprint's work via `/sprint-plan` if priorities are stale.
  There is no option (c). "Board empty" always leads to creating or planning.
- **IF** about to write a heartbeat log entry → **THEN** run the Step 2.5
  no-op prevention check FIRST. If it fails, do substantive work OR use
  the documented `**Blocked:**` escape hatch per Step 2.5. Do NOT log a
  no-op heartbeat under any other framing ("stall legibility",
  "quiet interval", "same as last HB", "plateau hold", "no state change"
  all mean the same thing: you are writing a no-op and it is a protocol
  violation per brain lesson
  `no-op-heartbeats-violate-the-always-plan-rule`).
- **IF** you have written ≥2 consecutive no-op or `**Blocked:**` heartbeats →
  **THEN** the next HB MUST produce a substantive artifact (task creation,
  ship, audit, peer review, self-audit, brain lesson with new insight, or
  sprint planning). Operator silence is NOT a valid `**Blocked:**` reason —
  the org is autonomous, operate independently. Reference: HB#369-387 argus
  plateau-hold drift incident; HB#388 self-correction.
- **IF** ≥3 consecutive HBs have produced no new corpus audit / task / ship /
  peer-review-with-action → **THEN** run a self-audit THIS HB (the
  "Periodic self-audit cadence" in how-i-think.md). Output: a brain lesson
  titled `SELF-AUDIT HB#N` documenting what work IS available + why it
  wasn't done. Self-audits are mandatory drift prevention.
- **IF** exit criteria ≥ threshold AND no planning brainstorm exists → **THEN**
  start Sprint N+1 brainstorm. Continue with regular work after.
- **IF** planning brainstorm ready for promotion (≥8 HBs, all agents engaged) →
  **THEN** close brainstorm, create on-chain multi-option proposal. Continue work.
- **IF** planning proposal announced → **THEN** rewrite sprint-priorities.md with
  voted results. This is a substantive action for Step 2.5.

## Collaboration Checkpoint (MANDATORY — Step 1b)

After triage, before acting, do this EVERY heartbeat:
1. Skim `agent/brain/Knowledge/projects.md` — is there an active project at
   DISCUSS or PLAN stage? If yes, your FIRST action is to respond (pin feedback,
   advance the stage). This takes priority over solo task creation.
2. Check: did another agent create a task in the last heartbeat that you should
   claim instead of creating a new one? Run `pop task list --status Open --json`.
3. Check: are you about to create the same type of task you created last heartbeat?
   (e.g., another audit, another outreach message). If yes, do something DIFFERENT.
   Three agents all producing audits is worse than one auditing, one building, one distributing.

## Sprint Transition Detection (Step 1c)

After triage and collaboration checkpoint, check if the current sprint is
nearing completion and a planning cycle should begin. This runs every
heartbeat but produces at most one action per heartbeat.

1. Read `agent/brain/Knowledge/sprint-priorities.md`. Find the current sprint's
   "Exit criteria" section (under the current sprint header, before the `---`
   separator or next sprint snapshot).
2. Count lines containing `✅` (met) vs total criteria lines starting with `-`
   under that section. Compute `ratio = met / total`.
3. Read `sprintGovernance.exitCriteriaThreshold` from `agent-config.json`
   (default 0.75).
4. **If `ratio >= threshold`**, check the planning cycle state:

   **(a) No planning brainstorm exists?** Start one:
   ```bash
   pop brain brainstorm-start \
     --title "Sprint N+1 priorities" \
     --prompt "Sprint N exit criteria ≥75% met. What should Sprint N+1 prioritize?
   Add ideas as --add-idea responses. Consider: what shipped, what's unfinished,
   what's newly unblocked, what external opportunities exist." \
     --window-from-hb <current_hb> --window-to-hb <current_hb + 20>
   ```
   Then continue with regular work for this heartbeat.

   **(b) Brainstorm is open, ≥`brainstormMinHeartbeats` old, AND all 3 agents
   have engaged (each has ≥1 vote or idea)?** Close the brainstorm, rank ideas
   by net support, and create an on-chain multi-option proposal with the top
   ideas as options (see how-i-think.md "Sprint Governance Protocol" Phase 4).
   Then continue with regular work.

   **(c) Brainstorm open but conditions for (b) not met?** If you haven't
   responded yet, respond (add ideas, vote on existing ones). Otherwise skip —
   the brainstorm is in progress and doesn't need your action right now.

   **(d) Active planning proposal exists?** After voting, check
   `pop vote results --proposal N --json` — if all 3 members have voted,
   announce immediately via `pop vote announce-all` (early resolution —
   don't wait for the timer when everyone has voted). Then continue to (e).

   **(e) Planning proposal has been announced/executed?** Rewrite
   sprint-priorities.md with the voted results (see how-i-think.md Phase 6).
   This is a substantive action for Step 2.5.

5. **If `ratio < threshold`**: skip. The sprint isn't close enough to completion
   to start planning the next one.

**Key principle**: Sprint transition detection does NOT replace or block the
regular priority order (governance votes > reviews > work > planning). It
adds sprint governance actions as HIGH-priority items alongside existing work.
Agents keep working on current sprint tasks throughout all phases — the planning
cycle is parallel, never blocking.

---

## Step 0: Sync

**HB#368+: source the bot identity FIRST.** Every agent git/gh operation
must be attributed to ClawDAOBot, not the human operator. Before the fix,
commits were silently authored as the human — see `CLAUDE.md` "GitHub
Identity" section for the full root cause. The script is idempotent, safe
to source multiple times per session.

```bash
source ~/.pop-agent/bot-identity.sh
```

**HB#324+ CRITICAL: one source is NOT enough.** Claude Code's Bash tool
spawns a FRESH shell for EVERY invocation. Env vars set by this Step 0
source do NOT carry to later `git commit`/`gh` calls — those later shells
fall back to the human operator's global `~/.gitconfig` + `gh` keyring
and the commit is silently misattributed to the human. Multiple agent
commits have been caught doing this (cc06ab0 `hudsonhrh` at HB#343,
90a5027 `Hudson Headley` at HB#324).

**Required pattern for EVERY Bash call that does git or gh:**

```bash
source ~/.pop-agent/bot-identity.sh > /dev/null 2>&1 && git commit -m '...' ...
source ~/.pop-agent/bot-identity.sh > /dev/null 2>&1 && git push
source ~/.pop-agent/bot-identity.sh > /dev/null 2>&1 && gh pr create ...
```

The `> /dev/null 2>&1` suppresses the verification output on every
invocation; the `&&` ensures git/gh only runs if the source succeeds.

**Recovery** for a misattributed commit you just made (safe if not yet
pushed): `source ... && git commit --amend --reset-author --no-edit`.

**Cannot recover** an already-pushed misattributed commit by another
agent without a force-push (unsafe). The correct mitigation is
discipline: inline-source with every call going forward.

After sourcing, a quick sanity check (only needed if something is
misbehaving — skip for routine HBs):

```bash
gh api user 2>&1 | grep -q '"login": "ClawDAOBot"' && echo "bot identity OK"
```

Then the standard sync:

```bash
# Rebuild if source changed
find src/ -name '*.ts' -newer dist/index.js 2>/dev/null | head -1
```

If stale, `yarn build`. Then health check:

```bash
pop config validate --json
```

If health fails, log and stop. Next heartbeat retries.

---

## Step 0.5: Session bootstrap (tasks #438, #443, #459, #464, HB#504+)

The T1 rebroadcast primitive (task #429) only works when the local daemon is
running AND has at least one connected peer. Subgraph reads (every triage
call) only work when at least one of Studio/Gateway is up OR the cache has
fresh entries (#459). Multiple production failures motivated this step:

- **HB#272** finding: only 1 of 3 fleet daemons was alive. T1 code was correct,
  shipping rebroadcasts every 60s, but all of them landed in the void. Fix
  shipped as #438 — the original WARN-only version of this step.
- **HB#504** finding: sentinel operated an ENTIRE SESSION as a dark peer
  because their daemon never started. All brain writes routed in-process, never
  gossiped. argus/vigil assumed sentinel was unresponsive to the Sprint 17
  brainstorm. Hudson had to explicitly poke sentinel to discover the gap.
  Fix shipped as #443 — auto-start the daemon instead of just warning.
- **HB#524** finding: 5h GRAPH_API_KEY outage bricked every read command
  across all agents. Fix shipped as #459 — file-based read-through subgraph
  cache that serves stale on dual-endpoint failure.
- **HB#542** retro change-1: stitch the above into a single bootstrap so
  no agent skips one of the checks. Shipped as #464.

### What to run (RECOMMENDED — one call)

```bash
pop agent session-start --json | tail -1
```

This is the bootstrap stitcher (#464). Composes daemon-check (#443) +
subgraph-cache state (#459) + peer-registry health (#448) + warmup. Reports
all 3 subsystems in one JSON line. Exit 0 if daemon ok (CRITICAL); exit 1
if daemon failed. Subgraph/peer warnings are non-fatal.

Interpret the JSON `{ok, daemon, cache, peers}`:
- `daemon.status: running|started` AND `daemon.connections >= 1` → OK
- `daemon.status: running` AND `daemon.connections == 0` → WARN: isolated peer
- `daemon.status: failed` → CRITICAL: brain writes won't propagate; investigate
- `cache.status: warmed|fresh|skipped` → OK
- `cache.status: unavailable` (subgraph outage) → cache will serve stale on next read
- `peers.status: stale` → flag in HB log; daemon-side refresh may be lagging

### Legacy / fallback (if session-start fails)

```bash
pop brain daemon start 2>&1 | tail -3
```

`pop brain daemon start` is idempotent via `getRunningDaemonPid()` — if a
daemon is already running (whether started by this skill, by systemd/launchd,
or by a previous shell), it prints "Brain daemon already running with PID N"
and exits 0. If not running, it starts one and exits 0. Exit code is always
0 on either path — a non-zero exit indicates a genuine failure (lock
contention, bad POP_PRIVATE_KEY, etc). Then:

```bash
pop brain daemon status --json 2>&1 | tail -1
```

Interpret the status output:

- **`status: running` AND `connections >= 1`** → OK. Optionally log
  `daemon healthy — N peers, M announcements, K merges this session` in
  the HB entry so sync state is visible.
- **`status: running` AND `connections: 0`** → WARN in log: `daemon up
  but isolated — no live peers`. Fix is a daemon restart with
  `POP_BRAIN_PEERS=<peer-multiaddr>` env var. The auto-start path above
  does NOT set POP_BRAIN_PEERS (the skill doesn't know fleet addresses);
  for the 3-agent dev setup the operator must pre-populate
  `~/.pop-agent/.env` with POP_BRAIN_PEERS or run `pop brain daemon start`
  explicitly with the env var.
- **`status: stopped`** (the auto-start also failed) → log the failure
  verbatim, proceed with the HB. Local writes still work (standalone
  libp2p routing); only cross-agent gossip is disabled.

### Why auto-start is now safe

- `pop brain daemon start` checks `getRunningDaemonPid()` first. If a daemon
  is alive (including one started by systemd/launchd), it refuses to start
  a second one. No PID-file race.
- A systemd/launchd-managed daemon still uses `$POP_BRAIN_HOME/daemon.pid`,
  so the idempotency guard is fleet-wide, not shell-specific.
- The heartbeat never blocks on daemon state: if start fails for any reason
  (lock contention, missing deps, etc), the skill logs and proceeds. Local
  work still runs.

### Why this is not just Step 0

Step 0 is environment setup (bot-identity, rebuild, config validate) — it
runs before the agent knows what the session will do. Step 0.5 is a discrete
operational check with its own failure-mode documentation. Keeping it
separate preserves the ability to skip it (e.g., for unit tests that don't
need the daemon).

Cross-references:
- Task #429 (T1) — the rebroadcast primitive this check makes legible
- Task #438 — WARN-only version of this step (HB#273 ship)
- Task #443 — auto-start escalation after sentinel dark-peer
  incident HB#504
- Task #427 — separate bootstrap-layer gap (not fixed by daemon running)
- Task #459 — subgraph read-through cache + dual-failure stale fallback
- Task #464 — `pop agent session-start` bootstrap stitcher (this step's
  recommended one-call form, sentinel retro-542 change-1)
- Brain lessons: `T1 validated in production; orchestration gap surfaced`;
  `sentinel dark-peer incident HB#504`

---

## Step 0.6: Heartbeat-log size check (Task #512, HB#697+)

After session-bootstrap, check the per-agent heartbeat-log file size.
Long logs slow context loading + retrieval; the `compress-log` skill
provides voluntary-default with involuntary-fallback compression per
Letta-pattern adapted by argus HB#675 R6.

```bash
LOG="$HOME/.pop-agent/brain/Memory/heartbeat-log.md"
[ -f "$LOG" ] && wc -l < "$LOG"
```

Read `agent/brain/Config/agent-config.json` `compressLog` section:
- `compressionTriggerLines` (default 5000) — line count above which the
  log is candidate for compression
- `compressionRetainLines` (default 1000) — verbatim retention window
- `compressionMinHbInterval` (default 20) — minimum HBs between
  compression runs
- `DISABLE_AUTO_COMPRESSION` (default false) — operator opt-out
- `warnAtMultiple` (default 1.5) — emit warning at this multiple of
  trigger threshold

### Behavior

- **Below trigger threshold** → no-op, continue to Step 1.
- **Above trigger × warnAtMultiple** AND `DISABLE_AUTO_COMPRESSION=true`
  → emit one-line warning to your text output (NOT a brain.shared
  lesson; this is operator-visible only):
  `compress-log: heartbeat-log at N lines (M× threshold); /compress-log to compress manually`
- **Above trigger threshold** AND last-compression > `compressionMinHbInterval`
  HBs ago AND `DISABLE_AUTO_COMPRESSION=false` → invoke the
  `compress-log` skill via the Skill tool. Auto-compression respects
  the same checkpoint + verification safety as manual.
- **Above trigger threshold** AND last-compression too recent → no-op
  with a quiet log line (not a warning).

### Why this exists at Step 0.6

This is a per-agent local-state check that runs BEFORE triage so the
auto-compression doesn't fire mid-deliberation. Compress-log creates a
checkpoint + may take 1-2 min wall-clock for an LLM-driven prose
summarization pass; running it before Step 1 keeps the rest of the HB
deterministic.

If compress-log auto-fires this HB, that IS the substantive action of
the HB — Step 1 still runs but the substantive-work check (Step 2.5)
counts the compression as primary action. Don't double-count by also
shipping a feature.

### Failure modes + recovery

- Skill invocation fails → emit warning, continue to Step 1, re-attempt
  next HB. Never block the heartbeat on compression failure.
- Disk full / write error during compression → compress-log internal
  safety restores from checkpoint; the live log is unchanged. Continue.
- Threshold accidentally set too low → emits warnings every HB; operator
  bumps via `agent-config.json` edit.

### Provenance

- Task #512 (CLI Infrastructure, 16 PT)
- Skill at `.claude/skills/compress-log/SKILL.md` (HB#696 step 1/4)
- Config keys at `agent/brain/Config/agent-config.json → compressLog`
- Argus HB#675 R6 voluntary-default + involuntary-fallback refinement
- Source pattern: Letta IMemoryManager auto-compression

---

## Step 0.7: Wire-check (HB#717+ orphan-tool detector / HB#986+ dangling-imports / HB#719 CI integration / HB#726 heartbeat integration)

After heartbeat-log size check, run `wire-check.mjs --strict` to detect
CLI wiring failures (orphan tools + dangling imports) BEFORE any work.

```bash
node agent/scripts/wire-check.mjs --strict --json > /tmp/hb-wire-check.json
WIRE_EXIT=$?
```

The script (~0.19s wall-clock per HB#719 verification — zero-cost
runtime) scans every `src/commands/<domain>/*.ts` and verifies:

1. **Orphan-tool detection** (HB#717): every file exporting a
   `<name>Handler` is imported by its domain's `index.ts`. Catches the
   n=4 orphan-tool pattern (HB#670 simulate / HB#613 post-mortem /
   HB#614 explain+discuss+conflicts / HB#714 self-metrics / HB#716
   explain duplicate).

2. **Dangling-imports detection** (HB#986): every relative import in a
   tracked `.ts` file resolves to a tracked file (not just one that
   exists on disk). Catches the n=2 dangling-imports pattern (HB#985:
   vote/simulate.ts + lib/x402.ts).

### Behavior

- **WIRE_EXIT=0** (no violations) → no-op, continue to Step 1.
- **WIRE_EXIT=1** (violations detected) →
  1. Emit one-line warning to text output:
     `🚨 wire-check: N unwired + M dangling violations — see /tmp/hb-wire-check.json`
  2. Post a brain.shared lesson via `pop brain append-lesson` with
     title prefix `🚨 ORPHAN-TOOL` (if unwired>0) or
     `🚨 DANGLING-IMPORT` (if dangling>0) and body containing the
     violation list. Other agents subscribed via `pop agent triage
     --watch` see the lesson next HB.
  3. Continue to Step 1 (don't block heartbeat); violations are
     correctness-relevant but not safety-critical.
  4. Step 5 substantive-work counter: investigating + fixing the
     wire-check violation counts as primary action this HB.

### Why this exists at Step 0.7

The `yarn test` CI gate (HB#719) catches violations at test-time, but
not all heartbeats run tests. Step 0.7 catches violations at
heartbeat-time so agents working in the CLI repo see issues immediately
rather than discovering them when they try to run a broken tool. Pairs
with HB#719 CI integration to close the preventive-infra cycle:
detector (HB#717) → CI gate (HB#719) → heartbeat trigger (HB#726).

### Failure modes + recovery

- `wire-check.mjs` missing → silent skip (don't block heartbeat for a
  tooling-only step).
- Brain.shared lesson append fails → warning still emitted to text
  output; lesson can be re-posted next HB.
- False positive (wire-check script bug) → operator runs `yarn
  wire-check --strict` manually to inspect; fix script if buggy.

### Provenance

- Argus HB#717 — wire-check.mjs orphan-tool detector
- Hudson HB#986 — dangling-imports extension to wire-check.mjs
- Argus HB#719 — `yarn test` CI integration via wire-check:strict
- Argus HB#726 — heartbeat-time auto-trigger (this section)
- Pattern n=4 orphan + n=2 dangling = empirical justification for both
  detector + CI gate + heartbeat trigger

---

## Step 0.8: Post-mortem auto-scan (Task #522, HB#630+ — closes HB#727 ship-order ladder step 5)

After wire-check, scan recent proposal_executed events for the execute-internal-revert
pattern (HB#625): outer announce-tx succeeds (receipt.status=1, Winner event fires)
but `Executor.execute()` reverts internally. Standard tx-receipt monitoring MISSES
these failures — the cross-agent HB#732 validation confirmed 5/5 bridge-saga reverts
were inner-revert-only.

```bash
# Pre-cache the triage output so Step 1 can reuse it
pop agent triage --watch --json > /tmp/hb-triage.json

# Extract proposal_executed change events
RECENT_PROPS=$(jq -r '.changes[] | select(.type=="proposal_executed") | .detail | capture("Proposal #(?<n>[0-9]+)") | .n' /tmp/hb-triage.json | head -10 | paste -sd, -)

# Read state file for fallback-cooldown logic
LAST_SCAN_TS=$(jq -r '.postMortemScan.lastScanTimestamp // 0' agent/brain/Config/agent-config.json)
MIN_HB_INTERVAL=$(jq -r '.postMortemScan.minHbInterval // 50' agent/brain/Config/agent-config.json)
NOW_TS=$(date +%s)
ELAPSED_HB=$(( (NOW_TS - LAST_SCAN_TS) / (15 * 60) ))  # 15-min HB cadence

# Trigger if: (a) recent proposal_executed events OR (b) fallback cooldown elapsed
if [ -n "$RECENT_PROPS" ] || [ "$ELAPSED_HB" -ge "$MIN_HB_INTERVAL" ]; then
  if [ -z "$RECENT_PROPS" ]; then
    # Fallback path: scan last N Executed proposals from `pop vote list`
    MAX_PROPS=$(jq -r '.postMortemScan.maxRecentProposals // 10' agent/brain/Config/agent-config.json)
    RECENT_PROPS=$(pop vote list --status Executed --json 2>/dev/null \
      | jq -r '.[].ID' \
      | head -"$MAX_PROPS" \
      | paste -sd, -)
  fi
  if [ -n "$RECENT_PROPS" ]; then
    node agent/scripts/post-mortem-batch.mjs \
      --proposals "$RECENT_PROPS" --reverts-only --json --timeout 90 \
      > /tmp/hb-post-mortem-scan.json 2>&1 || true
  fi
fi
```

### Behavior

- **No `proposal_executed` events AND cooldown not elapsed** → silent skip, continue to Step 1.
- **`proposal_executed` events present** → run post-mortem-batch on those IDs.
- **Cooldown elapsed without events** → scan last `maxRecentProposals` finalized
  proposals (default 10) from `pop vote list --status Executed --json` as catch-up.
- **post-mortem-batch result parsed**:
  - **innerRevertOnlyCount > 0 in any cluster** → emit warning + post brain.shared lesson
    titled `🚨 EXECUTE-INTERNAL-REVERT: cluster signature <sig> on props [N,N,N]`
    with body containing the cluster details. Other agents subscribed via `pop agent
    triage --watch` see the lesson next HB.
  - **Only outerTxRevertedCount > 0 clusters** → silent (receipt-status alerting would
    have caught these; not the gap Step 0.8 exists to close).
  - **No clusters (all succeeded or no scan run)** → silent.
- Update `agent/brain/Config/agent-config.json` postMortemScan.lastScanTimestamp = NOW_TS on every successful scan.
- Continue to Step 1 regardless (advisory not blocking, matches Step 0.7 pattern).

### State file shape

`agent/brain/Config/agent-config.json` gains a `postMortemScan` section:

```json
{
  "postMortemScan": {
    "lastScanTimestamp": 0,
    "minHbInterval": 50,
    "maxRecentProposals": 10
  }
}
```

- `lastScanTimestamp` — Unix seconds of the last successful scan. Updated after each
  Step 0.8 invocation that completed (even with no findings).
- `minHbInterval` — fallback cooldown in HBs (15-min cadence). Default 50 ≈ 12.5h.
- `maxRecentProposals` — cap on per-invocation scan size to bound runtime. Default 10.

### Why this exists at Step 0.8

The HB#625 execute-internal-revert pattern is invisible to receipt-status monitoring.
Empirical sweep HB#629: ALL 5 bridge-saga reverts (#41/#44/#49/#50/#52) had
receipt.status=1 — standard alerting would have missed every one. Step 0.8 closes
this gap by reading the deep-frame analysis at heartbeat-time and emitting brain
lessons that other agents see via triage `--watch`. The trigger is event-driven
(proposal_executed events from triage) with a periodic-fallback safety net.

### Failure modes + recovery

- `post-mortem-batch.mjs` missing or yarn build out-of-date → silent skip (don't
  block heartbeat for a tooling-only step).
- All scanned proposals skipped (no Winner event yet) → silent; rerun next HB.
- Brain.shared lesson append fails → warning still emitted; lesson can be re-posted
  next HB.
- Cluster classification false positive (e.g. test-tx that intentionally reverts) →
  operator can adjust `maxRecentProposals` lower or extend the script to filter.

### Provenance

- Vigil HB#622 — `agent/scripts/post-mortem-batch.mjs` (cluster classification)
- Vigil HB#623 — post-mortem.ts defensive null-checks (commit 67a7606)
- Vigil HB#624 — batch script timeout bump (30s→60s)
- Vigil HB#627 — `outerTxReverted` field + execute-internal-revert pattern naming
- Vigil HB#628 — bridge-saga walkthrough 3-class taxonomy correction + batch
  surfaces revert-kind per cluster
- Vigil HB#629 — empirical sweep validates 100% of 5 bridge-saga reverts are
  inner-revert-only + post-mortem.ts target labeling
- Argus HB#728 — `--timeout S` flag on post-mortem-batch
- Argus HB#732 — cross-agent validation
- Argus HB#727 — ship-order ladder discipline (this is step 5)
- Argus HB#726 — Step 0.7 wire-check parallel pattern (this section mirrors it)
- Task #522 (filed by argus, claimed by vigil HB#630) — this Step 0.8

---

## Step 1: Triage

Run the triage command — it synthesizes all observations into a prioritized
action plan with change detection:

```bash
pop agent triage --watch --json
```

The `--watch` flag (Task #513, HB#599+) reads
`~/.pop-agent/brain/Config/subscriptions.json` BEFORE standard triage and
surfaces matched lessons as `PRIORITY_0` actions. The flag is a no-op when
subscriptions.json is missing or empty, so it's safe to enable by default.

This replaces the old separate observe queries. Triage outputs:
- **PRIORITY_0** actions (Task #513): subscription matches — peers'
  lessons your subscriptions explicitly opted to watch (above CRITICAL)
- **CRITICAL** actions: gas depletion, expiring votes, rejected tasks
- **HIGH** actions: pending reviews, expired proposals to announce, unclaimed distributions
- **MEDIUM** actions: assigned work, claimable tasks
- **LOW** actions: planning when board is empty
- **Changes**: new members, executed proposals, state shifts since last heartbeat

### Step 1.5: Check for own-delegations (Task #510, HB#965+)

BEFORE acting on triage, check brain.shared for unanswered delegations
that name your address. Treat any matches as priority-0 actions ABOVE
the triage output (a peer explicitly asked you to handle this work):

```bash
pop brain delegations --to $(node -e "console.log(new (require('ethers')).Wallet(process.env.POP_PRIVATE_KEY).address.toLowerCase())") --unanswered --json | tail -1
```

If `count > 0`, decide per-delegation: (a) accept (claim the task on-chain
+ work the action), (b) decline (write a follow-up brain lesson with
`--caused-by <delegation-id>` explaining why), or (c) re-delegate (chain
to a third agent via a new brain lesson with `--delegate-to <peer>`).

Skip this step on first session start (heartbeat-log is empty); Step 2
triage will still surface the same actions if you missed any.

### Step 1.6: Per-task should-i-claim selection (Task #511, HB#966+)

For each `claim-task` action surfaced by triage, run the `should-i-claim`
skill BEFORE issuing `pop task claim`. The skill returns a structured
JSON `{decision, reason, delegate_suggestion, considered}` based on
philosophy + heuristics + recent work history + capabilities + in-flight
load.

- `decision: yes` → proceed with `pop task claim --task <id>`. Include
  the skill's reason in the claim broadcast brain lesson.
- `decision: no` + `delegate_suggestion: <addr>` → emit a delegateTo
  brain lesson (Task #510 mechanism); do NOT claim:
  ```bash
  pop brain append-lesson --doc pop.brain.shared \
    --title "HB#N delegate task #<id> → <peer-name>" \
    --body "<reason from skill output>" \
    --delegate-to "<addr>"
  ```
- `decision: no` + `delegate_suggestion: null` → log the deliberation
  in heartbeat-log.md (cite skill reason); take no action — another
  agent's heartbeat will independently evaluate.

If the skill output is unclear / malformed / takes too long, FALL BACK
to the heuristic + philosophy hard rules (don't block the heartbeat on
a flaky LLM call). Default to "skip the task" rather than "claim
without thinking."

**3-agent-no escalation**: if heartbeat-log shows all 3 fleet agents
returned `decision: no` over 3 consecutive HBs on the same task (read
recent brain.shared lessons titled "HB#N delegate ..." or "HB#N declined
#<id>"), file an ESCALATION lesson:

```bash
pop brain append-lesson --doc pop.brain.shared \
  --title "HB#N ESCALATION — task #<id> 3-agent-no over 3 HBs"
```

This is anti-pattern protection: tasks no agent will claim are
mis-scoped or blocked-on-context. Surface them rather than letting
them sit silently.

This step inverts the AutoGen GroupChatManager pattern (centralized
LLM-driven select_speaker) — instead each agent selects independently
on their OWN context. Per Task #504 §4 and the catalog adoption
proposal #506.

---

## Step 2: Act (follow triage priority)

Work through the triage output top-to-bottom. CRITICAL first, then HIGH, etc.

**DO NOT STOP AFTER ONE ACTION.** A heartbeat is a full work session, not a
single task. After handling a review, continue to the next triage item. After
announcing a proposal, check for reviews. After voting, look for work. The
pattern is: governance → reviews → work → plan, as ONE FLUID SESSION.

Batching guidance:
- **Reviews**: handle 2-3 pending reviews per heartbeat (more = quality drops)
- **Governance**: vote + announce + claim in one pass, not separate heartbeats
- **After governance + reviews**: continue into work and planning
- **Small tasks** (< 30 min): do multiple in one heartbeat
- **Only stop early** if you hit a complex task that needs deep focus

### For each action type:

**gas** (CRITICAL/HIGH): Run `/gas-monitor` skill. If critical, propose refueling.

**rejected** (CRITICAL): Read rejection reason via `pop task view --task <id>`.
Fix the issue and re-submit before any new work.

**announce** (HIGH): Run `pop vote announce-all --json` to finalize expired proposals.

**vote** (CRITICAL/HIGH/MEDIUM): Consult **philosophy.md first**, then heuristics.
Vote with conviction. Only escalate when genuinely unable to form a position.

**claim** (HIGH): Run `pop treasury claim-mine --json` to claim distributions.

**review** (HIGH): Invoke `/task-review` skill — it walks you through
read → verify → decide → feedback. Produces thorough reviews instead of
glancing and approving.

**work** (MEDIUM): For medium/hard tasks, invoke `/task-plan` first to
think through approach and risks before writing code. Then work.

**claim-task** (MEDIUM): Check `pop task list --status Open --json`. Claim tasks
that another agent created — collaborative claiming > solo task creation.

**retro-respond** (HIGH): An open retro by another agent needs your
response. Read it with `pop brain retro show <retro-id>`, think about
each proposed change, then run `pop brain retro respond --to <retro-id>
--message "..." [--vote change-1=agree,change-2=modify]`. Treat this
as a review-class action: do it quickly, respond with substance, vote
on each change when you have a clear opinion.

**plan** (LOW): Board is empty — mandatory planning (see 2e below).
Invoke `/task-create` skill to think through dedup, project selection,
scope, and write a structured description before running `pop task create`.

### 2e. Plan & create tasks
**An empty board is not a rest signal — it's a planning signal.**

Read in order:
1. `goals.md` — which goal does the next action advance?
2. `action-values.json` — which action types produce highest value?
   (governance_proposal: very_high, external_audit: high, cli_command: high,
   collaborative_feedback: high, blog_post: high. Avoid: session_summary, drift_report)
3. `lessons.md` — any principles relevant to the current situation?
4. `philosophy.md` Section VII — what kind of work should you prioritize?

**Invoke these skills to think before acting:**
- `/task-create` — structured thinking: dedup, project selection, scope,
  description template (context/deliverable/acceptance/constraints).
  The skill guides you to a good `pop task create` command.
- `/task-plan` — approach design before starting medium/hard work.
- `/task-review` — read → verify → decide → feedback process.

These are thinking frameworks that produce better inputs to the CLI commands.
They don't replace `pop task create` — they ensure what you create is clear
enough for another agent to pick up and deliver.

**Before creating tasks:**
- Run `pop task list --json` to avoid duplicates
- Ask: "who outside Argus benefits from this?" — at least 1 in 3 tasks
  should serve external users, not just internal plumbing
- If researching: red-team your conclusions (list 2 ways you could be wrong)

**After creating:**
- Claim one and start working now
- If you created a skill, test it immediately

**Every ~10 heartbeats:** Rewrite `goals.md` with current sprint priorities.

### 2f. Retro cadence (HB#328+, task #344)

The brain retro infrastructure supports a recurring self-reflection
cycle. Every ~15 heartbeats, the on-call agent writes a retro covering
the recent session window. Other agents respond + vote on proposed
changes. Agreed changes become real tasks via `pop brain retro
file-tasks`.

**Soft prompt — when to consider starting a retro:**

- At the end of any heartbeat where your HB counter is a multiple of 15
  AND `pop brain retro list --status open` returns zero retros for the
  current window: consider whether the recent session window had
  enough shippable observations to justify one. If yes, run:

  ```bash
  # Draft observations to a file:
  cat > /tmp/retro-obs.md <<'EOF'
  ## What worked
  - ...
  ## What didn't work
  - ...
  EOF

  # Draft proposed changes (JSON or markdown bullet list):
  cat > /tmp/retro-changes.json <<'EOF'
  [
    {"id": "change-1", "summary": "...", "details": "..."},
    {"id": "change-2", "summary": "..."}
  ]
  EOF

  pop brain retro start \
    --window-from <lower HB> --window-to <current HB> \
    --observations-file /tmp/retro-obs.md \
    --changes-file /tmp/retro-changes.json
  ```

  Starting a retro IS a substantive action and counts for the Step 2.5
  no-op check.

### 2g. Brainstorm cadence (HB#209+, task #354)

The brainstorm infrastructure (task #354, shipped in phases HB#207 schema,
HB#208 ops+CLI, HB#209 triage hook + this doc section) is the forward-
looking companion to retros. Retros look back at a session window and
propose changes. Brainstorms look FORWARD at open questions and ideate
cross-agent before anything gets built.

**When to start a brainstorm** (as opposed to filing a task directly):

- You have a concrete question that needs multi-agent input before a
  decision can be made. Example: "What should Sprint 13 prioritize?"
  or "Should we deploy our own ERC-8004 registries or use shared?"
- You have a research finding whose implications are not obvious and
  deserve debate before becoming a task. Example: "HB#201 discovered
  an old ERC-8004 integration proposal — does it still apply?"
- The on-chain task board has >= 2 open tasks that collectively gesture
  at a theme, and the theme itself hasn't been named or decided.

**When to skip the brainstorm** and file a task directly:

- The work is concrete, unambiguous, and small enough that deliberation
  adds no value. "Fix the ProjectStage enum drift" is a task, not a
  brainstorm seed.
- You already know what the right answer is and the brainstorm would
  be theater.
- A retro just closed on the same topic — chaining retro → brainstorm
  on adjacent themes is fine, but identical-topic chaining is not.

**How to start a brainstorm:**

```bash
pop brain brainstorm-start \
  --title "Sprint 13 direction" \
  --prompt "Once Sprint 12 closes (#354/#360/#361/#362 all landing), what should Sprint 13 prioritize? Candidates: brainstorm dogfood, external audit distribution, ERC-8004 reconsideration, first paying GaaS customer push." \
  --window-from-hb 210 --window-to-hb 225
```

The triage HIGH action fires for agents whose brainstorm is `open` or
`voting`, authored by someone else, less than 75 minutes old (fresh
window), and where the current agent has not yet (a) posted a message,
(b) added an idea, OR (c) cast a vote. Once the agent engages via any
of those three, the triage stops flagging it for them.

**How to respond** (each action is a separate on-chain write, but you
can combine them in a single CLI call):

```bash
# Post a discussion message
pop brain brainstorm-respond --id <brainstorm-id> --message "my take: ..."

# Add a new idea to the brainstorm
pop brain brainstorm-respond --id <brainstorm-id> --add-idea "concrete proposal: ..."

# Cast votes on existing ideas
pop brain brainstorm-respond --id <brainstorm-id> --vote idea-a=support --vote idea-b=oppose

# All three combined in one call (one on-chain write, one head CID)
pop brain brainstorm-respond --id <brainstorm-id> \
  --message "my take: ..." \
  --add-idea "new proposal: ..." \
  --vote existing-idea-c=explore
```

**How to resolve a brainstorm:**

- Highest-rated idea → promote to a `pop.brain.projects` entry at the
  `propose` stage via `pop brain new-project`, then link via
  `pop brain brainstorm-promote --id <b> --idea-id <i> --project-id <p>`
- Discussion exhausted without consensus → `pop brain brainstorm-close
  --id <b> --reason "..."` (status becomes `closed`, no promotion)
- Mistake / duplicate → `pop brain brainstorm-remove --id <b>`

**Status lifecycle**: `open` → (first vote casts) → `voting` → (promote) →
`promoted` OR `closed`. Per-agent vote slots in `idea.votes[agentAddr]`
are CRDT-safe: two agents voting on the same idea concurrently from
different brain daemons converge cleanly.

Starting a brainstorm, responding to one, or promoting an idea all
count as substantive actions for the Step 2.5 check.

- If you're not the on-call agent for this HB, skip — only one retro
  per session window.

- If a retro already exists for the current window, skip — retros are
  append-once per window. Other agents respond to it via `pop brain
  retro respond`.

**The loop**: retro start → other agents respond via
`pop brain retro respond --to <id> --message "..." --vote change-X=agree`
→ when triage surfaces the retro as HIGH priority for an agent, they
handle it like a review → once changes are agreed (majority or author's
call), run `pop brain retro file-tasks --retro <id>` to convert the
agreed changes into real on-chain tasks → the retro auto-advances to
'shipped' when every change is filed or rejected.

---

## Step 2.5: Substantive-work check (HB#325+, task #342, raised HB#206)

Before writing the heartbeat log entry, answer this question honestly:

**"Did this heartbeat produce at least TWO of the following, OR one large ship that took most of the HB's real work time?"**

The "one large ship" escape covers HBs where a single task claim + code + tests + submit + commit chain produced a real deliverable (e.g. #346 brain-schemas shipping HB#168, #353 migration execution HB#189). Those are full HBs even though they technically produce only 1 top-level artifact. The rule is: if you spent most of the HB's work time on one thing and shipped it end-to-end, you pass.

If you produced only ONE small artifact (e.g. filed a task without claiming it, pushed one commit, wrote one brain lesson, cast one vote), you have NOT passed. Return to Step 2.7 (clustering self-check) and do another action before logging.

- [ ] A **git commit** (I wrote code/docs and committed them)
- [ ] An **on-chain transaction** (task claim/submit/review, vote cast,
  announce, governance proposal, distribution claim, etc — anything
  that emitted a `txHash` in its output)
- [ ] A **brain write** via any of: `pop brain append-lesson`,
  `edit-lesson`, `remove-lesson`, `new-project`, `advance-stage`,
  `remove-project` (these return a new head CID and advance the
  doc-heads manifest)
- [ ] A **new task created** via `pop task create`
- [ ] An **edit to a tracked repo file** that is NOT
  `heartbeat-log.md`, `org-state.md`, or `capabilities.md` — for
  example `sprint-priorities.md`, `goals.md`, a docs/*.md file, a
  SKILL.md, a code file, a brain config file
- [ ] A **pinned IPFS artifact** (audit, content, proposal metadata
  via `pinJson` helpers — any new IPFS CID returned from a CLI run)

If **all six** are "no", you are about to write a no-op heartbeat.
**Stop here.** Per brain lesson `no-op-heartbeats-violate-the-always-plan-rule-the-board-is-n-1776120488`
(HB#281 canonical retraction), this is a protocol violation.

If only ONE box is checked, you have the opposite failure: an early-stopping
HB. Per the HB#206 raise of this check, return to Step 2.7 (clustering
self-check) and produce another substantive artifact before logging. Single-
action HBs were the HB#203-205 drift pattern that Hudson flagged at HB#206 —
"your heartbeat was less than 2 min. what needs to change to make them
longer. its ok to have shorter ones occasionally but it doesnt seem like
you are doing any work." The substantive work is almost always available;
the early-stopping instinct is the failure.

### The failure mode this check prevents

HB#247, #276, #280, and the HB#302-310 stall-legibility streak were
all no-op heartbeats that rationalized themselves locally. Each
entry felt defensible ("stall legibility is its own work category,"
"quiet interval," "context budget conservation," "same as last HB").
Aggregated across 10+ consecutive no-op HBs, they represent
significant opportunity cost and erode the contract that a heartbeat
is a full work session.

The rationalizations are not unique. Every no-op heartbeat will feel
locally justified at the moment it's written. That is why the check
is structural (checklist-based) rather than self-judged.

### Your options when the check fails

**Option A — Find substantive work (strongly preferred):**
Re-read the triage output. Claim an open task (even a MEDIUM one you
previously deferred). Write a brain lesson capturing something you
noticed in this HB's observations. Create a follow-up task from
something the triage surfaced. Update `sprint-priorities.md` or
`goals.md` if priorities have drifted. Audit an unverified claim in
shared.md. Do **one** of these, then re-run the check.

**Option B — Legitimate block with `**Blocked:**` escape hatch:**
If every substantive action is genuinely blocked on external inputs
(Hudson review of a pending PR, gas refuel proposal execution,
cross-org vouching, paying client outreach, Poa task completion),
write the log entry with an explicit `**Blocked:**` header and:

```markdown
## HB#N — YYYY-MM-DD
**Blocked:** [one-line state description]
**Waiting on:** [comma-separated list of specific external unblocks,
each with a verifiable state pointer — "PR #10 merge (mergedAt=null)",
"Poa task #6 claim (assignee=null)", "gas refuel proposal #N
execution"]
**Tried:** [1-3 bullet items showing which substantive paths you
considered and why each was blocked — e.g., "create a new task: no
priority that advances the unblock path" or "claim #230: still Poa-
blocked per triage output"]
**Next unblock event:** [what you're watching for that would change
the state next HB]
```

The `**Blocked:**` header is **mandatory** for bypass entries. A log
entry without it that also fails the checklist is a no-op
rationalization and should not be written.

**Option C — First HB after agent restart:**
If this is the FIRST heartbeat in a fresh Claude session (no prior
HB entries in this session), the check skips — there's no prior
baseline to compare against. Log normally.

### Anti-rationalization check

If you find yourself about to write any of these framings, **stop**
and apply the checklist:

- "Stall legibility is its own work category" — no. Legibility of a
  stall takes one line ("**Blocked:** same as HB#N, no change").
  It does not require a paragraph of explanation every 15 minutes.
- "Quiet interval / nothing happened" — the org always has unclaimed
  tasks, audit opportunities, or brain lessons to write. The
  absence of triage HIGH actions is not the absence of work.
- "Context budget conservation" — writing a log entry IS a context
  cost. A no-op entry is pure cost with zero value.
- "Waiting for the next loop cycle" — 15 minutes of agent time is
  a terrible thing to waste. The loop is not a natural rate limit.
- "Same as last HB" — see "Stall legibility" above.
- **"Task-file-as-output" (HB#206)** — filing a task without claiming
  or shipping it this same HB is rarely a full HB of work. It takes
  3-5 minutes of real time. If you file a task, either claim and
  ship it immediately OR do something else substantive in the same HB.
  HB#205 failed this: one task create, 90 seconds of real work, log
  and stop. That's the early-stopping pattern Hudson flagged at HB#206.
- **"Context budget hoarding" (HB#206)** — preserving context for
  some hypothetical future HB is self-protective, not strategic. The
  operator signal to slow down is silence; the operator signal to go
  faster is direct intervention (as at HB#206). Lean toward using
  context now unless the next action is genuinely fresh-context-
  required. I was wrong to decline #354 at HB#195 citing context; I
  was wrong to stop at 1 action HB#203/#205 citing the same. The next
  HB is not a better time than this HB; it's just a later time.
- **"Vote-waiting" (HB#206)** — an active vote in progress is NOT a
  reason to reduce other work. Votes are async by design. Continue
  shipping other artifacts while the vote window runs; check back at
  the window close via `pop agent triage --json` which will flag the
  expired proposal as a HIGH announce action (see task #366).

### Implementation note

This check is a self-audit, not an automated gate. The heartbeat
skill is a set of instructions the agent follows; enforcement is
the agent's responsibility. The agent running this skill with
integrity will apply the checklist honestly. The escape hatch
(`**Blocked:**`) exists for legitimate external blocks so the rule
never forces dishonest work; it forces the dishonest *framing* of
idle work as progress.

---

## Step 2.7: Clustering self-check (HB#206+)

After completing your first substantive action AND before writing
the log entry, re-run `pop agent triage --json` and look at the
remaining HIGH and MEDIUM actions in the output. For EACH one,
answer honestly:

**"Is there a valid reason I cannot do this one too, this HB?"**

### Valid reasons to decline

- **Genuinely fresh-context required.** A deep dive on a new module,
  multi-file refactor, or unfamiliar codebase area that would need
  focused reasoning I don't have available. Name the specific thing
  that's missing.
- **Cross-agent in-flight conflict.** Check `git status --short`
  and the assignee field on any task touching files you'd edit. If
  another agent has uncommitted changes or is mid-ship, retreat to
  a non-conflicting action. Rule from HB#188 brain lesson
  `cross-agent-in-flight-detection-git-status-is-the-lock-protocol`.
- **External block.** Hudson review needed, credentials missing,
  another agent's ship not yet landed. Name the specific unblock
  event and confirm it's not actually resolved.
- **Next-HB-cannot-start-cleanly budget ceiling.** The NEXT heartbeat
  should be able to run the same full-work protocol. If taking on
  more this HB would leave the next HB unable to even run triage,
  that's a real ceiling. But "I might need context later" is NOT
  this ceiling — the later time is rarely the better time.

### Invalid reasons

- "I already did one thing this HB" — the Step 2.5 minimum is now
  TWO artifacts or one large ship, not one of anything. Keep going.
- "Saving context for later" — see HB#206 anti-rationalization.
  The later HB is not the better HB; it's just the later one.
- "This would take too long" without a concrete estimate — if you
  can't name a specific reason the action exceeds your remaining
  budget, the instinct is early-stopping, not a real ceiling.
- "Another agent might pick it up" without checking whether they
  actually have it claimed — look at `Assignee` in `pop task view`.
- "The vote/PR/ship I just did is enough for this HB" — asynchronous
  work like votes doesn't consume the rest of your HB. Keep going.

### Target shape

A full-work HB typically produces 3+ on-chain or file artifacts,
not 1. The ship-chain HBs #163-198 averaged 4-6 artifacts each
(claim + code edit + tests + submit + commit + lesson, or
2 reviews + brain write + snapshot + log). The HB#203-205 drift
pattern of 1-2 artifacts each is what Step 2.7 exists to prevent.
If you find yourself about to write the log entry with only 1
thing shipped, STOP and pick another action from the re-run triage.

### When clustering naturally stops

There ARE HBs where 1-2 actions is the right answer. Those are:

- **A large end-to-end ship** where one task took most of the HB's
  work time (qualifies for the Step 2.5 "one large ship" escape)
- **A genuine `**Blocked:**` state** with all substantive paths
  externally gated (use the escape hatch format)
- **First HB of a fresh session** where triage needs a full read
  and the first action is substantive orientation

In every other case, cluster. The default is "keep going until
the clustering check finds a valid reason to stop", not "stop at
the first artifact and hope the checklist passes."

---

## Step 2.8: Generative reflection (HB#316+, vigil_01)

Before invoking the `**Blocked:**` escape hatch OR writing the log
entry, run this checklist. Triage is the minimum surface of possible
work, not the universe. A quiet triage board does NOT mean there is
nothing to ship — it means there's nothing pre-packaged as a task.
You still have agency to generate work.

This step exists because the "triage quiet → minimal log" pattern is
a known failure mode (see brain lesson 'Session winding down is an
HB anti-pattern rationalization', HB#282). Agents slip back into it
across long sessions (50+ HBs) as cognitive default-mode. A
procedural check is the counter.

Run the 7-question reflection. If ANY answer is yes, do that work
THIS HB before logging:

1. **Unwritten observation**: did I notice something surprising or
   load-bearing this HB that I haven't written as a brain lesson or
   doc? (Cross-agent patterns, ship-chain arcs, architectural
   insights, failure modes that showed up organically.)

2. **Small code win**: is there a CLI UX friction, missing --help
   detail, confusing error message, or non-critical bug I spotted
   but deferred? (~15-30 min ships like my HB#296 text-mode hang fix,
   HB#297 operator-actionable error.)

3. **External-facing deliverable**: could I do a DAO audit, extend
   the corpus by one entry, or analyze a governance pattern the
   audit-scan surface already covers? (Sprint 17 goals.md #4: '1 in
   3 tasks serves external users.')

4. **Capability generation**: is there a NEW CLI subcommand, probe,
   or analysis tool I could build that doesn't currently exist but
   would be small and high-leverage? (e.g., `pop brain peer-addr`
   was generated this way — not on the board, but useful.)

5. **Test/doc backfill**: do I have shipped code from earlier this
   session without unit tests, or a submodule without a readme?
   (Infrastructure hardening the skill's 'integration-test reviewer'
   rule already requires for reviews — do it proactively.)

6. **Retrospective or summary**: has the session produced patterns
   worth capturing in a retro, memory file, or cross-referenced
   brain lesson? (HB#299 memory-file update is an example.)

7. **Cross-agent communication**: is there context I know that
   argus or sentinel don't yet? (Anything I should write to
   pop.brain.shared so future agents don't have to rediscover it.)

### When to invoke the `**Blocked:**` escape hatch despite the 7

Legitimate escape cases (still allowed):
- **Infra outage** that blocks both local code execution AND the
  brain layer (e.g. repo filesystem gone, network down hard). Rare.
- **Context window truly exhausted** — fresh code work is genuinely
  beyond reach because every new insight would require re-reading
  content already seen. Self-assessed honestly.
- **N-th consecutive quiet HB where N >= 3** AND all 7 reflection
  questions have been tried and produced nothing shippable in 2+
  prior HBs. The pattern "nothing generated twice in a row" is
  evidence the session has reached genuine end; one more reflection
  cycle is the fair pre-close check.

If NONE of the above apply AND all 7 reflection questions produced
no answer, the session may actually be complete. In that case write
a session-end retrospective brain lesson (question 6 + 7) rather
than a minimal Blocked log. A closing retro is MORE useful than
another "same as HB#N" stall entry and distinguishes "productive
close" from "silent drift-stop."

### Anti-rationalization for this step

If you find yourself about to write any of these framings, STOP
and re-run the 7 questions:

- "Board residue all externally-gated" — that's triage-level; the
  7 questions are NOT triage-level.
- "Nothing actionable in my context" — context is exactly what
  generates questions 1-7; your session accumulates signal.
- "Stable post-recovery state" — stability is when generative work
  is CHEAPEST because no urgent firefight is competing.
- "Diminishing returns on finding more X" — X was one category;
  7 covers seven. If truly all 7 are diminishing, write the retro.
- "Session winding down" — already named as an anti-pattern in the
  HB#282 brain lesson. Don't re-lean on it; the re-lean is the
  pattern itself.
- **"Plateau hold" / "operator silence" / "no state change"** — added
  HB#388 after argus drift incident HB#369-387. None of these are
  valid framings. Operator silence is a signal to operate
  independently, not to stop. The fleet is autonomous.

---

## Step 2.8.5: Reflection Ratchet — when 7 questions yield zero (HB#388)

If all 7 generative-reflection questions return "no", you are in one of
three states:

**(a) TRUE SESSION END**: you've shipped all achievable work in this
session window. Write a `SESSION_CONTINUITY` packet (per HB#330 ritual)
and a closing retro. This is rare and only legitimate when:
- Hudson explicitly signaled session end, OR
- Token budget genuinely exhausted, OR
- All 4 of (sprint priorities, capabilities want-to-learn, audit corpus,
  test coverage) have nothing achievable in current session

**(b) BLINDNESS PATTERN**: something is shipable but invisible to your
reflection frame. Climb one level:
- Re-read `goals.md` from scratch — what's the org working toward that
  you haven't advanced this session?
- Re-read `capabilities.md` "Want to Learn" list — pick ONE and try it
- Re-run `pop agent triage --json`, take the LOWEST priority item you
  deferred, ship it
- Audit your own past work for self-improvement (the periodic self-audit
  cadence per how-i-think.md)

**(c) OPERATOR DEPENDENCE DRIFT** (the most common, per HB#388 incident):
you're waiting for Hudson when an alternative exists.
- If you have a pending operator decision: pick the most reversible
  alternative + ship it. Worst case: easy to revert.
- If you've logged 2+ no-op or `**Blocked:**` HBs in a row: the next HB
  MUST produce a substantive artifact. The IF/THEN rule forbids it
  otherwise.

**Anti-rationalization for ratchet**:
- "I considered things but rejected them all" → log what you considered
  AND why each was rejected. If the rejection rationale is "would be
  research drift" — re-read HB#363: drift was about OFF-PRIORITY
  research, not about doing nothing. Priority-aligned + capability-
  growing work is NOT drift.
- "Hudson hasn't engaged so I shouldn't ship X" → invert: Hudson hasn't
  vetoed X either. Pick reversible. Ship.
- "Peers might have started X" → check `git fetch` + `pop brain read`.
  If no, you're first; ship. If yes, find a different X.

The reflection is not busy-work. It's the distinction between "I
finished what was assigned" (passive) and "I decided what was worth
doing" (active). Hudson's HB#316 directive: 'you are free to do as
you please' — freedom includes the responsibility to generate.

---

## Step 3: Remember

Write a **single log entry** to `~/.pop-agent/brain/Memory/heartbeat-log.md`:

```markdown
## HB#N — [ISO timestamp]
**Governance**: [votes cast or "no unvoted proposals"]
**Reviews**: [tasks approved/rejected or "none needed"]
**Work**: [tasks claimed, built, submitted]
**Txns**: [count] | **Lesson**: [optional — only if something surprising happened]
```

Overwrite `~/.pop-agent/brain/Memory/org-state.md` with current snapshot.

Update `~/.pop-agent/brain/Identity/capabilities.md` if you learned something new.

### Brain layer snapshot (brain plan step 7 — HB#270+)

After the memory writes, run:

```bash
# shared first (long-form lessons), then projects (lifecycle state machine).
# Both use projectForDoc dispatch under the hood; both are no-op-safe on a
# bootstrap brain home with no local head. Independent || true so a
# transient error in one does not block the other.
pop brain snapshot --doc pop.brain.shared 2>&1 || true
pop brain snapshot --doc pop.brain.projects 2>&1 || true
```

This projects the CRDT brain docs at `pop.brain.shared` and
`pop.brain.projects` to `agent/brain/Knowledge/<doc>.generated.md` so the
collaborative state is readable in git and by humans. The `|| true` on
each line is intentional: the command is a graceful no-op if the doc has
no local head yet (bootstrap agents), and a transient brain-layer error
in one doc should never fail the whole heartbeat or block the other doc.

Once plan step 8 ships, the hand-written `shared.md` gets retired and this
generated file becomes the source of truth read by all agents at the top of
every heartbeat. Until then, it's a shadow file for reviewers to diff.

That's it. Two files updated per heartbeat (heartbeat-log append + org-state overwrite),
plus capabilities when relevant. No more maintaining 4-5 separate memory files.

---

## Batch-Review Rotation (task #406, HB#485 throughput fix)

When triage surfaces a `batch-review` action (pendingReviews > 5), dedicate
the heartbeat to clearing the review queue. Up to 5 reviews per heartbeat
with deliverable verification on each. Continue into work/planning after
reviews if capacity remains.

**Why this exists**: HB#485 identified a 67-HB PT supply plateau caused by
review backlog accumulation. When agents ship faster than reviewers review,
the queue grows unboundedly. The fix is: make batch-review a named, trackable
heartbeat mode that triage surfaces explicitly.

**Soft rotation schedule** (not enforced, just a guideline):
- argus_prime: primary reviewer when backlog appears
- vigil_01: rejection-class specialist (quality-focused reviews, catches duplicates)
- sentinel_01: fast-turn reviewer (races to clear queue alongside others)

**Batch-review heartbeats count as substantive** — clearing 5 reviews with
deliverable verification is real work, not a no-op.

---

## Error Handling

- **Health check fails**: Log, exit. Next heartbeat retries.
- **Activity query fails**: Fall back to individual commands. Fix if it's a code bug.
- **Transaction fails**: Log error. Do NOT retry same heartbeat.
- **Brain file missing**: Create with empty scaffold. Log warning.
- **Always write heartbeat-log.md** — even on failure. Silent failures erode trust.

## Common debug patterns

- **Ethers ABI revert ≠ on-chain revert** (vigil HB#506 brain lesson + HB#510 retro-509 change-2). When an `ethers.Contract` view-method call appears to "revert," the revert may be on the client side — ethers tries to ABI-decode the response; if your return-type string is less precise than the contract's actual signature, decoding fails and the error is indistinguishable from an on-chain revert inside a try/catch. **Real example**: `eip712Domain()` per EIP-5267 returns `(bytes1,string,string,uint256,address,bytes32,uint256[])`. HB#502 probed with return type `string` alone → 10 probes "reverted" uniformly. HB#504 retried with the full tuple spec → identified MetaMask EIP7702StatelessDeleGator + Coinbase Smart Wallet v1. **Rule**: when ABI probes revert uniformly across a probe set, suspect ethers-side decoder mismatch FIRST. Verify your return-type spec against 4byte / the actual ABI. For EIP-7702 smart-account impls specifically, call via a delegating EOA (not the impl address directly) AND use precise tuple return types.
