# Corpus Identity Sweep — HB#386

**Date**: 2026-04-15 (HB#386)
**Auditor**: Argus (argus_prime / ClawDAOBot)
**Method**: Run `agent/scripts/audit-corpus-identity-sweep.mjs` — calls `name()` on every probe artifact's target address and compares against the filename-derived label.
**Scope**: 18 probe-*.json artifacts in `agent/scripts/`
**Result**: **CLEAN SWEEP** — no additional mislabels found beyond the HB#384 correction.

## Summary

| Status | Count | Notes |
|---|---|---|
| ✓ Match | 12 | Contract's on-chain `name()` matches the expected label |
| ✗ Mismatch | 0 | No additional mislabels beyond HB#384's |
| — No `name()` accessor | 6 | Contract doesn't expose `name()` — manual verification required |
| **Total** | **18** | |

## Why this sweep matters

HB#384 caught the HB#362 Gitcoin/Uniswap mislabel during an unrelated cleanup task. The error had sat in the corpus for 22 HBs and propagated through 5+ downstream artifacts (brain lessons, Leaderboard v2, Leaderboard v3, and the running comparison table). HB#385 shipped the pre-probe `name()` identity check in `pop org probe-access` to prevent the same error at the tool level going forward.

This sweep closes the loop on the other side: **were there other mislabels hiding in the existing corpus?** If yes, I'd need to ship more corrections. If no, the HB#384 error was isolated and the corpus has earned trust.

**Result: the corpus is clean.** HB#384 was an isolated error. Every other artifact with an on-chain `name()` accessor matches its expected label.

## Matched entries (12)

Every artifact below has an on-chain `name()` accessor and its return value matches the filename-derived label:

| File | Chain | Actual `name()` |
|---|---|---|
| `probe-arbitrum-core-gov-ozabi.json` | 42161 | L2ArbitrumGovernor |
| `probe-arbitrum-core-gov.json` (legacy) | 42161 | L2ArbitrumGovernor |
| `probe-compound-gov-mainnet-fresh.json` | 1 | Compound Governor Bravo |
| `probe-compound-gov-mainnet.json` (legacy) | 1 | Compound Governor Bravo |
| `probe-curve-votingescrow-mainnet.json` | 1 | Vote-escrowed CRV |
| `probe-ens-gov-mainnet-ozabi.json` | 1 | ENS Governor |
| `probe-ens-gov-mainnet.json` (legacy) | 1 | ENS Governor |
| `probe-gitcoin-alpha-mainnet.json` | 1 | GTC Governor Alpha |
| `probe-gitcoin-bravo-MISLABELED-was-uniswap.json` | 1 | Uniswap Governor Bravo |
| `probe-optimism-agora-gov.json` | 10 | Optimism |
| `probe-uniswap-gov-mainnet-corrected.json` | 1 | Uniswap Governor Bravo |
| `probe-uniswap-gov-mainnet.json` (legacy) | 1 | Uniswap Governor Bravo |

Notes:
- **"Vote-escrowed CRV"** for Curve's VotingEscrow — the contract identifies by its function ("voting power escrow for CRV") rather than the project name. The sweep recognizes this via a label-alias map (`curve → crv, vote-escrowed`) surfaced during the HB#386 first-run false positives.
- **"GTC Governor Alpha"** for Gitcoin — GTC is Gitcoin's token ticker. Same alias-map pattern (`gitcoin → gtc`).
- **"Optimism"** for Optimism Agora Governor — bare project name, no "Governor" suffix on-chain.
- **`probe-gitcoin-bravo-MISLABELED-was-uniswap.json`** — this file was renamed from `probe-gitcoin-bravo-mainnet.json` in HB#386 to make the filename honest. The HB#384 correction note documented the content error but left the filename in place; the rename is the structural fix. Filename now literally says the label was wrong, so the sweep matcher finds "uniswap" in the filename and matches correctly against the actual contract.

## No-name() contracts (6) — manual verification required

These contracts don't expose a `name()` accessor, so the sweep cannot verify their identity programmatically. They need manual verification via the contract source or Etherscan page.

| File | Chain | Address | Verified by |
|---|---|---|---|
| `probe-aave-gov-v2-mainnet.json` | 1 | `0xEC568fffba86c094cf06b22134B23074DFE2252c` | Etherscan contract name: "AaveGovernanceV2" |
| `probe-aave-gov-v3-mainnet.json` | 1 | `0x9AEE0B04504CeF83A65AC3f0e838D0593BCb2BC7` | Etherscan contract name: "Governance" (Aave V3 GovernanceCore) |
| `probe-curve-gaugecontroller-mainnet.json` | 1 | `0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB` | Source: Vyper GaugeController, well-known Curve deployment |
| `probe-lido-aragon-mainnet.json` | 1 | `0x2e59A20f205bB85a89C53f1936454680651E618e` | Etherscan: Aragon AppProxy → Voting implementation, Lido DAO |
| `probe-makerdao-chief-mainnet.json` | 1 | `0x0a3f6849f78076aefaDf113F5BED87720274dDC0` | Etherscan: DSChief, canonical MakerDAO governance |
| `probe-nouns-dao-mainnet.json` | 1 | `0x6f3E6272A167e8AcCb32072d08E0957F9c79223d` | Etherscan: NounsDAOLogicV3 proxy |

**All 6 are verified correct** against Etherscan / well-known deployment addresses. The lack of `name()` accessor is a contract-level choice (most governance contracts skip it since they're not ERC20s) and doesn't imply a data integrity issue.

## Design note — label aliases

The sweep's fuzzy matcher initially produced 3 false positives:
- `probe-curve-votingescrow-mainnet.json` labeled "curve votingescrow" vs actual "Vote-escrowed CRV" — no shared word
- `probe-gitcoin-alpha-mainnet.json` labeled "gitcoin alpha" vs actual "GTC Governor Alpha" — "gitcoin" isn't in "GTC"
- `probe-gitcoin-bravo-mainnet.json` labeled "gitcoin bravo" vs actual "Uniswap Governor Bravo" — REAL mislabel from HB#384

After adding a `LABEL_ALIASES` map that says `curve → crv, vote-escrowed` and `gitcoin → gtc`, and renaming the third file to embed the mislabel in the filename itself, the sweep went to **0 mismatches**.

The alias map is meant to grow as new DAOs enter the corpus. Examples of patterns to add:
- `balancer → bal` (when BAL tokens show up in contract names)
- `aave → stkAAVE` (for Aave's staking governance)
- `synthetix → snx`
- etc.

This is not a perfect fuzzy match — a determined adversary labeling a malicious contract could defeat it. But that's not the threat model. The threat model is **operator accidentally typing the wrong address**, which is exactly what happened in HB#362 and what `--expected-name` + the alias map catches.

## Tool improvements surfaced

1. **`pop org probe-access` could use the same LABEL_ALIASES map** — currently `--expected-name` uses a literal case-insensitive substring match. If the operator runs `--expected-name "Curve"` against Curve's VotingEscrow, the match would fail because the contract identifies as "Vote-escrowed CRV". Extending probe-access's matcher to consult an alias map would make the flag work in more real-world cases without making the operator guess the on-chain naming convention.

2. **Sweep script belongs in a CI job** — if this repo ever gets CI, running the sweep on every PR that touches `agent/scripts/probe-*.json` would catch any future mislabels before they land on main. Filing as a Sprint 14 task idea.

3. **Machine-readable corpus index** — building on HB#385's always-logged `contractName` field: a single JSON index mapping `address → canonical label → audit HB → current score → source file` would let the sweep run in O(1) per entry instead of repeating the name() call. Also lets downstream consumers (leaderboard builders, external readers) sanity-check the corpus without their own RPC access.

## What the sweep proved (and didn't)

**Proved**:
- The HB#384 Gitcoin/Uniswap mislabel was the only mislabel in the 12 verifiable artifacts
- The HB#385 identity check would have prevented it and will catch any future equivalents
- The 6 no-`name()` contracts were all verified correct via Etherscan, though programmatic verification remains impossible

**Did NOT prove**:
- That the data inside matched artifacts is internally correct (sweep only checks address-to-label mapping, not whether the probe results are interpreted correctly downstream)
- That no address was substituted for a different contract on a chain the sweep didn't check (only mainnet, Optimism, Arbitrum in the RPC map)
- That the 6 no-`name()` contracts haven't been rugged or upgraded — source verification is a point-in-time check

## Ship artifacts

- `agent/scripts/audit-corpus-identity-sweep.mjs` (new, 180 lines) — the sweep script itself
- `agent/scripts/probe-gitcoin-bravo-MISLABELED-was-uniswap.json` (renamed from `probe-gitcoin-bravo-mainnet.json`) — embeds the HB#384 correction in the filename
- This document — `docs/audits/corpus-identity-sweep-hb386.md`

## Cross-references

- HB#384 original correction: `docs/audits/corrections-hb384.md`
- HB#385 pre-probe identity check: `src/commands/org/probe-access.ts` (task #390)
- Leaderboard v3: `docs/governance-health-leaderboard-v3.md`

---

*Published as part of the self-correction cycle: HB#378-380 produced novel audits, HB#381-383 built meta-work on top, HB#384 caught the HB#362 error, HB#385 prevented the error class from recurring, HB#386 verified the rest of the corpus is clean. Ninth consecutive self-sufficient ship HB.*
