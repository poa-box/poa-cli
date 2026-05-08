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
