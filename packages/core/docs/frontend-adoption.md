# Adopting @poa/core in a frontend

This is the migration map for `poa-app` (and the template for every future
market-targeted frontend). The goal state: a frontend owns **wallet UX,
rendering, and caching** — everything protocol-shaped comes from core.

## Why this is a small migration, not a rewrite

`poa-app` already has the right architecture: framework-free domain services
(`src/services/web3/domain/*`) that funnel every write through
`txManager.execute(contract, method, args, options)`, with three
interchangeable transaction managers (direct EOA, ERC-4337 passkey, EIP-7702
sponsored) selected in `useWeb3Services`. Core's `TxIntent` is that same
`(contract, method, args)` triple as data, so the managers keep their jobs.

## Step 1 — one adapter for the tx managers

```js
// executeIntent(intent, options) over an existing manager:
async function executeIntentWith(txManager, contractFactory, intent, options) {
  const contract = contractFactory.at(intent.to, intent.abi); // or new ethers.Contract(...)
  return txManager.execute(contract, intent.method, intent.args, {
    value: intent.value, ...options,
  });
}
```

The passkey/7702 managers that want raw calldata use
`encodeIntent(intent)` → `{ to, data, value }` instead of a Contract.

## Step 2 — replace service internals, keep service APIs

Per domain, replace the body of each service method with the core builder and
delete the local encoding/metadata code. The service keeps its public shape so
hooks/components don't churn:

| poa-app source | replaced by |
|---|---|
| `TaskService` task-metadata objects (built inline 5×) | `@poa/core/metadata/task` |
| `TaskService` createTask/claim/submit/… encodings | `@poa/core/tx/task` |
| `VotingService._uploadProposalMetadata` + createProposal | `@poa/core/metadata/proposal` + `@poa/core/tx/vote` |
| `useProposalForm` buildProposalData / setterDefinitions execution batches | `@poa/core/tx/governance` (`encodeExecutorCall`, `buildGovernanceProposal`) |
| `EligibilityService` vouch/role calls + permission bitmasks (`util/permissions.js`) | `@poa/core/tx/eligibility` + `@poa/core/perms` |
| `TokenRequestService` / `TreasuryService` / `EducationService` / `ZkEmailInvitesService` | `@poa/core/tx/{token,treasury,education,zkemail}` |
| `src/lib/zkemail/allowlist.js` | `@poa/core/zkemail` |
| `util/taskUtils.js` + `tokenLabel.js` payout math | `@poa/core/payout` |
| `services/web3/utils/encoding.js` (CID↔bytes32 etc.) | `@poa/core/encoding` |
| `config/networks.js` | `@poa/core/chains` (env via injection) |
| `abi/` directory (byte-drifted copies) | `@poa/core/abis` |
| `util/tokens.js` TOKEN_META decimals | `@poa/core/chains` token registry |
| `lib/errors/` revert decoding | `@poa/core/error-catalog` + `classifyError` (map decoded errors to toasts) |
| `ipfsContext` pin/fetch plumbing | `@poa/core/ipfs` (inject your endpoints; keep your read-back verification UX on top) |
| `userOpBuilder.js` hash/paymaster encoding | `@poa/core/execute/sponsored` (`getUserOpHash`, `encodePaymasterData`) |

Frontend-tuned gas policy (`config/gas.js` multipliers, announceWinner's 3×
callGasLimit, MAX_USEROP_GAS) stays in the frontend — pass it through your
manager's options; core deliberately doesn't hardcode it.

## Step 3 — reads (optional, incremental)

Apollo can stay. Point your documents at `@poa/core/graph/documents/*` so the
queries themselves can't drift, or adopt `GraphClient` where you don't need
Apollo's cache. `subgraphCapabilities.js` (introspection) and core's
field-fallback tiers solve the same problem — when a service moves to core
reads, it gets tiers for free and you can drop its capability checks.

## Environment wiring for Next.js

```ts
const ctx = createPopContext({
  chainId,
  env: { GRAPH_API_KEY: process.env.NEXT_PUBLIC_GRAPH_API_KEY },
  graph: { stateStore: localStorageTierStore },  // ~20 lines; TierStateStore interface
  ipfs: { apiUrl: IPFS_API },
});
```

## Order of adoption (lowest risk first)

1. ABIs + `chains` + `encoding` + `payout` + `perms` (pure, drop-in, kills the drift)
2. `metadata/*` builders (removes the 5× inline task-metadata duplication)
3. One domain service end-to-end (suggest tasks) via the Step-1 adapter
4. Remaining domains; then governance batches (`tx/governance`)
5. Reads, as each screen is touched

Each step is shippable on its own; nothing requires a flag day.
