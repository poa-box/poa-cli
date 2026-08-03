# @poa/core

The stable protocol layer for POP (Proof of Participation): **transaction
creation** and **data reads** for every consumer — the `pop` CLI, web
frontends, autonomous agents, and third-party integrations. Protocol changes
land here; consumers update one dependency instead of chasing contract or
subgraph churn.

- **Browser-and-Node pure.** No `fs`, no `process.env`, no terminal deps
  anywhere in the package (enforced by `test/purity.test.ts`). Environment is
  injected.
- **Wallet-agnostic writes.** Every on-chain operation is a `TxIntent` —
  plain data you can execute with an ethers signer, wagmi/viem, an ERC-4337
  passkey account, an EIP-7702 sponsored userop, a Safe batch, or raw JSON-RPC.
- **Canonical protocol knowledge.** ABIs (generated, drift-proof), metadata
  JSON shapes (key order is a protocol contract), subgraph documents with
  field-fallback tiers, payout conventions, error decoding — one copy, shared.

```
ethers ^5.7 is a peer dependency (viem + permissionless only if you use the
sponsored/4337 execution path — they are optional peers).
```

## Quickstart — reads

```ts
import { createPopContext } from '@poa/core';
import { resolveOrgModules } from '@poa/core/reads/resolve';
import { listTasks } from '@poa/core/reads/task';

const ctx = createPopContext({ chainId: 100 });          // Gnosis; zero config

const org = await resolveOrgModules(ctx.client, 'my-org'); // name or 0x… id
const tasks = await listTasks(ctx.client, org.orgId);
```

Reads are **subgraph-first** through a tiered transport: the free Graph Studio
endpoint first, automatic failover to the paid gateway (`GRAPH_API_KEY` via
`env`) when the free quota is spent, and **field-fallback tiers** that keep
queries working across the different subgraph deployments on Gnosis and
Arbitrum. Raw GraphQL documents stay exported (`@poa/core/graph/documents`) if
you'd rather run them through Apollo — you keep your cache, we keep the
documents canonical.

## Quickstart — writes

Building a transaction never signs or sends. Builders return a `TxIntent`:

```ts
import { createPopContext } from '@poa/core';
import { createTaskIntent } from '@poa/core/tx/task';

const ctx = createPopContext({ chainId: 100, provider });  // provider: feature detection
const intent = await createTaskIntent(ctx, {
  org: 'my-org',
  project: 'Ops',
  name: 'Write docs',
  description: 'Draft the treasury guide',
  payout: 25,                    // omit to derive from the org's payout convention
});
// intent = { to, abi, method, args, value?, meta: { summary, ipfs, … } }
```

Execute it with whatever stack you have:

```ts
// 1. ethers EOA (what the CLI does)
import { executeIntent } from '@poa/core/execute/ethers';
const result = await executeIntent(signer, intent, { dryRun: false });
// result: { success, txHash, explorerUrl, logs, errorCode?, suggestion?, … }

// 2. wagmi / viem
import { encodeIntent } from '@poa/core/tx/intent';
writeContract({
  address: intent.to as `0x${string}`,
  abi: intent.abi,
  functionName: intent.method,
  args: intent.args,
});

// 3. ERC-4337 / EIP-7702 sponsored (PaymasterHub pays gas)
import { sendSponsored } from '@poa/core/execute/sponsored';
const { data } = encodeIntent(intent);
await sendSponsored(privateKey, intent.to, data, orgId, hatId, {
  bundlerUrl,                      // or pimlicoApiKey
});

// 4. anything else — Safe, multisig proposal, raw RPC
const { to, data, value } = encodeIntent(intent);
```

Every builder has two levels:

- **`build*` (pure, sync)** — you supply resolved addresses and values, it
  returns the intent. Zero I/O; right for frontends that already hold org
  context.
- **`*Intent(ctx, params)` (resolved, async)** — resolves the org via
  subgraph, derives conventions (payout pricing, feature-gated calldata for
  v6/v7 TaskManagers), pins metadata to IPFS, then calls the pure builder.

`meta.summary` on every intent carries human-readable preview fields for your
confirmation UI; `meta.ipfs` carries the pinned CID + document.

## Metadata is canonical here

The subgraph and every frontend parse metadata JSON **by exact key order**.
Never hand-build these objects — use `@poa/core/metadata/*`:

```ts
import { task } from '@poa/core/metadata';
const doc = task.buildTaskMetadata({ name, description, location, difficulty, estHours });
```

## Environment injection

Core never reads `process.env`. Hosts pass an `EnvSource` where env-derived
behavior is wanted:

```ts
// Node CLI
const ctx = createPopContext({ chainId: 100, env: process.env });

// Next.js
const ctx = createPopContext({
  chainId: 100,
  env: { GRAPH_API_KEY: process.env.NEXT_PUBLIC_GRAPH_API_KEY },
  graph: { stateStore: myLocalStorageStore },   // free-tier quota memory
  ipfs: { apiUrl: myPinningEndpoint },
});
```

Injection seams: `EnvSource` (endpoints, tier mode, API keys),
`TierStateStore` (subgraph quota pins — in-memory default, the CLI uses a
file, a browser can use localStorage), `IpfsOptions`, `fetch`, and `onWarn`.

## Module map

| Subpath | Contents |
|---|---|
| `@poa/core/chains` | chain table, env-injected RPC/subgraph resolution, token registry |
| `@poa/core/abis` | generated contract ABIs (`ALL_ABIS`), regenerated from forge artifacts |
| `@poa/core/graph/client` | tiered subgraph client (`GraphClient`) |
| `@poa/core/graph/documents` | GraphQL documents + pure derivation helpers, per domain |
| `@poa/core/reads/*` | typed reads: `resolve`, `task`, `org`, `vote`, `token`, `user`, `eligibility`, `treasury`, `paymaster`, `education`, `project`, `zkemail` |
| `@poa/core/tx/*` | `intent` (TxIntent/encodeIntent) + builders per domain, incl. `governance` (proposal wraps) |
| `@poa/core/execute/*` | `ethers` (EOA executor, error classification, 4337 inner-revert detection), `sponsored` (7702/4337 userop path) |
| `@poa/core/metadata/*` | canonical metadata builders (key order = protocol) |
| `@poa/core/payout`, `perms`, `zkemail`, `encoding`, `format`, `validation`, `multicall`, `error-catalog`, `preflight`, `version`, `task-lens`, `ipfs` | shared protocol logic |

Prefer subpath imports — the root barrel re-exports everything but pulls the
whole package into a bundle.

## Stability contract

- **Semver.** Within a major version, changes are additive. Renaming,
  removing, or moving an export is a breaking change and bumps the major.
- **Enforced.** `api-surface.json` records every export of every module;
  `yarn api:check` fails if any recorded export disappears (additions are
  allowed and recorded with `yarn api:update`, so they show up in review).
  Same policy as the CLI's `--json` output contracts.
- **Encoding parity.** `test/calldata-parity.test.ts` pins intent builders to
  the exact bytes the CLI has always broadcast; `test/purity.test.ts` pins
  browser purity.
- Frozen shapes: `TxIntent`, `TxResult`, error codes (`TX_REVERTED`,
  `INSUFFICIENT_FUNDS`, `NETWORK_ERROR`, `GAS_ESTIMATION_FAILED`, …), and all
  metadata document shapes.

## Relationship to the CLI and frontend

The `pop` CLI consumes this package for all shared logic (its `src/lib/*`
modules are thin wrappers binding `process.env` and the terminal), so core is
exercised by the CLI's full test suite on every change. The reference frontend
(`poa-app`) has the same layering (`src/services/web3/` with pluggable
transaction managers); migrating a service means adapting its
`txManager.execute(contract, method, args)` call to accept a `TxIntent` and
replacing the service internals with the corresponding `tx/<domain>` builders.

## Development

```bash
yarn build        # gen-abis (from ../../src/abi) + tsc → dist/
yarn test         # purity gate + calldata parity
yarn api:check    # exported-surface tripwire (run after build)
```

ABIs track the contracts repo's deployed `main` via the CLI's
`yarn sync-abis`; `scripts/gen-abis.mjs` derives the TS modules at every core
build, so the checked-in copies self-heal.
