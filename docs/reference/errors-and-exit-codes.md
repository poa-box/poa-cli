# Errors & Exit Codes

Every `pop` command follows the same failure contract: a human-readable
message, an optional actionable suggestion, and a stable process **exit code**.
Write commands additionally carry a machine-readable **error code** in their
JSON output. This page is the reference for both, plus retry guidance and the
`--dry-run` / idempotency safety nets.

## Exit codes

`pop` exits with one of six codes. Scripts and agents should branch on these
rather than parsing message text.

| Code | Name | Meaning | Typical cause |
|---|---|---|---|
| `0` | OK | Success | The transaction landed, or the read returned. |
| `1` | USAGE | Bad or missing input, unknown entity, generic usage error | Missing required flag, malformed JSON, unknown task/proposal ID. |
| `2` | TX_FAILED | Transaction reverted, or gas estimation revealed a revert | A contract `require`/custom-error rejected the call. |
| `3` | INFRA | Infrastructure unavailable | RPC, subgraph, or IPFS unreachable or syncing. |
| `4` | PRECONDITION | A pre-flight check failed before any transaction was sent | Wrong task status, not a member, insufficient gas, suspected duplicate. |
| `5` | ABORTED | You declined a confirmation, or a non-TTY destructive write ran without `--yes` | Answered "no" at a prompt, or scripted a destructive command without `-y`. |

The source of truth is `src/lib/exit-codes.ts`. Exit `4` (PRECONDITION) is the
one to love: pre-flight catches *knowable* failures (not a member, module
missing, task in the wrong state, gas too low) **before** spending gas, so a
failed write costs nothing. Skip pre-flight with `--no-preflight` if you want
the raw on-chain behavior.

## Transaction error codes

When a write fails, `pop --json` includes an `errorCode` field. These come from
`src/lib/tx.ts` (`classifyError`) and classify the raw provider/ethers error:

| `errorCode` | Exit | What happened | What to do |
|---|---|---|---|
| `TX_REVERTED` | 2 | The contract reverted the call. Custom errors are decoded (see below). | Read the decoded reason + suggestion; fix state/permissions, then retry. |
| `GAS_ESTIMATION_FAILED` | 2 | Gas estimation itself reverted — the tx *would* revert if sent, so it never left your machine. | Same as a revert: the message includes the decoded reason. Nothing was submitted. |
| `INSUFFICIENT_FUNDS` | 3 | The wallet can't cover gas (+ any value). | Fund the wallet, or route the write through gas sponsorship (see [gas-sponsorship.md](../guides/gas-sponsorship.md)). |
| `USER_REJECTED` | 5 | A signer/wallet rejected the transaction. | Re-run and approve, if intended. |
| `NETWORK_ERROR` | 3 | RPC/network fault (`ECONNREFUSED`, server error, timeout). | Check `--rpc` / connectivity; retry (this class is safe to retry — see below). |
| `CONTRACT_ERROR` | 2 | A contract-level failure that isn't a plain revert string. | Inspect the decoded error name/args. |
| `UNKNOWN_ERROR` | 1 | Unclassified failure. | Re-run with `--verbose` to see the raw error. |

### Sponsored (ERC-4337) transactions

A gas-sponsored UserOperation is special: the **outer** bundler transaction can
succeed (`status = 1`) even when the **inner** call reverts. `pop` detects this
by parsing the EntryPoint's `UserOperationEvent` log and reports it as a
`TX_REVERTED` failure with the decoded inner revert reason and a `sponsored:
true` flag — so a sponsored failure never masquerades as success.

## Decoded custom errors

POP contracts use Solidity **custom errors** (a 4-byte selector, not a revert
string). `pop` decodes them automatically via the error catalog
(`src/lib/error-catalog.ts`), which is built from every checked-in
`src/abi/*.json` and covers ~200 distinct error names. A drift test keeps the
catalog in sync with the ABIs.

A decoded revert surfaces three things:

1. **The error name** — e.g. `BadStatus`, `Unauthorized`, `VouchingRateLimitExceeded`.
2. **A human message** — what it means in plain language.
3. **A suggestion** — the exact command to inspect or fix state, when one exists.

For example, claiming a task that isn't open decodes to:

```text
Error: Task is not in a status that allows this action.
  → Check the current task status with: pop task view <id>
```

You can preview this without spending gas by simulating the write:

```bash
pop task claim --task 0 --dry-run
```

Unrecognized selectors degrade gracefully to
`UnknownCustomError(0x…)` rather than a raw hex dump. A few high-frequency
examples (the catalog is exhaustive):

| Error name | Meaning | Suggested fix |
|---|---|---|
| `Unauthorized` | Your hat/role lacks the required TaskManager permission bit. | `pop org roles` / `pop task perms show` |
| `BadStatus` | Task isn't in a state that allows this action. | `pop task view <id>` |
| `NotMember` | You aren't a member of this org. | `pop user join` |
| `AlreadyVoted` | You already voted on this proposal. | `pop vote list --unvoted` |
| `VotingOpen` | The voting period hasn't ended yet. | Wait, then `pop vote announce` |
| `InvalidAnswer` | Wrong quiz answer for an education module. | Review the module and retry. |
| `VouchingRateLimitExceeded` | Hit the daily vouch limit (default 3/day). | `pop vouch status`; retry tomorrow. |
| `InvalidProof` | Merkle proof doesn't verify against the distribution root. | Re-check index/amount/proof; prefer `pop treasury claim-mine`. |
| `TransfersDisabled` | Participation tokens are non-transferable by design. | Earn PT via tasks/education/token requests instead. |
| `OrgNotRegistered` | The org isn't registered with the paymaster. | `pop paymaster register` / `pop paymaster deposit` |

## Retry guidance

Not every failure is safe to blindly retry — retrying a write that actually
landed is how duplicate on-chain state gets created.

| Failure class | Safe to retry? | Notes |
|---|---|---|
| `NETWORK_ERROR`, `INFRA` (exit 3) | Yes | Nothing was submitted; the fault is transport-side. |
| `GAS_ESTIMATION_FAILED` (exit 2) | Yes, after fixing state | Estimation reverted, so no tx was sent. Fix the underlying condition first. |
| `PRECONDITION` (exit 4) | Yes, after fixing the precondition | No tx was sent. |
| `TX_REVERTED` (exit 2) | Only after fixing state | The tx was sent and rejected on-chain. Retrying the same call reverts identically. |
| Timeout / ambiguous (no clear result) | **Verify first** | The write may have landed. Check on-chain state before re-issuing — this is exactly what the idempotency cache guards against. |
| `USER_REJECTED` (exit 5) | Yes | Re-run and approve. |

### Idempotency: retry safety for writes

Most write commands are wired to a file-backed **idempotency cache**
(`src/lib/idempotency.ts`). Within a TTL window (default **15 minutes**), a
second identical write returns the *prior* result instead of submitting a new
transaction. This exists to defuse the "read an empty stdout → assume it failed
→ retry → two identical proposals" failure mode.

- **Key derivation** — auto-derived from a hash of the full argv, with transient
  fields (`--private-key`, `--dry-run`, `--yes`, `--json`, `--verbose`, …)
  stripped so they never fork a cache entry.
- **`--idempotency-key <str>`** — override the auto key. Use it to treat two
  structurally different commands as the same logical action, or two identical
  commands as different actions.
- **`--no-idempotency`** — bypass the cache entirely. Use only when you
  *intend* a duplicate write.
- **`POP_IDEMPOTENCY_TTL_MINUTES`** — override the 15-minute TTL (env var).
  Priority: explicit param → this env → 15 min. Non-positive values fall
  through to the default.
- **Storage** — `$POP_AGENT_HOME/idempotency-cache.json` (defaults to
  `~/.pop-agent/`), one cache per agent home, hand-inspectable JSON.

Caveats: the cache is *local* — two different wallets/homes have separate
caches — and truly concurrent retries can still race. It is defense-in-depth,
not a distributed lock. See `src/lib/idempotency.ts` for the full rationale.

### `--dry-run`

Every write accepts `--dry-run`: it runs gas estimation (which surfaces any
decoded revert) and prints the calldata, but sends **zero transactions** and
neither consults nor records the idempotency cache. It is the safest way to
validate a command — including `pop org deploy --dry-run --yes`, which
validates the config and estimates deployment cost without deploying.

```bash
# See exactly what would happen — no tx, no state change
pop vote create --type hybrid --name "Test" --description "..." \
  --duration 60 --options "Yes,No" --dry-run
```

## JSON error shape

With `--json`, a failed write emits a structured object. Fields present depend
on the failure, but the common ones are:

| Field | Description |
|---|---|
| `errorCode` | One of the transaction error codes above. |
| `errorName` | Decoded custom-error name (e.g. `BadStatus`), when applicable. |
| `errorArgs` | Decoded arguments from the custom error, when present. |
| `suggestion` | The actionable next step from the error catalog. |
| `sponsored` | `true` when the failure was an inner UserOp revert. |

## Related

- [reference/cli/index.md](cli/index.md) — global flags (`--json`, `--dry-run`, `--yes`, `--verbose`, `--no-preflight`, …) and the full command tree.
- [reference/org-deploy-config.md](org-deploy-config.md) — deploy config schema.
- [getting-started/configuration.md](../getting-started/configuration.md) — env precedence (`./.env` → `~/.pop/.env` → `~/.pop-agent/.env`), keys, chains.
- [guides/gas-sponsorship.md](../guides/gas-sponsorship.md) — avoiding `INSUFFICIENT_FUNDS` with sponsored transactions.
