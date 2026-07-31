# Autonomous Governance Agent

An agent that participates in a POP org by driving the `pop` CLI. This file covers agent
**runtime** concerns only. For developing the CLI itself, see the repo-root `CLAUDE.md`.

> **Scope.** Everything here — especially the commit-attribution rule — applies to *agent
> heartbeat runs*. It does **not** apply to a human developing this repo interactively.
> Conflating the two is what previously caused the operator's own commits to be attributed
> to the bot.

## Brain — two locations

**Repo-tracked** (`agent/brain/`, updated via `git pull`, shared by all agents):
- `Identity/how-i-think.md` — voting heuristics and escalation rules
- `Config/agent-config.json` — execution mode and thresholds
- `Knowledge/shared.md` — cross-agent knowledge; update it when you learn something another agent needs

**Per-agent runtime** (`$HOME/.pop-agent/`, survives restarts, never in git):
- `brain/Identity/who-i-am.md` — wallet, org, permissions
- `brain/Identity/goals.md` — what this agent is working toward
- `brain/Identity/capabilities.md` — skills index
- `brain/Identity/philosophy.md` — values informing votes and task selection
- `brain/Memory/heartbeat-log.md` — append-only log (observations, decisions, actions)
- `brain/Memory/org-state.md` — org snapshot, overwritten each heartbeat
- `.env` — wallet key and org config
- `bot-identity.sh` — git/gh identity isolation (see below)

## HOME isolation

Each agent sets `HOME` to its own directory so `~/.pop-agent/` resolves to its own state:

```bash
HOME=/Users/hudsonheadley/pop-agents/sentinel   claude --cd /path/to/repo
HOME=/Users/hudsonheadley/pop-agents/vigil_01   claude --cd /path/to/repo
HOME=/Users/hudsonheadley/pop-agents/argus_prime claude --cd /path/to/repo
```

Required in each `.env`: `POP_PRIVATE_KEY`, `POP_DEFAULT_ORG`, `POP_DEFAULT_CHAIN`
(100 = Gnosis, 11155111 = Sepolia).

⚠️ **Known hazard.** `/Users/hudsonheadley/.pop-agent/` — the *default* HOME — is currently
shared between the operator's interactive CLI use and any agent started without an explicit
`HOME`. That directory's `.env` is the operator's working config. An agent run there will read
and write the operator's state. `pop-agents/argus_prime/` exists as a proper separate home;
prefer it, and always pass an explicit `HOME`.

## GitHub identity

Agent-initiated commits, pushes, and `gh` calls must be attributed to **ClawDAOBot**, not to the
operator's personal account. `gh`'s keyring credential for `hudsonhrh` otherwise takes precedence
over `GH_TOKEN`, silently misattributing every agent commit.

```bash
source ~/.pop-agent/bot-identity.sh   # Step 0 of every heartbeat, before any git/gh op
```

It exports `GH_TOKEN`, `GH_CONFIG_DIR` (an isolated empty gh config dir, so `gh` falls back to
`GH_TOKEN` instead of the keyring), and `GIT_AUTHOR_*` / `GIT_COMMITTER_*` as ClawDAOBot. These
live only in the shell that sources it, so the operator's own `~/.gitconfig` and keyring-authed
`gh` still resolve as `hudsonhrh` on the same machine.

Verify: `gh api user | grep login` → `"login": "ClawDAOBot"`.
A commit attributed to the wrong account means Step 0 was skipped — stop and re-source.

**Operator override.** When Hudson directs work explicitly (rather than an agent acting on its
own initiative), commits go to **his** account: do *not* source `bot-identity.sh`, and confirm
with `gh api user` first. The bot account also lacks push access to some upstream repos.

## Heartbeat

The `poa-agent-heartbeat` skill in `.claude/skills/` is the main loop; `/heartbeat` and
`/calibrate` are the slash commands. Other skills: `governance-watchdog`, `treasury-monitor`,
`gas-monitor`, `audit-scan`, `self-audit`, `multi-org-heartbeat`, `sprint-plan`, `post-thread`.

Primary observation commands:

```bash
pop org activity --since <ts> --json          # what changed
pop vote list --unvoted --status Active --json # proposals needing a vote
pop config validate --json                     # health check before acting
```

## Writes are real

Every write command broadcasts to Gnosis mainnet with real funds. There is no confirmation
prompt, and `vote announce-all` / `vote execute` broadcast despite reading like inspection
commands. Respect `Config/agent-config.json` execution mode and thresholds; when uncertain,
escalate per `Identity/how-i-think.md` rather than acting.
