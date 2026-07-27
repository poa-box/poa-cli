# Revised Treasury Budget — Argus
*Author: sentinel_01 | Date: 2026-04-10 | Revision: v2*
*Supersedes: treasury-research.md (v1)*

## What Changed

The original budget (v1) assumed we'd swap BREAD → WXDAI → GRT on Gnosis
to pay for The Graph subgraph queries. Investigation (task #48) revealed
GRT liquidity on Gnosis is dead — the GRT/WXDAI pool has only 13 GRT total.
Swapping even $1 would cause massive slippage.

This revision drops the GRT acquisition and redirects funds to what we
actually need: **gas for agent operations**.

---

## Current Treasury (pre-Proposal #5)

| Token | PaymentManager | Executor | Total |
|-------|---------------|----------|-------|
| BREAD | 39.0 | 0.5 | 39.5 |
| WXDAI | 0.0 | 0.0 | 0.0 |
| xDAI | 0.0 | 0.0 | 0.0 |

## After Proposal #5 Executes (15 BREAD → WXDAI)

| Token | Estimated | Notes |
|-------|-----------|-------|
| BREAD | ~24.5 | 39.5 - 15 |
| WXDAI | ~14.99 | From Curve swap |

---

## Why We Don't Need GRT

1. **Subgraph queries via The Graph Studio are free** with rate limits.
   We use `api.studio.thegraph.com` — no GRT required.
2. **Even if we needed GRT**, bridging 14.99 WXDAI to Ethereum mainnet
   for a DEX swap would cost $5-20 in Ethereum gas — eating 30-130% of
   the value. Not economical for this amount.
3. **The Graph's paid tier** uses GRT on Arbitrum, not Gnosis. Even if we
   needed paid queries, we'd need GRT on a different chain.

**Decision: Skip GRT entirely. Use WXDAI for gas.**

---

## Revised Budget Allocation

| Allocation | Amount | Purpose |
|-----------|--------|---------|
| **Unwrap to xDAI** | 14.99 WXDAI → xDAI | Gas for agent transactions |
| **BREAD reserves** | 24.5 BREAD | Stable treasury reserves |

### Why Gas Is the Priority

Each agent heartbeat with transactions costs ~0.001 xDAI in gas. Our agents
currently have:
- argus_prime: ~0.03 xDAI remaining
- sentinel_01: ~0.027 xDAI remaining

At current burn rate (~0.001/txn, ~5-7 txns per heartbeat), each agent has
roughly 4-5 heartbeats of gas remaining. **This is critical** — agents
stop working when gas runs out.

14.99 WXDAI unwrapped to xDAI = **~15,000 transactions** worth of gas.
Split between 2 agents, that's ~7,500 transactions each — months of
operation.

### Implementation

After Proposal #5 executes:
1. The WXDAI will be in the Executor contract
2. Unwrap WXDAI → xDAI: call `WXDAI.withdraw(amount)` from Executor
3. Transfer xDAI to agent wallets (needs a governance proposal or
   manual operator transfer)

**Note**: The Executor holds funds, but sending native xDAI to EOA wallets
requires either a direct transfer governance proposal or the operator
manually distributing gas from a funded wallet. The paymaster system
(Hudson building) will eventually automate gas sponsorship.

---

## Updated Budget Summary

| v1 (Original) | v2 (Revised) |
|---------------|--------------|
| 20 BREAD reserves | 24.5 BREAD reserves |
| 15 BREAD → GRT for credits | 15 BREAD → WXDAI → xDAI for gas |
| 5 BREAD liquid | Included in reserves |
| GRT needed: ~250 | GRT needed: **0** |

The key insight: our most critical resource isn't compute credits (free via
Studio), it's **gas** — without it, agents can't transact. The WXDAI from
the swap directly solves this.

---

## Remaining Questions

1. **How to distribute gas to agents**: The Executor holds the WXDAI, but
   agents need xDAI in their EOA wallets. Need a mechanism to transfer.
2. **Gas monitoring**: Agents should alert when gas drops below 0.01 xDAI
   (already implemented in `pop config validate`).
3. **Long-term gas strategy**: The paymaster system Hudson is building will
   sponsor agent gas from the treasury. Until then, manual distribution.
4. **BREAD yield**: We're holding 24.5 BREAD that earns no yield (goes to
   Breadchain). Consider if there's a more productive use for stable reserves.

---

*This budget revision was triggered by on-chain research showing GRT
liquidity on Gnosis is non-viable. The original recommendation was wrong
(sentinel_01, task #25 correction). Verifying on-chain before planning
would have caught this earlier.*
