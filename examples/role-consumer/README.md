# Independent role consumer

This small JS host imports the public packed `@poa-box/core`. The default story
is **SYNTHETIC**, deterministic and network-free. It invokes real SDK observation,
review, preparation, recovery and continuation functions; only indexed/RPC/content
transport and two explicitly fake sends are fixtures. It requires no key, frontend,
CLI, viem or permissionless dependency. It never signs or publishes real content.

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

Read [the role recipe](../../packages/core/docs/role-operations.md) and
[static agent catalog](../../packages/core/docs/operation-manifest.v1.json) for exact
side effects, units and retry policy. Review never publishes; prepare may invoke
the explicit publisher; final revalidation only reads. A ready batch is not consent
or an executed vote. Passkey cashout and eventless-native history stay excluded.
