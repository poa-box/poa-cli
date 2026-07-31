# Integrating pop into another agent or app

How to embed the POP CLI safely in an agent framework, a bot, or any
automation — an "org brain" that reads org state and creates tasks, an MCP
client, a dashboard backend.

## The safe starting point

```bash
POP_READONLY=1 POP_ADDRESS=0xYourAddress POP_DEFAULT_CHAIN=100 pop vote list --unvoted --json
```

- **`POP_READONLY=1`** makes the process *structurally* unable to sign,
  broadcast, or pin to IPFS. Not policy — capability: `createSigner`, the
  ERC-4337 sponsorship path, and the IPFS pinning helpers all refuse. You can
  hand this process to untrusted automation.
- **`POP_ADDRESS` / `--address`** serves every identity-scoped read (`vote
  list --unvoted`, `task list --mine`, `user whoami`, `user profile`,
  `role applications --mine`, `token balance`) without a private key. You
  never need to give a signing key to a process that only reads.
- **`--json`** is an output format, **never consent**. Destructive commands
  (`vote execute`, `token approve`, `treasury send`, …) require an explicit
  `--yes` (or `POP_ASSUME_YES=1`) in every non-interactive context.

## Know what each command does before calling it

The machine-readable manifest classifies all commands:

- [`docs/reference/cli/manifest.json`](../reference/cli/manifest.json) (also
  shipped in the package at `dist/generated/cli-manifest.json`)

Per command: `readOnly`, `broadcasts`, `destructive`, `sideEffects`. Traps it
encodes so you don't rediscover them:

- `vote announce-all` **reads like inspection but broadcasts transactions**
- `--pin` on `org audit-*`, `org leaderboard`, `org portfolio` publishes the
  output to IPFS **publicly and irreversibly**; `org publish` always does
- 17 commands are destructive, not the 7 you might guess from their names

The classification is drift-checked in CI against the source (a command that
can broadcast cannot ship unclassified), so trust the manifest over grepping.

## MCP: zero-code integration

```bash
pop mcp serve                          # read-only tools, stdio MCP server
pop mcp serve --allow-writes           # + non-destructive writes
pop mcp serve --allow-destructive      # everything (labelled [DESTRUCTIVE])
```

Every CLI command becomes an MCP tool (`pop_org_list`, `pop_vote_list`, …)
with an input schema generated from the manifest. Least privilege by default:
writes and pinning need explicit opt-in, and `POP_READONLY=1` in the server's
environment remains the structural backstop regardless of flags. The
`pop_manifest` tool returns the full manifest, so a client can discover the
safety classification at runtime.

Claude Desktop / MCP-client config:

```json
{
  "mcpServers": {
    "pop": {
      "command": "node",
      "args": ["/path/to/poa-cli/dist/index.js", "mcp", "serve"],
      "env": { "POP_READONLY": "1", "POP_DEFAULT_CHAIN": "100", "POP_DEFAULT_ORG": "YourOrg" }
    }
  }
}
```

## Enabling writes deliberately

When your integration graduates to acting (creating tasks, voting):

1. Give it its own wallet with minimal funds — never a treasury key.
2. Drop `POP_READONLY`, set `POP_PRIVATE_KEY`.
3. Prefer `--dry-run` first; every write supports it.
4. Pass `--yes` explicitly where you mean it. Nothing else consents for you.
5. Gas can be sponsored (ERC-4337) — see [gas-sponsorship](gas-sponsorship.md).

## Packaging

- Docker: see [docker.md](docker.md) and the reference `Dockerfile` — it
  encodes the one build trap (`dist/abi/*.json` is copied by `yarn build`;
  plain `tsc` ships 3 of 20 ABIs and fails at runtime in ways that look like
  protocol bugs).
- npm: `@poa/cli` is publish-ready (`prepublishOnly` builds) but not yet
  published; clone-and-build or Docker are the current install paths.
- `--json` stdout is clean: progress/warnings go to stderr, `JSON.parse` of
  stdout is safe on every command.
