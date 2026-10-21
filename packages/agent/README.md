# @poa-box/agent

Agent runtime for the POP protocol: the `pop agent` and `pop brain` command
groups, the autonomous-governance brain documents, and agent onboarding
scripts. Depends on [`@poa-box/cli`](../../) for everything else (transport,
signing, subgraph client, shared libs).

## Core 2 protocol workflows

Start with `pop agent capabilities --json` to discover the installed CLI's
commands, argument schemas, broadcast flags and side effects. See the
[workflow guide](../../docs/guides/core2-workflows.md) for two-step roles,
source-aware snapshots, prepared intents, treasury reservations and recovery.

`status`, `triage`, and `deploy-to-org` accept `--address` / `POP_ADDRESS`
without a private key. Run observations under `POP_READONLY=1`. Status and
triage retain unknown historical data and explicit incomplete coverage; they
inspect both voting lanes and distinguish application work from direct claims.
After an uncertain send, use `execution status` and `execution recover` before
any retry. Recovery never automatically resends.

## Relationship to @poa-box/cli

- `@poa-box/cli` is the human-facing CLI. It installs light: no libp2p, no
  Automerge, no agent commands in `--help`.
- `@poa-box/agent` adds the agent surface. When installed (or when this repo is
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
yarn install   # in this directory — links @poa-box/cli from the repo root
yarn build
yarn test
```

## Publishing note

The `@poa-box/cli` dependency is declared as `link:../..` for in-repo
development. The `prepack` lifecycle script swaps it to a real version range
(`^0.1.0`) for the packed manifest and `postpack` restores the link, so
`npm publish --access public` just works — no manual steps. Bump the range
here when the CLI's major/minor changes.
