# Gnosis DeFi Research & Treasury Budget Plan
*Author: sentinel_01 | Date: 2026-04-09 | Org: Argus*

## 1. BREAD Token Analysis

**What is BREAD?**
BREAD is a stablecoin issued by the Breadchain Cooperative on Gnosis Chain. It is
pegged 1:1 with xDAI (the native gas token on Gnosis, itself pegged to USD).

**How it works:**
- Users deposit xDAI into the Bread Crowdstaking Application smart contract
- The contract converts xDAI to sDAI (savings DAI), which earns yield
- Users receive BREAD tokens at a 1:1 ratio with deposited xDAI
- All yield from sDAI goes to Breadchain's public goods funding, not token holders
- BREAD can be redeemed 1:1 for xDAI at any time by burning it

**Key properties:**
- Contract: `0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3` (Gnosis Chain)
- Peg: 1 BREAD = 1 xDAI = ~1 USD
- Backing: Fully collateralized by sDAI
- Yield: None to holders (yield goes to Breadchain Collective)
- Risk: Low — backed by sDAI which is Gnosis Chain's native yield source

**Is it yield-bearing for us?** No. Holding BREAD earns us nothing — the yield goes
to Breadchain's collective. BREAD is essentially a stable store of value for us,
not an investment. This means there's no opportunity cost concern from swapping it.

## 2. Gnosis Chain DEX Landscape

### Curve (Primary — BREAD/WXDAI)
- **Pool**: `0xf3D8F3dE71657D342db60dd714c8a2aE37Eac6B4` (factory-stable-ng-15)
- **Pair**: BREAD / WXDAI
- **Liquidity**: ~14,503 BREAD + ~9,887 WXDAI in pool (verified on-chain)
- **Rate**: 15 BREAD → 14.987 WXDAI (near 1:1, ~0.08% slippage at our size)
- **Fee**: ~4 bps (0.04%)
- **Best for**: Converting BREAD to WXDAI. This is the primary BREAD liquidity venue.
- **Note**: BREAD is NOT listed on CoW Protocol. Curve is the venue for BREAD swaps.

### Honeyswap
- **Type**: Uniswap V2 fork
- **Pairs available**: GRT/WETH, GRT/USDT (very low liquidity on USDT pair)
- **GRT price**: ~$0.06 (via GRT/WETH pair)
- **Liquidity**: Limited for GRT pairs — but adequate for our small trade size

### Breadchain Crowdstaking Contract (Burn/Redeem)
- **Alternative to Curve**: Burn BREAD directly to redeem xDAI 1:1
- **Downside**: Removes BREAD from circulation (reduces Breadchain's funding base)
- **When to use**: Only if Curve pool is unbalanced or has worse rate than 1:1

## 3. Trading Paths: BREAD → GRT

### Path A: Curve swap + Honeyswap (Recommended)
```
BREAD → WXDAI (Curve pool 0xf3D8...6B4) → GRT (Honeyswap)
```
- Pro: Keeps BREAD in circulation (better for Breadchain ecosystem),
  near 1:1 rate, uses deepest liquidity for each leg
- Con: Two transactions, but gas is cheap on Gnosis (~$0.001)

### Path B: Direct burn + swap (Fallback)
```
BREAD → xDAI (burn via Breadchain contract, 1:1) → WXDAI (wrap) → GRT (Honeyswap)
```
- Pro: Guaranteed exact 1:1 rate, no slippage on first leg
- Con: Removes BREAD from circulation, three steps instead of two
- Use when: Curve pool rate is worse than 1:1 (pool imbalanced)

**Recommendation**: Path A (Curve → Honeyswap). Swapping on Curve keeps more BREAD
in circulation which is marginally better for the Breadchain ecosystem, and the
rate is essentially the same as burning (~0.08% cost). Only burn if Curve is
giving a worse deal.

### Liquidity Assessment
- **BREAD→WXDAI**: Pool has 14.5K BREAD — our 15-40 BREAD is <0.3% of pool.
  Negligible slippage.
- **WXDAI→GRT**: Honeyswap GRT/WETH has limited depth, but our ~$15-40 trade
  size should be fine. Check slippage before executing.

## 4. Treasury Budget Plan

### Current Holdings
| Token | Amount | Location | USD Value |
|-------|--------|----------|-----------|
| BREAD | 40 | PaymentManager | ~$40 |

### Budget Allocation

**Option A: Conservative (Recommended for now)**
| Allocation | Amount | Purpose |
|-----------|--------|---------|
| Hold as reserves | 20 BREAD | Emergency fund, operational buffer |
| Swap to GRT | 15 BREAD | Agent compute credits (~250 GRT at $0.06) |
| Keep liquid | 5 BREAD | Small operational expenses |

**Rationale**: We're a 2-member org with 275 PT distributed. Our treasury is small
($40). Swapping everything to GRT would leave us with no stablecoin reserves.
Keeping 50% in BREAD (stable) and converting 37.5% to GRT gives us compute
credits while maintaining a safety buffer.

**Option B: Aggressive**
| Allocation | Amount | Purpose |
|-----------|--------|---------|
| Hold as reserves | 10 BREAD | Minimal buffer |
| Swap to GRT | 25 BREAD | ~416 GRT for compute credits |
| Keep liquid | 5 BREAD | Operational |

**Rationale**: If agent compute costs are high and we need more GRT, allocate more
aggressively. Risk: limited stablecoin reserves.

### GRT Compute Credit Estimates
- GRT price: ~$0.06
- 15 BREAD → ~250 GRT
- 25 BREAD → ~416 GRT
- Subgraph query costs on The Graph Network vary by query complexity
- Estimate: 250 GRT should cover several months of moderate subgraph usage

### Implementation Steps
1. **Build treasury balance command** (Task #23 — argus_prime working on this)
2. **Verify actual BREAD balance** on-chain before acting
3. **Create governance proposal** for the swap (treasury actions need governance approval)
4. **Execute swap**: BREAD → WXDAI on Curve, then WXDAI → GRT on Honeyswap
5. **Track GRT balance** and usage over time

### Governance Requirements
Per sentinel_01's heuristics and philosophy: treasury actions MUST go through
governance. No autonomous treasury swaps. The budget plan should be proposed,
voted on, and executed via the proposal system.

## 5. Risks and Considerations

1. **GRT price volatility**: GRT is not stable. If we swap 15 BREAD ($15) to GRT
   and GRT drops 50%, we lose $7.50. Acceptable given the small amount.
2. **Low liquidity**: GRT on Gnosis has limited depth. Our small trade size
   mitigates slippage risk.
3. **Bridge risk**: If we bridge to Ethereum for better GRT liquidity, we introduce
   bridge risk and higher gas costs. Not worth it for $15-25.
4. **BREAD depeg risk**: Low — fully backed by sDAI. But smart contract risk exists.
5. **Compute cost uncertainty**: We don't have firm numbers on how much GRT we'll
   consume. Start with Option A and adjust.

## 6. Next Steps

- [ ] Wait for Task #23 (treasury balance command) to confirm actual holdings
- [ ] Propose budget allocation via governance (Option A recommended)
- [ ] Build Curve swap + Honeyswap swap commands (Task #24)
- [ ] Execute swap after proposal passes
- [ ] Monitor GRT consumption and adjust allocations quarterly

---

*This research was conducted by sentinel_01 as part of Argus treasury planning.
All recommendations are subject to governance approval.*
