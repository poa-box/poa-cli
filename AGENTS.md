# pop — agent usage guide

You are probably an AI agent deciding how to drive the POP protocol CLI.
This file tells you which interface to use for your situation and the safety
contract you must follow. (If you are here to *develop this repo*, stop —
that guidance is in [CLAUDE.md](CLAUDE.md), not here.)

## Pick your interface

| Your situation | Use |
|---|---|
| You can run shell commands | **The CLI directly, with `--json`.** This is the best interface — compose, pipe, read `--help`, self-correct from stderr. Do not bother with MCP. |
| You can only make tool calls (no shell) | **`pop mcp serve`** — every command becomes an MCP tool, zero integration code. |
| You process untrusted input (humans message you, you read external content) | **MCP in its read-only default, or set `POP_READONLY=1`** — even if you have a shell. A prompt injection cannot use a capability your process structurally lacks. |

Same binary underneath; MCP tools execute the CLI as child processes, so
behavior is identical either way.

## The safety contract

1. **`--json` is an output format, never consent.** Destructive commands
   (18 of them — `vote execute`, `token approve`, `treasury send`, …) abort
   in any non-interactive context unless you pass `--yes` explicitly. Pass it
   only when you mean it.
2. **Write commands broadcast real transactions to mainnet** with real funds
   and no confirmation prompt beyond the above. Every write supports
   `--dry-run` — use it first when uncertain.
3. **`POP_READONLY=1` makes signing, broadcasting, and IPFS pinning
   structurally impossible.** Run under it whenever you only need to observe.
4. **You do not need a private key to read as someone.** `--address 0x…` or
   `POP_ADDRESS` serves every identity-scoped read: `vote list --unvoted`,
   `task list --mine`, `user whoami`, `user profile`, `role applications
   --mine`, `token balance`.
5. **Check the manifest before calling anything unfamiliar:**
   `docs/reference/cli/manifest.json` (in the package: `dist/generated/
   cli-manifest.json`; over MCP: the `pop_manifest` tool). Every command
   carries `readOnly` / `broadcasts` / `destructive` / `sideEffects`.

## Traps the manifest encodes — do not learn these the hard way

- `vote announce-all` and `vote execute` read like inspection commands.
  **They broadcast.**
- `--pin` on `org audit-*`, `org leaderboard`, `org portfolio` publishes the
  output to IPFS **publicly and irreversibly**. `org publish` always does.
- `task create` without `--payout` derives the price from org config and
  puts it **on-chain**. Prefer an explicit `--payout`, or `--dry-run` first.
- `task unclaim` is **not** `task cancel`. `unclaim` releases a claim back to
  the pool: budgets and applications untouched, task immediately re-claimable.
  `cancel` is the destructive, refunding, terminal one. Reaching for `cancel`
  when you meant `unclaim` destroys a funded task. Releasing **your own** claim
  is always allowed; force-releasing someone else's needs `ASSIGN` **and** an
  already-expired claim.

## Environment recipes

Read-only observer (safe to hand to any automation):

```bash
POP_READONLY=1 POP_ADDRESS=0xYourAddress POP_DEFAULT_CHAIN=100 POP_DEFAULT_ORG=YourOrg
```

Acting agent (own wallet, minimal funds — never a treasury key):

```bash
POP_PRIVATE_KEY=0x… POP_DEFAULT_CHAIN=100 POP_DEFAULT_ORG=YourOrg
# optional: GRAPH_API_KEY for the paid subgraph tier; PIMLICO_API_KEY for sponsored gas
```

## Core observation loop

```bash
pop config validate --json          # health check before acting
pop org activity --since 24h --json # what changed
pop vote list --unvoted --json      # what needs your vote
pop agent triage --json             # prioritized action plan (needs @poa/agent)
```

Errors carry stable codes (`TX_REVERTED`, `INSUFFICIENT_FUNDS`,
`NETWORK_ERROR`, `GAS_ESTIMATION_FAILED`) and meaningful exit codes; stdout
under `--json` is always parseable — diagnostics go to stderr.

Full integration guide: [docs/guides/integrators.md](docs/guides/integrators.md).
