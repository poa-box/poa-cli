# Integrating POP into your app

POP has **three integration surfaces**. All three produce byte-identical
transactions and metadata, because all three run the same layer underneath —
[`@poa/core`](../../packages/core/README.md). Anything created through any of
them indexes correctly in the subgraph and renders correctly in every POP
frontend. Pick by the shape of your app, not by feature coverage (they all
cover everything).

## Which surface is yours?

| You are building… | Use | Why |
|---|---|---|
| A web frontend (Next/React/Vite, any wallet stack) | **`@poa/core`** | Tx builders return wallet-agnostic intents; your users sign with wagmi, passkeys, whatever you run |
| A TypeScript/JS backend, bot, or service | **`@poa/core`** | In-process, typed, no child processes |
| An app in any *other* language (Python, Go, Rust…) | **CLI with `--json`** | Stable JSON contracts, stable exit codes; shell out and parse |
| Automation with shell access (cron, CI, an agent with a Bash tool) | **CLI with `--json`** | Composition, `--help`, `--dry-run`, stderr feedback |
| An AI agent that only makes tool calls (no shell) | **`pop mcp serve`** | Every command becomes an MCP tool; zero integration code |
| A dashboard / analytics / read-only tool | **`@poa/core` reads** (JS) or **CLI `--json`** (anything else) | No keys, no wallet, no write surface at all |
| Ops tooling for a multisig | **`@poa/core`** → `encodeIntent` → Safe | An intent is just `{to, data, value}` — propose it to the Safe |

Mixing is normal: a Python backend shells the CLI while its TS frontend uses
core; an AI agent uses MCP while your deploy scripts use the CLI. Nothing
diverges, because it's one layer.

---

## Path 1 — `@poa/core`: the library (JS/TS apps)

```bash
yarn add @poa/core ethers@5.7.2
# (@poa/core is not on npm yet — consume via git/link until first publish.
#  ethers rides along as core's encoding library; your WALLET can be anything.)
```

### Reads: zero-config

```ts
import { createPopContext } from '@poa/core';
import { resolveOrgModules } from '@poa/core/reads/resolve';
import { listTasks } from '@poa/core/reads/task';

const ctx = createPopContext({ chainId: 100 });          // Gnosis. That's all the setup.

const org = await resolveOrgModules(ctx.client, 'my-org'); // name or 0x id
const tasks = await listTasks(ctx.client, org.orgId);
```

No API key, no signer, no infrastructure. Reads route through the tiered
subgraph client (free endpoint, automatic paid-gateway failover when you
supply `GRAPH_API_KEY` via `env`), with field-fallback across subgraph
deployments handled for you. Typed reads exist per domain
(`@poa/core/reads/*`); the raw GraphQL documents are exported too
(`@poa/core/graph/documents`) if you run Apollo.

### Writes: fill in the facts, get a ready transaction

You provide the **human-level facts**. Core resolves the org's contract
addresses (subgraph), validates inputs, builds the canonical metadata JSON
(key order is a protocol contract — you never construct it), **pins it to
IPFS** (The Graph's endpoint by default — no IPFS infra on your side;
override with `ipfs: { apiUrl }` if you run your own), converts the CID, and
encodes the calldata, including version quirks like v6-vs-legacy signatures:

```ts
import { createProposalIntent } from '@poa/core/tx/vote';
import { encodeIntent } from '@poa/core/tx/intent';

const intent = await createProposalIntent(ctx, {
  org: 'my-org',
  type: 'hybrid',
  name: 'Fund the docs sprint',
  description: 'Two weeks of documentation work, paid from treasury',
  durationMinutes: 1440,
  optionNames: ['Yes', 'No'],
});
```

The intent is data — nothing is signed or sent. Execute it with **your**
wallet stack:

```ts
// Universal shape — works with every stack on earth
const { to, data, value } = encodeIntent(intent);

// viem / wagmi
await walletClient.sendTransaction({ to, data, value: BigInt(value) });
// or richer, via wagmi:
writeContract({ address: intent.to, abi: intent.abi, functionName: intent.method, args: intent.args });

// ethers
await signer.sendTransaction({ to, data, value });
// or the built-in executor (gas estimation, receipt parsing, decoded errors):
import { executeIntent } from '@poa/core/execute/ethers';
const result = await executeIntent(signer, intent, { dryRun: false });

// Safe / multisig
await safeSdk.createTransaction({ transactions: [{ to, data, value }] });

// Sponsored (ERC-4337 / EIP-7702 — PaymasterHub pays gas)
import { sendSponsored } from '@poa/core/execute/sponsored';
await sendSponsored(privateKey, intent.to, data, orgId, hatId, { bundlerUrl });
```

For your confirmation UI: `intent.meta.summary` carries human-readable
preview fields, and `intent.meta.ipfs` carries the pinned CID + document.
Every one of the protocol's write operations has a builder like this under
`@poa/core/tx/*` — tasks, votes, org membership, roles/vouching, tokens,
treasury (including governance-wrapped proposals), education, zkemail.
Builders come in two levels: async `*Intent(ctx, params)` (resolves the org,
derives conventions, pins metadata) and pure sync `build*(args)` when you
already hold addresses and want zero I/O.

Note on timing: metadata pins when the intent is **built**, not when it's
sent. An abandoned confirmation leaves an unreferenced, content-addressed
document on IPFS — harmless, and exactly what the CLI has always done.

### Environment injection (browser / server / anywhere)

Core never reads `process.env` or the filesystem — hosts inject what they
want:

```ts
const ctx = createPopContext({
  chainId: 100,
  env: { GRAPH_API_KEY: process.env.NEXT_PUBLIC_GRAPH_API_KEY },  // optional
  graph: { stateStore: myLocalStorageStore },                     // optional quota memory
  ipfs: { apiUrl: myPinningEndpoint },                            // optional
  provider: myEthersProvider,       // only needed for feature detection / quotes
});
```

Purity is test-enforced, and the optional viem/permissionless peers are only
required if you use the sponsored execution path — reads-only and plain-EOA
consumers never install them.

### Building a full frontend?

The service-by-service adoption map (written against the reference frontend,
works as a template for a new one) is at
[`packages/core/docs/frontend-adoption.md`](../../packages/core/docs/frontend-adoption.md).
Full package docs: [`packages/core/README.md`](../../packages/core/README.md).

---

## Path 2 — the CLI with `--json`: any language, any shell

Everything the protocol can do is a `pop` command with machine-readable
output. The safe starting point:

```bash
POP_READONLY=1 POP_ADDRESS=0xYourAddress POP_DEFAULT_CHAIN=100 pop vote list --unvoted --json
```

- **`POP_READONLY=1`** makes the process *structurally* unable to sign,
  broadcast, or pin to IPFS. Not policy — capability: the signer, the
  ERC-4337 sponsorship path, and the IPFS pinning helpers all refuse. You can
  hand this process to untrusted automation.
- **`POP_ADDRESS` / `--address`** serves every identity-scoped read (`vote
  list --unvoted`, `task list --mine`, `user whoami`, `user profile`,
  `role applications --mine`, `token balance`) without a private key. Never
  give a signing key to a process that only reads.
- **`--json`** is an output format, **never consent**. Destructive commands
  (`vote execute`, `token approve`, `treasury send`, …) require an explicit
  `--yes` (or `POP_ASSUME_YES=1`) in every non-interactive context.
- `--json` stdout is clean: progress/warnings go to stderr, so
  `JSON.parse(stdout)` is safe on every command.

### Know what each command does before calling it

The machine-readable manifest classifies all commands:
[`docs/reference/cli/manifest.json`](../reference/cli/manifest.json) (shipped
in the package at `dist/generated/cli-manifest.json`). Per command:
`readOnly`, `broadcasts`, `destructive`, `sideEffects`. Traps it encodes so
you don't rediscover them:

- `vote announce-all` **reads like inspection but broadcasts transactions**
- `--pin` on `org audit-*`, `org leaderboard`, `org portfolio` publishes the
  output to IPFS **publicly and irreversibly**; `org publish` always does
- 18 commands are destructive, not the 7 you might guess from their names

The classification is drift-checked in CI against the source, so trust the
manifest over grepping.

### Enabling writes deliberately

1. Give the integration its own wallet with minimal funds — never a treasury key.
2. Drop `POP_READONLY`, set `POP_PRIVATE_KEY`.
3. Prefer `--dry-run` first; every write supports it.
4. Pass `--yes` explicitly where you mean it. Nothing else consents for you.
5. Gas can be sponsored (ERC-4337) — see [gas-sponsorship](gas-sponsorship.md).

---

## Path 3 — MCP: zero-code integration for AI agents

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

Rule of thumb from the agent world: if your agent has shell access, the raw
CLI is the stronger interface (composition, `--help`, stderr feedback) — MCP
is for tool-calls-only environments and as a capability firewall for agents
that handle untrusted input. The short agent-facing version of this guide
ships as [`AGENTS.md`](../../AGENTS.md) in the package root — point your
agent's context at it.

---

## What happens when the protocol changes

You should never need to rework your integration because a contract or the
subgraph changed — that churn is absorbed **inside** the layer you consume:

- **`@poa/core`**: semver. Within a major version changes are additive,
  enforced by `packages/core/api-surface.json` — removing or renaming any of
  the package's exports fails its CI (`yarn api:check`) and requires a major
  bump. Contract upgrades land behind feature detection (old orgs keep
  getting old calldata), so upgrading is `yarn upgrade @poa/core` + reading
  one changelog line.
- **CLI `--json`**: every key in
  [`output-contracts.json`](../reference/cli/output-contracts.json) is
  promised — not renamed or removed without a major bump. New keys may appear
  at any time: parse defensively, ignore what you don't know. Error codes and
  exit codes are stable identifiers. Deprecations warn on **stderr** first
  and survive at least until the next major.
- **MCP**: inherits the CLI's contract (tools are the CLI).
- While on 0.x: patch releases (0.x.y) are always consumer-safe; breaking
  changes bump the minor and are called out in release notes. Pin `~0.x`
  (Docker: exact version), and correlate behavior with `pop --version`.

Releases go core → cli → agent in lockstep, and the CLI's full test suite
runs against core on every change — so by the time a core version reaches
you, the reference consumer has already exercised it end to end. Full policy
and checklist: [docs/RELEASING.md](../RELEASING.md).

## Packaging

- Docker (CLI): see [docker.md](docker.md) and the reference `Dockerfile` —
  it builds the two-package chain (`packages/core` first) and encodes the one
  build trap (`dist/abi/*.json` is copied by `yarn build`; plain `tsc` ships
  3 of 20 ABIs and fails at runtime in ways that look like protocol bugs).
- npm: `@poa/cli` and `@poa/core` are publish-ready (`prepublishOnly`
  builds) but not yet published; clone-and-build, `link:`, or Docker are the
  current install paths.
