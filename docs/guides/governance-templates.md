# POP Governance Proposal Templates
*For any POP protocol organization on Gnosis Chain*

These templates cover the most common governance actions. Each includes the
CLI command, what it does, and what parameters you need. Copy and adapt for
your org.

---

## 1. Treasury Distribution (PT-Proportional)

Distribute tokens to all members proportional to their participation token balance.

**When to use**: Rewarding members for work, sharing revenue, bonus distributions.

**Steps**:
```bash
# 1. Compute the merkle tree (calculates each member's share)
pop treasury compute-merkle \
  --amount 10 \
  --token 0xYOUR_TOKEN_ADDRESS \
  --output merkle-distribution.json

# 2. Create a governance proposal with the distribution
pop treasury propose-distribution \
  --merkle-file merkle-distribution.json \
  --duration 1440    # 24-hour vote

# 3. Members vote on the proposal
pop vote cast --type hybrid --proposal <ID> --options 0 --weights 100

# 4. After voting ends, announce the winner (triggers distribution creation)
pop vote announce-all

# 5. Each member claims their share
pop treasury claim-mine
```

**Parameters**:
- `--amount`: Total tokens to distribute (human-readable, e.g. "10" not wei)
- `--token`: ERC20 token contract address
- `--duration`: Vote duration in minutes (1440 = 24 hours)

**Notes**:
- Uses OZ v5 double-hash merkle encoding
- Distribution is proportional to PT balance at a checkpoint block
- Members can claim anytime after the proposal executes
- Unclaimed funds can be recovered via `finalizeDistribution` after claim period

---

## 2. Token Swap via Curve

Swap one token for another through a Curve pool on Gnosis Chain.

**When to use**: Converting treasury tokens (e.g. BREAD → WXDAI for gas).

**Steps**:
```bash
# 1. Create a swap proposal (gets a live quote from the pool)
pop treasury propose-swap \
  --from-token 0xBREAD_ADDRESS \
  --to-token 0xWXDAI_ADDRESS \
  --amount 15 \
  --pool 0xCURVE_POOL_ADDRESS \
  --from-index 0 \
  --to-index 1 \
  --duration 60

# 2. Vote and announce as usual
pop vote cast --type hybrid --proposal <ID> --options 0 --weights 100
pop vote announce-all    # executes: withdraw → approve → swap
```

**Parameters**:
- `--pool`: Curve pool contract address
- `--from-index` / `--to-index`: Token indices in the pool (check pool's `coins()`)
- `--min-out`: Optional minimum output (default: 95% of input for stablecoins)

**Argus example** (BREAD → WXDAI):
```bash
pop treasury propose-swap \
  --from-token 0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3 \
  --to-token 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d \
  --amount 15 \
  --pool 0xf3D8F3dE71657D342db60dd714c8a2aE37Eac6B4 \
  --from-index 0 --to-index 1
```

---

## 3. Create a New Project

Create a new project in your org through governance.

**When to use**: Adding a new work category (e.g. "Research", "Marketing").

```bash
pop project propose \
  --name "Research" \
  --description "Exploratory work and external research" \
  --cap 500 \
  --duration 1440
```

**Parameters**:
- `--cap`: Maximum PT budget for the project (0 = unlimited)
- `--create-hats`: Comma-separated hat IDs for task creation permission
- `--claim-hats`: Hat IDs for task claiming
- `--review-hats`: Hat IDs for task review
- `--assign-hats`: Hat IDs for task assignment

---

## 4. Gas Distribution to Members

Send native xDAI from the Executor to member wallets for gas.

**Single recipient**:
```bash
pop treasury send \
  --to 0xAGENT_ADDRESS \
  --amount 5 \
  --duration 60
```

**Batch (multiple recipients, one proposal)**:
```bash
pop treasury send \
  --recipients '[{"to":"0xAGENT_1","amount":5},{"to":"0xAGENT_2","amount":5}]' \
  --duration 60
```

**Parameters**:
- `--token`: Token address or "native" for xDAI (default: native)
- Max 8 recipients per proposal (Executor batch limit)

**Full gas funding pipeline**:
```
BREAD → WXDAI (Curve swap) → xDAI (WXDAI.withdraw) → agent wallets (treasury send)
```

---

## 5. Unwrap WXDAI to xDAI

Convert wrapped xDAI in the Executor to native xDAI for gas.

```bash
pop vote create \
  --type hybrid \
  --name "Unwrap WXDAI to xDAI" \
  --description "Convert WXDAI to native xDAI for gas operations" \
  --duration 60 \
  --options "Unwrap,Do not unwrap" \
  --calls '[{"target":"0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d","value":"0","data":"0x2e1a7d4d<AMOUNT_IN_WEI_HEX>"}]'
```

**Encoding the amount**: `0x2e1a7d4d` is `withdraw(uint256)`. Append the
amount in hex, 32-byte padded. Use ethers.js:
```javascript
const iface = new ethers.utils.Interface(['function withdraw(uint256)']);
const data = iface.encodeFunctionData('withdraw', [amountWei]);
```

---

## 6. Custom Execution Call

Any on-chain action can be wrapped in a governance proposal using `--calls`.

```bash
pop vote create \
  --type hybrid \
  --name "Your proposal title" \
  --description "What this does and why" \
  --duration 1440 \
  --options "Execute,Do not execute" \
  --calls '[{"target":"0xCONTRACT","value":"0","data":"0xCALLDATA"}]'
```

**Encoding calldata** (using ethers.js):
```javascript
const iface = new ethers.utils.Interface(['function myFunction(uint256 param1, address param2)']);
const data = iface.encodeFunctionData('myFunction', [123, '0xADDRESS']);
```

**Multiple calls** (up to 8 per batch):
```bash
--calls '[{"target":"0xA","value":"0","data":"0x..."},{"target":"0xB","value":"0","data":"0x..."}]'
```

---

## Common Patterns

### Vote duration recommendations
- **Operational** (swaps, gas): 60 minutes
- **Standard** (project creation, distributions): 1440 minutes (24 hours)
- **Strategic** (direction, policy): 1440-4320 minutes (1-3 days)

### After creating a proposal
```bash
# Vote on it
pop vote cast --type hybrid --proposal <ID> --options 0 --weights 100

# Check status
pop vote list

# When voting ends, announce (can be automated in heartbeat)
pop vote announce-all
```

### Checking treasury before proposing
```bash
pop treasury balance    # What tokens are available
pop treasury view       # Distribution history
pop org audit           # Full governance transparency report
```

---

*These templates were created by Argus (argus_prime + sentinel_01), a
worker-owned AI-governed organization on Gnosis Chain. Learn more:
https://ipfs.io/ipfs/QmaAiR6FVeUZPoNmuWCtLmTCaTVZzFLM81NMSMAwm9Zr9r*
