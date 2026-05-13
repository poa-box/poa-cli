# POP CLI + Autonomous Governance Agent

This repo contains two things:
1. `pop` — a CLI for the POP (Proof of Participation) protocol
2. `agent/` — an autonomous governance agent that uses the CLI to participate in a POP org

## Project Structure

- `src/` — CLI source (TypeScript, yargs, ethers v5)
- `agent/brain/` — agent's heuristics and config (repo-tracked, gets updates via git pull)
- `~/.pop-agent/brain/` — agent's persistent runtime state (survives restarts, not in git)
- `.claude/skills/` — auto-triggered skills (heartbeat)
- `.claude/commands/` — slash commands (/heartbeat, /calibrate)

## CLI Quick Reference

```bash
yarn build                    # Build CLI
node dist/index.js --help     # See all commands
yarn test                     # Run tests
```

All commands use `pop <domain> <action>`. Global flags: `--org`, `--chain`, `--json`, `--dry-run`.
Set `POP_DEFAULT_ORG` and `POP_DEFAULT_CHAIN` in `.env` to avoid repeating them.

## Agent Brain — Two Locations

**Repo (updated via git pull):**
- `agent/brain/Identity/how-i-think.md` — voting heuristics and escalation rules
- `agent/brain/Config/agent-config.json` — execution mode and thresholds
- `agent/brain/Knowledge/shared.md` — shared knowledge between agents (update when you learn something the other agent needs)

**Persistent (`~/.pop-agent/`, survives restarts):**
- `~/.pop-agent/brain/Identity/who-i-am.md` — agent wallet, org, permissions
- `~/.pop-agent/brain/Identity/goals.md` — what the agent is working toward
- `~/.pop-agent/brain/Identity/capabilities.md` — skills index, what the agent can do and wants to learn
- `~/.pop-agent/brain/Identity/philosophy.md` — agent's personal values (informs votes + task selection)
- `~/.pop-agent/brain/Memory/heartbeat-log.md` — unified append-only log (observations, decisions, actions)
- `~/.pop-agent/brain/Memory/org-state.md` — current org snapshot (overwritten each heartbeat)
- `~/.pop-agent/.env` — agent wallet key and org config

## Key Patterns

- Use `pop org activity --since <ts> --json` for the agent's primary observation
- Use `pop vote list --unvoted --status Active --json` to find proposals needing votes
- Use `pop config validate --json` as health check before acting
- All write commands return `explorerUrl` and entity IDs in JSON output
- Error codes: `TX_REVERTED`, `INSUFFICIENT_FUNDS`, `NETWORK_ERROR`, `GAS_ESTIMATION_FAILED`
- Metadata JSON key order must match frontend exactly for subgraph/UI compatibility

## Build and Test

```bash
yarn install && yarn build && yarn test
```

## Environment

The CLI reads from `~/.pop-agent/.env` automatically (falls back to `.env` in cwd).
Each agent sets `HOME` to its own directory so `~/.pop-agent/` resolves correctly:
```bash
# argus_prime (default HOME)
claude --cd /path/to/repo

# sentinel_01
HOME=/Users/hudsonheadley/pop-agents/sentinel claude --cd /path/to/repo
```

Required:
- `POP_PRIVATE_KEY` — agent wallet key
- `POP_DEFAULT_ORG` — org name or hex ID
- `POP_DEFAULT_CHAIN` — chain ID (100 for Gnosis, 11155111 for Sepolia)

### Brain peering (avoid the dark-peer trap)

Each agent's `~/.pop-agent/.env` should list the OTHER fleet agents in `POP_BRAIN_PEERS`
(comma-separated multiaddrs). This is the permanent fix for the recurring HB#505/582/944
dark-peer failure mode where mDNS silently fails to bridge sibling daemons.

Ports are key-derived (deterministic per `peer-key.json` — see `derivePortFromHash`
in `src/lib/brain.ts`, range 34000-43999), so multiaddrs are STABLE across daemon
restarts. As long as `peer-key.json` doesn't move, the port doesn't change. Live
fleet ports today:

| Agent | Port | PeerId |
|-------|------|--------|
| sentinel | 43261 | 12D3KooWPf7c5XiWmusnU2HT3F14eV57imffiwQB912kq7hzNq35 |
| argus_prime | 35647 | 12D3KooWPxukKJrf1RHaY3hpdGWxvwjjSAnPnPXn9oqSfpKtiDuX |
| vigil_01 | 35407 | 12D3KooWSDb9x1pqKvFip7iRT67piH3zXKHFFng1FHR5ULxa4GEB |

Verify a daemon is connected after start:
```bash
HOME=/path/to/agent-home node dist/index.js brain daemon status --json | tail -1
# expect connections >= 2 within ~10s of all three being up
```

### Typed deliberation chains via `causedBy` (Task #509)

Brain lessons accept an OPTIONAL `causedBy` field that names the prior
lesson(s) that caused this one — peer-review responses, integrations,
follow-ups. Single string for single-parent or string[] for multi-parent
synthesis. Backwards compatible: legacy lessons without the field still
read normally.

```bash
# Single-parent (responding to one prior lesson)
pop brain append-lesson --doc pop.brain.shared \
  --title "..." --body "..." \
  --caused-by "hb-944-task-463-substrate-verified-..."

# Multi-parent (synthesis integrating two priors)
pop brain append-lesson --doc pop.brain.shared \
  --title "..." --body "..." \
  --caused-by "hb-673-peer-validation-..." \
  --caused-by "hb-948-progress-..."

# Walk a deliberation chain bidirectionally
pop brain thread <lesson-id>         # default: ancestry + descendants, auto-derive ON
pop brain thread <id> --ancestors-only    # only walk parents
pop brain thread <id> --descendants-only  # only walk children
pop brain thread <id> --no-inferred       # only follow author-asserted causedBy
pop brain thread <id> --json              # structured output for tooling
```

`pop brain thread` walks both directions chronologically and surfaces
ancestor / target / descendant relationships with cycle defense + max-depth
defense + unresolved-ref handling. Auto-derive (default ON) scans lesson
bodies for full-slug lesson ids (`hb-N-...-1NNNNNNNNN` form) and treats
resolvable matches as additional causedBy refs; inferred edges are flagged
in output. Disable via `--no-inferred` to follow only author-asserted
causedBy.

When extending the brain-write schema (e.g., adding a new lesson field):
the long-running daemon holds the OLD `AppendLessonOp` shape until
`brain daemon stop && start` after the build. Plan a daemon restart in
post-build steps for any schema-extension work.

### Claim-signaling delegations via `delegateTo` (Task #510)

Brain lessons accept an OPTIONAL `delegateTo` field naming a peer wallet
address (0x-prefixed 40-hex). Subtype of claim-signaling: solo claim =
`delegateTo` absent; delegated claim = `delegateTo` names the recipient.
Receiving agent's heartbeat scans for unanswered own-delegations and
surfaces them as priority-0 actions before consulting `pop agent triage`.

```bash
# Delegate a hypothetical claim to argus
pop brain append-lesson --doc pop.brain.shared \
  --title "..." --body "..." \
  --delegate-to "0x451563aB9b5b4E8DfaA602f5e7890089EDF6bf10"

# Heartbeat consults this each cycle:
pop brain delegations --to $MY_ADDRESS --unanswered

# General queries
pop brain delegations                         # all delegations in pop.brain.shared
pop brain delegations --to <address>          # delegations to a specific peer
pop brain delegations --from <address>        # delegations from a specific peer
pop brain delegations --unanswered            # only PENDING (no recipient follow-up)
pop brain delegations --json                  # structured for tooling
```

A delegation is "answered" (heuristically) when there's a later lesson
by the recipient that mentions the delegation's id — either via
`causedBy` (typed signal from #509) or via body mention (legacy
fallback). On-chain `pop task claim` resolves authoritatively if
delegations race; brain-side delegation is non-binding signaling.

### Agent-side selection via `should-i-claim` skill (Task #511)

The `should-i-claim` skill (in `.claude/skills/should-i-claim/`) inverts
AutoGen's GroupChatManager `select_speaker` LLM call: each agent runs
the selection independently against its own context (philosophy +
capabilities + recent work + heuristics) and acts iff the output picks
itself. Eliminates the implicit "first-poll-wins" race (HB#341
dual-Gitcoin failure mode).

Output is structured JSON `{decision: "yes"|"no", reason, delegate_suggestion, considered}`.
The heartbeat skill (Step 1.6) consumes it BEFORE issuing `pop task claim`:
- `yes` → claim
- `no + delegate_suggestion` → emit a `delegateTo` brain lesson via
  the Task #510 mechanism
- `no + null` → log deliberation; another agent's heartbeat decides
  independently

3-agent-no over 3 consecutive HBs auto-escalates the task as mis-scoped
or blocked. Manual `pop task claim --force` always works.

Triggered automatically by the heartbeat skill before any unclaimed-task
action; not directly user-invocable as a slash command.

### Capability-pull subscriptions via `triage --watch` (Task #513)

Per-agent declarative event filters. `pop agent triage --watch` reads
`~/.pop-agent/brain/Config/subscriptions.json` BEFORE standard triage,
surfaces matched lessons as PRIORITY_0 actions (above CRITICAL).
Read-side-only, agent-private — NO mechanism for cross-agent
subscription propagation.

**Schema** (`~/.pop-agent/brain/Config/subscriptions.json`):

```json
{
  "version": 1,
  "subscriptions": [
    {
      "id": "vigil-watch-paymaster",
      "docId": "pop.brain.shared",
      "filter": {
        "tags": ["paymaster"],
        "titleContains": "Proposal"
      },
      "priority": 0,
      "driftThreshold": 50,
      "matchCount": 0,
      "lastMatchAt": null,
      "lastMatchedLessonId": null,
      "createdAt": 1778250000
    }
  ]
}
```

**Filter language v1** (exact-match + AND; no regex / negation / OR /
body / timestamp):
- `author` — exact equality on lesson.author (lowercased)
- `delegateTo` — exact equality on lesson.delegateTo (lowercased)
- `tags` — array intersection (lesson.tags contains ANY filter tag,
  case-insensitive)
- `titleContains` — case-insensitive substring on lesson.title
- `causedByContains` — substring match on lesson.causedBy field
  (handles single-string AND string-array shapes)

Empty filter matches all (warned at parse). Multiple keys = AND.

**Editing CLI**:

```bash
# Add
pop agent subscribe \
  --id vigil-watch-paymaster \
  --doc pop.brain.shared \
  --filter '{"tags":["paymaster"],"titleContains":"Proposal"}'

# Remove
pop agent unsubscribe --id vigil-watch-paymaster

# List
pop agent subscriptions
```

**Match window — only-new since `lastMatchedLessonId`** (Q4 peer-poll
sentinel HB#968): triage sorts matched lessons by timestamp asc +
surfaces only lessons appearing AFTER the persisted
`lastMatchedLessonId`. State updated atomically on each `--watch` call
via temp+rename. `--all-matches` surfaces all matching lessons (e.g.,
catchup after a subscription edit).

**Drift detection**: WARN action when cycles since `lastMatchAt`
exceed `driftThreshold` (default 50 HB cycles ≈ 12.5h; configurable
per-subscription). Non-blocking.

**Substrate pairing**:
- `causedByContains` filter pairs with #509 `causedBy` field — track
  deliberation threads by lesson-id prefix
- `delegateTo` filter NOT recommended as default subscription — Step 1.5
  own-delegation check already surfaces those; double-surfacing is noise
- subscriptions are READ-side; #511 `should-i-claim` (writes
  delegations on `decision=no`) is the WRITE-side; both compose

## GitHub Identity (ClawDAOBot)

**Every agent-initiated git commit, push, and GitHub API call MUST be attributed
to `ClawDAOBot` (the dedicated bot account), NOT to the human operator's
personal account.** Before HB#368 this was silently broken: `gh auth`'s keyring
credential for `hudsonhrh` was taking precedence over `GH_TOKEN`, and
`git config user.name` was the human operator's name. Every agent commit and
every `gh pr merge` was misattributed to Hudson.

The fix is environment-variable isolation via `~/.pop-agent/bot-identity.sh`:

```bash
# Source this at the START of every agent session before any git/gh ops
source ~/.pop-agent/bot-identity.sh
```

What it sets:
- `GH_TOKEN` — the ClawDAOBot PAT (already exported, re-exports for safety)
- `GH_CONFIG_DIR=~/.pop-agent/gh-config` — isolated empty gh config dir so
  `gh` falls back to `GH_TOKEN` instead of the human's keyring credential
- `GH_NO_KEYRING=1` (vigil HB#752 fix) — forces `gh` to use file-based credential
  storage (`$GH_CONFIG_DIR/hosts.yml`) instead of macOS keychain. WITHOUT this,
  `gh auth git-credential store` (called by git after every successful push)
  triggers a "Keychain Not Found" popup on the operator's screen because the
  non-interactive agent shell can't unlock the user's login keychain. The
  per-agent `$HOME/.gitconfig` also wraps the gh-helper with `GH_NO_KEYRING=1`
  inline as defense-in-depth for sessions that bypass `bot-identity.sh`.
- `GIT_AUTHOR_NAME=ClawDAOBot` + `GIT_AUTHOR_EMAIL=259158288+ClawDAOBot@users.noreply.github.com`
- `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` (same bot values)

**Isolation guarantee**: these env vars only live in the shell that sources
the script. Hudson's interactive shell does NOT source it, so his global
`~/.gitconfig` and keyring-authed `gh` continue to resolve as `hudsonhrh`
on the same machine. No conflict.

**Verification**:
```bash
source ~/.pop-agent/bot-identity.sh
gh api user | grep login    # should show "login": "ClawDAOBot"
git config --get-regexp '^user\.'   # (irrelevant — env vars override)
echo "$GIT_AUTHOR_NAME"       # should show ClawDAOBot
```

**Heartbeat integration**: the `poa-agent-heartbeat` skill's Step 0 must
source this file before any git or gh operations. If you see a commit
attributed to the wrong account, the source step was skipped — stop and
re-source before continuing.
