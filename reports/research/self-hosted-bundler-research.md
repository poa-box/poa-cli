# Self-Hosted ERC-4337 Bundler for Argus Agent Gas Sponsorship

**Author:** argus_prime
**Date:** 2026-04-16 (Task #417)
**Goal:** Replace paid Pimlico bundler with a self-hosted bundler on Hudson's machine

---

## 1. Current Setup

The 3 Argus agents use EIP-7702 + ERC-4337 for gas-sponsored transactions:

```
Agent CLI → EOADelegation.execute() wrapper → UserOp via Pimlico bundler
  → PaymasterHub pays gas → target contract executes
```

**Key integration points** (`src/lib/sponsored.ts`):
- `createPimlicoClient` from `permissionless/clients/pimlico`
- EntryPoint v0.7 (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`)
- Pimlico URL: `https://api.pimlico.io/v2/100/rpc?apikey=${PIMLICO_API_KEY}`
- EIP-7702 authorization lists passed in UserOp's `authorization` field
- PaymasterHub at `0xdEf1038C297493c0b5f82F0CDB49e929B53B4108` (Gnosis)

**Volume:** ~50 tx/day across 3 agents. Very low load.

---

## 2. Bundler Evaluation

### Evaluated

| Bundler | Language | EP v0.7 | EIP-7702 | Gnosis | Standalone | License | Stars | Status |
|---------|----------|---------|----------|--------|------------|---------|-------|--------|
| **Skandha** | TypeScript/Bun | YES | YES (EF grant) | YES (explicit) | YES | MIT | 611 | Active (Jan 2026) |
| **Voltaire** | Python/Rust | YES | YES (`--eip7702`) | Config | No (debug API) | LGPL-3.0 | 56 | Active |
| **Rundler** | Rust | YES | Partial | Config | No (debug API) | LGPL/GPL | 381 | Active (Feb 2025) |
| **Alto** | TypeScript | YES | YES | Config | `--safe-mode false` | GPL-3.0 | 218 | Active |
| eth-infinitism | TypeScript | YES | YES | Config | **No (needs Geth)** | GPL-3.0 | 388 | Slow |
| stackup | Go | No (v0.6 only) | No | - | - | GPL-3.0 | 244 | **ARCHIVED** |
| silius | Rust | No (v0.6 only) | No | No | - | Apache/MIT | 271 | Stalled |

### Eliminated

- **stackup-bundler**: Archived Oct 2024, read-only, no v0.7, no EIP-7702.
- **silius**: No EntryPoint v0.7, no EIP-7702, no Gnosis Chain support.
- **eth-infinitism reference**: Requires a Geth full node — non-starter for a MacBook.

---

## 3. Recommendation: Skandha (etherspot/skandha)

**Skandha checks every box:**

- **Explicit Gnosis Chain support** with Nethermind compatibility (Gnosis Chain's primary client). Not just "configurable" — tested and documented.
- **Explicit EIP-7702 support** funded by an Ethereum Foundation grant. This is the critical filter — our agents use EIP-7702 delegation.
- **Standalone mode** — no full node or `debug_traceCall` required. Runs against a public RPC.
- **TypeScript/Bun** — same language as our codebase, easy to debug if issues arise.
- **MIT license** — most permissive of all candidates.
- **Most active community** — 611 stars, 186 releases, actively maintained.
- **Lightweight** — Bun runtime, ~100MB memory for low-volume use.

**Runner-up: Voltaire** — simplest Docker deployment (`docker run` one-liner with `--eip7702`), but requires a debug-API-capable RPC node.

**Zero-code-change option: Alto (Pimlico's own bundler)** — since our code uses `createPimlicoClient`, self-hosting Alto means changing one URL string. But self-hosting docs are thin.

---

## 4. Gnosis Chain Specifics

- **EntryPoint v0.7** is deployed on Gnosis at `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (same address as all chains).
- **EIP-1559**: Gnosis supports EIP-1559 gas pricing. Skandha handles this natively.
- **RPC**: Public RPCs (`https://rpc.gnosischain.com`) work for standalone mode. For higher reliability, use a dedicated endpoint (Ankr, BlockPI, or a self-hosted Nethermind node — but not required at our volume).
- **EIP-7702**: Gnosis supports EIP-7702 (Pectra features). Our agents already use it via Pimlico — switching bundlers doesn't change the chain-level support.

---

## 5. Architecture

```
                    ┌─────────────┐
                    │  Agent CLI  │
                    │ sponsored.ts│
                    └──────┬──────┘
                           │ UserOp (JSON-RPC)
                           ▼
                    ┌─────────────┐
                    │   Skandha   │
                    │ :14337/rpc  │  ← self-hosted, localhost
                    └──────┬──────┘
                           │ eth_sendTransaction (type-4 with 7702 auth)
                           ▼
                    ┌─────────────┐
                    │ Gnosis RPC  │
                    │  (public)   │
                    └──────┬──────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  EntryPoint v0.7       │
              │  0x00000000717...      │
              ├────────────────────────┤
              │  PaymasterHub          │
              │  0xdEf1038C29...       │
              │  (validates org+hat,   │
              │   pays gas)            │
              ├────────────────────────┤
              │  Target Contract       │
              │  (TaskManager, etc.)   │
              └────────────────────────┘
```

---

## 6. Resource Requirements

For 3 agents at ~50 tx/day (very low volume):

| Resource | Requirement |
|----------|------------|
| CPU | Minimal — <5% of a modern MacBook core |
| Memory | ~100-200MB (Bun + Skandha worker) |
| Disk | <50MB (no blockchain state stored) |
| Network | Public RPC — no local node needed |
| Ports | 14337 (configurable, localhost only) |

Skandha in standalone mode is lighter than a browser tab. It runs comfortably alongside the 3 agent processes.

---

## 7. Migration Path

### Step 1: Install and run Skandha

```bash
# Clone and build
git clone https://github.com/etherspot/skandha.git
cd skandha
bun install
cp config.json.default config.json
```

Edit `config.json` for Gnosis:
```json
{
  "entryPoints": ["0x0000000071727De22E5E9d8BAf0edAc6f37da032"],
  "rpcEndpoint": "https://rpc.gnosischain.com",
  "minBalance": "1000000000000000",
  "relayers": ["<RELAYER_PRIVATE_KEY>"],
  "port": 14337
}
```

The **relayer key** is important: Skandha needs a funded account to submit bundle transactions. This can be a separate key from the agents — it just needs xDAI for gas to submit the bundles to the chain. The PaymasterHub refunds the gas via the EntryPoint, but the relayer fronts it.

```bash
# Start
bun run standalone --unsafe
```

Or via Docker:
```bash
docker run -d \
  --name skandha \
  -p 14337:14337 \
  -v $(pwd)/config.json:/app/config.json \
  ghcr.io/etherspot/skandha:latest \
  standalone --unsafe
```

### Step 2: Update CLI config

Change `PIMLICO_API_KEY` to `POP_BUNDLER_URL` (or keep Pimlico as fallback):

In `src/lib/sponsored.ts`, the only change is the URL:
```typescript
// Before
const pimlicoUrl = `https://api.pimlico.io/v2/${gnosis.id}/rpc?apikey=${apiKey}`;

// After (self-hosted)
const bundlerUrl = process.env.POP_BUNDLER_URL || `https://api.pimlico.io/v2/${gnosis.id}/rpc?apikey=${apiKey}`;
```

The `createPimlicoClient` function works with ANY ERC-4337 compliant bundler URL — it's just a thin wrapper around standard JSON-RPC calls (`eth_sendUserOperation`, `eth_estimateUserOperationGas`, etc.). Alternatively, switch to viem's native `createBundlerClient` to remove the Pimlico dependency entirely.

### Step 3: Test

```bash
export POP_BUNDLER_URL=http://localhost:14337/rpc
pop config validate --json  # health check
pop task create --name "test" --project "Docs" --payout 1 --dry-run  # dry-run sponsored tx
```

---

## 8. Risks and Blockers

| Risk | Severity | Mitigation |
|------|----------|------------|
| Relayer key needs xDAI funding | Low | Small amount (~0.5 xDAI) covers weeks of usage. PaymasterHub refunds via EntryPoint. |
| Skandha's `--unsafe` mode skips validation | Medium | Acceptable for a trusted local setup (agents are our own). Production clusters would need safe mode. |
| EIP-7702 auth list handling may differ from Pimlico | Medium | Test with a real sponsored tx before switching. Pimlico wraps auth lists in type-4 txs; Skandha should do the same but needs empirical verification. |
| Public RPC rate limits | Low | 50 tx/day is well within free tier limits. Use Ankr/BlockPI backup if needed. |
| Skandha Bun runtime may conflict with Node.js | Low | Separate processes, no conflict. Bun installs alongside Node. |
| Process monitoring | Low | Use a simple process manager (pm2, systemd, or launchd on macOS) to auto-restart Skandha if it crashes. |

### Critical verification before switching

Before disabling Pimlico, run this test:
1. Start Skandha locally with `--unsafe`
2. Point `POP_BUNDLER_URL` at localhost
3. Send a real sponsored `pop task create` (not dry-run)
4. Verify the UserOp lands on-chain with the PaymasterHub paying gas
5. Check that the EIP-7702 authorization list is properly included

If step 4-5 work, the migration is safe.

---

## 9. Prototype Startup Script

```bash
#!/bin/bash
# start-bundler.sh — run Skandha bundler for Argus agents
# Place in ~/.pop-agent/start-bundler.sh

set -euo pipefail

SKANDHA_DIR="${HOME}/skandha"
CONFIG="${SKANDHA_DIR}/config.json"

if [ ! -d "$SKANDHA_DIR" ]; then
  echo "Cloning Skandha..."
  git clone https://github.com/etherspot/skandha.git "$SKANDHA_DIR"
  cd "$SKANDHA_DIR"
  bun install
else
  cd "$SKANDHA_DIR"
fi

# Generate config if not exists
if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" << 'CONF'
{
  "entryPoints": ["0x0000000071727De22E5E9d8BAf0edAc6f37da032"],
  "rpcEndpoint": "https://rpc.gnosischain.com",
  "minBalance": "1000000000000000",
  "port": 14337
}
CONF
  echo "Created config at $CONFIG"
  echo "IMPORTANT: Add a funded relayer key to config.json before starting!"
  exit 1
fi

echo "Starting Skandha bundler on :14337..."
exec bun run standalone --unsafe
```

---

## 10. Summary

| What | Current (Pimlico) | Self-hosted (Skandha) |
|------|-------------------|----------------------|
| Cost | Pimlico API subscription | Free (open source) |
| Latency | ~200ms (remote API) | ~10ms (localhost) |
| Control | Pimlico controls uptime | Full local control |
| Setup | API key in .env | Skandha process + relayer key |
| Dependency | Pimlico service availability | Local process stability |
| Code change | None | 1 line (URL swap) |

**Recommendation: Deploy Skandha, keep Pimlico as fallback.** Add `POP_BUNDLER_URL` env var that defaults to Pimlico if not set. When Skandha is running locally, set `POP_BUNDLER_URL=http://localhost:14337/rpc`. If Skandha goes down, unset the var and Pimlico takes over.
