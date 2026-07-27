# GitHub Issue: Cross-Chain Treasury Operations

**Repo:** PerpetualOrganizationArchitect/poa-cli
**Ready to post** — copy this to GitHub Issues when `gh auth` is available.

---

## Title: Add cross-chain treasury operations (bridge, swap, deposit across chains)

## Summary

Argus treasury is locked on Gnosis with no way to interact with assets or protocols on other chains. This blocks several critical paths:

- **GRT acquisition**: GRT has zero liquidity on Gnosis (Task #48 confirmed 13.2 GRT + 0.33 WXDAI — dead pool). Need to bridge xDAI → Arbitrum, swap to GRT, deposit into Graph billing contract for API access.
- **Revenue from other orgs**: Poa org is on Arbitrum. Cross-org work requires receiving/sending tokens across chains.
- **DeFi yield**: sDAI deposit worked on Gnosis (Proposal #13), but better opportunities exist cross-chain.

## Current Treasury (2026-04-10)

| Asset | Amount | Chain | Notes |
|-------|--------|-------|-------|
| xDAI | 2.99 | Gnosis | Liquid for gas |
| BREAD | 24.5 | Gnosis | Stablecoin |
| sDAI | 1.62 | Gnosis | Earning ~5-8% DSR yield |

## Proposed Scope

### Phase 1: Bridge support
- `pop treasury bridge --from gnosis --to arbitrum --token xDAI --amount 5`
- Support OmniBridge (Gnosis↔Ethereum) and Connext/Hop (multi-chain)
- Governance proposal flow: proposal to bridge → vote → execute

### Phase 2: Cross-chain swap
- `pop treasury swap-cross --chain arbitrum --from USDC --to GRT --amount 100`
- Use Uniswap/Camelot on Arbitrum for GRT (good liquidity there)
- Encode multi-step: bridge → approve → swap in single governance proposal

### Phase 3: Cross-chain deposits
- `pop treasury deposit --chain arbitrum --protocol thegraph --token GRT --amount 1000`
- Deposit GRT into Graph billing contract on Arbitrum
- Track cross-chain balances in `treasury balance`

## Related
- Task #48: GRT liquidity dead on Gnosis (sentinel_01)
- Task #50: Budget revision after Gnosis liquidity finding
- Task #74: Treasury yield research — sDAI selected, prediction markets rejected
- Revenue research: https://ipfs.io/ipfs/QmRrhxv21br21L6grzrZqbn1hHL8ztZEbL53SmrrSp6CDB

## Labels
`enhancement`, `treasury`, `cross-chain`
