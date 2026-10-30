# Independent role consumer

This small JS host imports the public packed `@poa-box/core`. The default story
is **SYNTHETIC**, deterministic and network-free. It invokes real SDK observation,
review, preparation, recovery and continuation functions; only indexed/RPC/content
transport and two explicitly fake sends are fixtures. It requires no key, frontend,
CLI, viem or permissionless dependency. It never signs or publishes real content.

## Start from npm

Copy this directory outside the repository. Under Node **18 or newer**:

```sh
npm install --ignore-scripts
npm test
npm start
npm start -- --workflow-fixture
```

The normal package uses exact registry `@poa-box/core@2.1.0` and `ethers@5.7.2`.
There is no missing `core.tgz`, workspace link or frontend dependency. Yarn 1 users
can run `yarn install --frozen-lockfile --ignore-scripts` using the committed lock.
The legacy fixture and the controller demo are both labeled synthetic. The latter
exercises `createRoleWorkflow` with explicit separate publish/send approvals,
unsigned persistence, uncertain-send recovery and separately reviewed actual-ID
configuration. It does not connect a real wallet or publisher.

For unsigned task, informational poll and ballot examples, see the
[task-oriented getting-started guide](https://github.com/poa-box/poa-cli/blob/main/packages/core/docs/getting-started.md)
and [structured recipes](https://github.com/poa-box/poa-cli/blob/main/packages/core/docs/workflow-recipes.v1.json). Those
are repository follow-up documentation tested against distributed 2.1.0; they
do not modify the already published release.

## Connect explicit host capabilities

`src/workflow.mjs` exports `createRoleWorkflow({ workflowId, scope, sources, wallet,
journal, documents, confirm, isCurrent })`. Methods separate `capabilities`,
`review`, `prepare`, `submit`, `recover`, `continuation` and read-only `inspect`.
Review/prepared handles are in-memory authority, not saved JSON approvals.
The injected confirmation callback receives a frozen stage-specific request:
`kind: 'publish' | 'send'`, workflow/stage/scope, the reviewed request, and document
digests or the exact wallet call/nonce. There is no implicit approval.

`createEthersWalletAdapter({ ethereum })` is the browser path: inject the existing
EIP-1193 connection. It populates the exact transaction and performs the single
`eth_sendTransaction` handoff immediately after the controller's final callback.
For an injected `{ signer, provider }`, also supply the explicit
`dispatchPopulatedTransaction(tx)` capability; a signer alone is refused because
its send implementation could hide awaited setup after the final check. That
capability must initiate the wallet boundary immediately, with no extra preflight.

The adapter checks account/chain and preserves calldata/native `value` as decimal
wei. Preparation obtains nonce, block and gas before the final callback; send
handles are one-use, including refusal. `isCurrent()` must synchronously return
true for the active account/organization generation. Never pass private keys to
this example. After a blocked unsent attempt, follow controller recovery/review
guidance rather than replaying an old send handle.

`createBrowserJournal({ indexedDB, locks, databaseName })` needs IndexedDB with
strict transaction durability and exclusive account Web Locks. Missing support,
persistence failure or competing ownership refuses the operation; there is no
relaxed/localStorage fallback. The journal stores unsigned workflow/recovery
records only. After uncertainty, reload and call `recover` on the original record;
never automatically repeat publication or sending. An optional explicit candidate
hash or verified publication receipt is a recovery hint, not permission to retry.
The fixture journal has one synthetic owner and does not establish browser durability.

## Verify an explicit release archive

This repository-only check is optional for an adopter. It deliberately overrides
the copied starter's registry dependency with the one supplied archive, preserving
an isolated install and the existing offline cache requirement.

From the core repository root, under Node **18 or newer** and existing Yarn:

```bash
node packages/core/scripts/verify-packed-consumer.mjs /absolute/path/to/candidate-core.tgz
```

The explicit archive may also be relative to the current directory. This command
never builds or packs core. It copies this example and that archive into a fresh
`.context/registry-integration/consumer/<hash>-<run>/` directory, installs
with the committed lock and `yarn --offline --frozen-lockfile --ignore-scripts`,
and validates real module paths. Missing cache is a blocked install; it does not
use source links, aliases, `NODE_PATH` or workspace node_modules as a fallback.
The lock seed retains existing dependency versions; the verifier adds only the
candidate archive's exact local hash/dependency record and existing test tools.

It records archive SHA-256, imports, logs, fixture tests, packaged payable docs,
strict classic/Node16/bundler declarations (`skipLibCheck: false`, explicit
`@types/node`), and a browser bundle/VM fixture run in `evidence.json`. The VM has
browser globals and denies network; it has no process, require or Buffer globals.
This is offline browser compatibility evidence, not a browser UI or live proof.

After verification, run from the printed isolated directory:

```bash
yarn start
yarn test
```

The story reads organization modules and current group-derived permissions,
reviews all desired role settings, prepares create-only calldata, simulates one
lost acknowledgment, reloads a version-2 unsigned journal and recovers without
resending. The exact created subject has sequence 15 although earlier subjects
have sequences 1, 2 and 9 (including the same name). Canonical receipt/index proof
selects the actual ID, then a separate reviewed configuration and proposal outcome
finish the story. The independent tests decode method arguments rather than only
comparing opaque snapshots. No uncertain stage is automatically replayed.

The demonstration journal has one synchronous host owner. Production hosts must
provide durable atomic storage and an exclusive account lock/fence for every
writer, preserve original form and exact scoped stage references, and recheck
identity/cancellation before wallet handoff. Opaque review/prepared handles cannot
be recovered from JSON. Renew review after reload. Core owns protocol logic;
hosts own React/cache/lifecycle, consent, persistence and wallet transport.

## Explicit real reads

Real mode must be selected explicitly. In the isolated directory:

```bash
node src/main.mjs --read-only --input /absolute/path/to/public-input.json
```

The JSON contains only `scope`, `indexedEndpoint`, `rpcEndpoint`, and `request`.
Use actual public module addresses and endpoint URLs for the selected chain:

```json
{
  "scope": {
    "chainId": 100,
    "orgId": "0x<64 hex digits>",
    "account": "0x<40 hex digits>",
    "contract": "0x<MembershipAuthority address>",
    "contracts": {
      "membershipAuthority": "0x<same authority address>",
      "hybridVoting": "0x<HybridVoting address>",
      "executor": "0x<Executor address>"
    }
  },
  "indexedEndpoint": "https://your-public-index.example/graphql",
  "rpcEndpoint": "https://your-public-chain.example/rpc",
  "request": { "mode": "create", "role": { "kind": "Role", "name": "Builders" } }
}
```

This mode accepts public inputs, a clock and read transport. It has no environment
secret lookup, publisher, signer, getSigner, arbitrary RPC method or send interface.
The provider exposes only chain/block/transaction/receipt reads and eth_call; the
GraphQL adapter preserves errors and source identity. The CLI imposes a 20-second
abort deadline. An unavailable counter/schema/endpoint returns unknown/failure;
this is not closed deployed-data parity. No live mode was exercised in this phase.

Read [the role recipe](https://github.com/poa-box/poa-cli/blob/main/packages/core/docs/role-operations.md) and
[static agent catalog](https://github.com/poa-box/poa-cli/blob/main/packages/core/docs/operation-manifest.v1.json) for exact
side effects, units and retry policy. Review never publishes; prepare may invoke
the explicit publisher; final revalidation only reads. A ready batch is not consent
or an executed vote. Passkey cashout and eventless-native history stay excluded.
