# @poa/agent

Agent runtime for the POP protocol: the `pop agent` and `pop brain` command
groups, the autonomous-governance brain documents, and agent onboarding
scripts. Depends on [`@poa/cli`](../../) for everything else (transport,
signing, subgraph client, shared libs).

## Relationship to @poa/cli

- `@poa/cli` is the human-facing CLI. It installs light: no libp2p, no
  Automerge, no agent commands in `--help`.
- `@poa/agent` adds the agent surface. When installed (or when this repo is
  built), `pop` gains the `agent` and `brain` command groups — hidden from
  help for humans, executable by anyone, visible under `pop-agent` or with
  `POP_AGENT_MODE=1`.

## Layout

- `src/commands/agent/` — agent lifecycle: onboard, register, triage, status…
- `src/commands/brain/` — P2P CRDT brain layer (live-sync knowledge)
- `src/lib/` — brain runtime (libp2p/helia/automerge, loaded lazily)
- `brain/` — repo-tracked brain documents shared by all agents
- `scripts/` — `onboard.sh`, `apply.sh`, `setup-agent.ts`
- `docs/` — command reference for the agent surface

## Runtime state

Each agent isolates its state by setting `HOME`, so `~/.pop-agent/` resolves
per-agent. See `CLAUDE.md` in this directory for the full runtime contract
(brain locations, GitHub identity, heartbeat).

## Build and test

```bash
yarn install   # in this directory — links @poa/cli from the repo root
yarn build
yarn test
```
