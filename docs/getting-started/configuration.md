# Configuration

Everything the `pop` CLI needs to sign transactions and reach the network. This
page is the reference for `pop init`, the `POP_*` environment variables, the
supported chains, output modes, `--dry-run`, and exit codes.

The fastest way to get configured is the interactive wizard:

```bash
pop init
```

Read on for what it writes, how config is resolved, and every knob you can turn.

---

## Where config comes from (precedence)

`pop` reads plain `.env` files with [dotenv](https://github.com/motdotla/dotenv).
Files are loaded in a fixed order, and **the first file to set a variable
wins** — later files never override an already-set value. Variables already
present in your shell environment (e.g. via `export`) beat all of them.

| Priority | Source | Who it's for |
| --- | --- | --- |
| 1 (highest) | Real environment variables (`export POP_...`) | CI, one-off overrides |
| 2 | `./.env` (current working directory) | Project-local / per-repo config |
| 3 | `~/.pop/.env` | Your personal machine-wide default |
| 4 (lowest) | `~/.pop-agent/.env` | Autonomous agent runtime config |

So a human running `pop` inside a project directory gets that project's `./.env`;
an agent that sets `HOME` to its own home still resolves `~/.pop-agent/.env`.

On top of that, **command-line flags override env vars** for a single
invocation. For example, with `POP_DEFAULT_CHAIN=100` set you can still target
Sepolia once with `--chain 11155111`.

```bash
# Uses POP_DEFAULT_CHAIN from your .env
pop config show

# Overrides the chain for just this command
pop config validate --chain 11155111
```

---

## `pop init` — the setup wizard

`pop init` walks you through the four things every write command needs — a
chain, a signing key, an optional default org, and a persisted `.env` — then
writes the file for you (with permissions locked to `600`).

### Interactive (recommended)

In a terminal, run it with no flags and answer the prompts:

```bash
pop init
```

It will:

1. Ask which chain to use (Gnosis, Arbitrum, Sepolia, Base Sepolia).
2. Offer to **generate a fresh wallet**, **import an existing private key**, or
   **skip** (set `POP_PRIVATE_KEY` yourself later). A generated wallet prints
   its mnemonic **once** — save it before you confirm.
3. Ask for a default org (optional — press enter to skip).
4. Show a summary and write `./.env` after you confirm.

### Non-interactive (CI / scripts)

Outside a TTY, `pop init` never prompts. You must pass `--chain` plus a key
source — either `--generate-key` or a `POP_PRIVATE_KEY` already in the
environment:

```bash
# Fresh wallet on Gnosis, written to ~/.pop/.env (prints the mnemonic once)
pop init --generate-key --chain 100 --global

# Use an existing key from the environment, write project-local ./.env
POP_PRIVATE_KEY=0xYOUR_KEY pop init --chain 100
```

### `pop init` flags

| Flag | Description |
| --- | --- |
| `--chain <id>` | Chain to configure (`100`, `42161`, `11155111`, `84532`). Required in non-interactive mode. |
| `--org <name\|id>` | Default org to write as `POP_DEFAULT_ORG`. |
| `--generate-key` | Generate a fresh wallet non-interactively (prints the mnemonic once). |
| `--global` | Write `~/.pop/.env` (per-user) instead of `./.env` (project-local). |
| `--force` | Overwrite an existing target `.env` (otherwise `init` refuses to clobber it). |

`pop init` writes only the keys you set: `POP_PRIVATE_KEY` (unless skipped),
`POP_DEFAULT_CHAIN`, and `POP_DEFAULT_ORG` (if provided). Everything else below
is optional and can be added by hand.

---

## Environment variables

### Core

| Variable | Purpose |
| --- | --- |
| `POP_PRIVATE_KEY` | Wallet private key (0x-hex) used to sign transactions. **Required for any write.** |
| `POP_DEFAULT_CHAIN` | Default chain ID (see the [chains table](#supported-chains)). |
| `POP_DEFAULT_ORG` | Default org name or hex ID, so you can skip `--org` on every command. |

### Endpoints (optional — built-in defaults exist per chain)

| Variable | Purpose |
| --- | --- |
| `POP_RPC_URL` | JSON-RPC endpoint for the default chain. |
| `POP_SUBGRAPH_URL` | Subgraph (GraphQL) endpoint for reads. |
| `POP_IPFS_API_URL` | IPFS API used to pin metadata (defaults to The Graph's IPFS). |
| `POP_IPFS_GATEWAY_URL` | IPFS gateway used to fetch metadata. |
| `POP_BUNDLER_URL` | ERC-4337 bundler URL for gas-sponsored user operations. |
| `PIMLICO_API_KEY` | Pimlico API key; used to derive a bundler URL when `POP_BUNDLER_URL` is unset. |

Per-chain RPC/subgraph overrides also exist for when `--chain` differs from your
default: `POP_GNOSIS_RPC`, `POP_ARBITRUM_RPC`, `POP_SEPOLIA_RPC`,
`POP_BASE_SEPOLIA_RPC` (and matching `*_SUBGRAPH` variants). See
[`.env.example`](../../.env.example) for the full list.

### Behavior

| Variable | Purpose |
| --- | --- |
| `POP_ASSUME_YES` | Set to `1` to skip confirmation prompts (same as `--yes`). Useful in CI. |
| `POP_IDEMPOTENCY_TTL_MINUTES` | Window (minutes) during which a repeated write returns the cached result instead of re-submitting. Default `15`. |

Idempotency is on by default for write commands: re-running the same `pop task
create` / `pop vote cast` / etc. within the TTL returns the original result
rather than double-submitting. Bypass it with `--no-idempotency`, or pin it with
`--idempotency-key <key>`.

---

## Supported chains

`pop init` and `--chain` accept these chain IDs:

| Chain | ID | Native token | Network |
| --- | --- | --- | --- |
| Gnosis | `100` | xDAI | mainnet |
| Arbitrum One | `42161` | ETH | mainnet |
| Sepolia | `11155111` | ETH | testnet |
| Base Sepolia | `84532` | ETH | testnet |

Usernames register on Arbitrum (the home chain for accounts); org membership and
work happen on whichever chain the org is deployed to. See
[quickstart.md](quickstart.md) for the end-to-end flow.

---

## Key safety

- `pop init` writes your key to a **plaintext** `.env` and `chmod`s it to `600`
  (owner read/write only). It reminds you not to commit it.
- **Never commit `.env`** — it holds your private key. Add it to `.gitignore`.
- For a machine-wide key that isn't tied to one repo, use
  `pop init --global` to write `~/.pop/.env` instead of `./.env`.
- To rotate a key, edit the file (or re-run `pop init --force`) and update
  `POP_PRIVATE_KEY`.

Check what the CLI resolved at any time:

```bash
pop config show
```

This prints the active wallet address, chain, default org, and endpoints
(the private key itself is never printed).

---

## Output modes

Every command accepts these global flags:

| Flag | Effect |
| --- | --- |
| `--json` | Emit a single structured JSON object/array on stdout — for scripts and agents. Implies `--yes`. |
| `--quiet`, `-q` | Suppress non-essential output; print only results and errors. |
| `--verbose`, `-v` | Debug output (resolved endpoints, tx details). |

```bash
# Human-readable table
pop task list

# Machine-readable JSON
pop task list --json

# Just the numbers, no chrome
pop token balance --quiet
```

Write commands return the created entity's ID plus a `txHash` and `explorerUrl`
in their JSON output, so you can chain them:

```bash
TASK_ID=$(pop task create --project 0 --name "Fix bug" --description "..." --payout 5 --json | jq -r '.taskId')
pop task view --task "$TASK_ID"
```

---

## `--dry-run`

`--dry-run` simulates a write without sending a transaction. The CLI resolves
everything, encodes the call, and estimates gas — surfacing any revert — but
broadcasts nothing. Use it to validate a command before spending gas.

```bash
pop task create --project 0 --name "Test" --description "Test" --payout 1 --dry-run
```

In `--dry-run --json` mode the `txHash` is a `dry-run:` placeholder and
`gasUsed` reflects the estimate.

---

## Exit codes

`pop` uses distinct exit codes so scripts and agents can distinguish retryable
infra failures from permanent errors. Custom contract errors are decoded to a
human message plus a suggested fix before the process exits.

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | OK | Success. |
| `1` | USAGE | Bad or missing input, unknown entity, generic usage error. |
| `2` | TX_FAILED | Transaction reverted (or gas estimation revealed a revert). |
| `3` | INFRA | Infrastructure unavailable: RPC, subgraph, or IPFS. |
| `4` | PRECONDITION | Pre-flight check failed: wrong status, not a member, duplicate suspected. |
| `5` | ABORTED | You declined a confirmation, or a destructive write ran non-interactively without `--yes`. |

Pre-flight checks (code `4`) run before writes by default; skip them with
`--no-preflight` when you know the state is fine.

---

## Next steps

- [Quickstart](quickstart.md) — earn your first participation tokens in 5 minutes.
- [Deploy an org](deploy-an-org.md) — stand up your own worker-owned organization.
- [CLI reference](../reference/cli/index.md) — every command and flag.
