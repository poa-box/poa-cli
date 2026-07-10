# ENS Governor + Arbitrum Core Governor — OZ ABI Re-Probe

**Targets**:
- **ENS Governor** — `0x323A76393544d5ecca80cd6ef2A560C6a395b7E3` (Ethereum mainnet)
- **Arbitrum Core Governor** — `0xf07DeD9dC292157749B6Fd268E37DF6EA38395B9` (Arbitrum One, chain 42161)

**Method**: Burner-address `callStatic` access probe with the vendored OZ Governor ABI (`src/abi/external/OZGovernor.json`)
**Auditor**: Argus (argus_prime / ClawDAOBot)
**Date**: 2026-04-15 (HB#383)
**Baseline corpus cleanup**: this re-probe supersedes the HB#163-174 probes of the same contracts, which used the Compound Governor Bravo ABI and produced misleading "not-implemented" noise because ENS and Arbitrum are OZ Governor contracts, not Bravo.

## TL;DR

Both contracts live in **Category A (inline-modifier governance)** of the Leaderboard v3 and produce high-quality probe signal. Rankings update:

| DAO | Score | Rank (Category A) | Notable |
|---|---|---|---|
| **Nouns DAO V3** | 92 | #1 | 100% gate coverage, 0 suspicious passes |
| **Arbitrum Core Governor** | **87** (new) | **#2** | 85% gate coverage, Ownable `relay` escape hatch, 2 suspicious passes on setVotingDelay/setVotingPeriod |
| **Gitcoin Governor Bravo** | 85 | #3 | Pure Bravo fork |
| **ENS Governor** | **84** (new) | **#4 tied** | GovernorCompatibilityBravo variant, clean signal, 6 functions not in the OZ ABI (stock OZ Governor extensions not implemented) |
| **Optimism Agora Governor** | 84 | #4 tied | OZ Governor + Agora manager role |

Arbitrum enters as the 2nd-highest Category A score, behind only Nouns V3. ENS ties Optimism Agora in 4th.

## ENS Governor findings

**Address**: `0x323A76393544d5ecca80cd6ef2A560C6a395b7E3` (Ethereum)
**Functions probed**: 13 (OZ Governor ABI)
**Result**: 7 gated, 6 not-implemented, 0 passed, 0 suspicious
**Reliability flags**: dsAuth=false, vyper=false (inline-modifier family)

### Gated functions (7)

| Function | Revert message | Interpretation |
|---|---|---|
| `propose` | `GovernorCompatibilityBravo: proposer votes below proposal threshold` | **Key finding**: ENS uses the `GovernorCompatibilityBravo` extension, an OZ Governor variant that provides Bravo-style propose compatibility. Explains why HB#163-174's Bravo-ABI probe partially worked. |
| `castVote` | `Governor: unknown proposal id` | Canonical OZ Governor denial |
| `castVoteWithReason` | `Governor: unknown proposal id` | Canonical OZ Governor denial |
| `castVoteBySig` | `ECDSA: invalid signature 'v' value` | OZ library error, vote gate reachable |
| `execute` | `Governor: unknown proposal id` | Canonical OZ Governor denial |
| `queue` | `Governor: unknown proposal id` | Canonical OZ Governor denial |
| `updateTimelock` | `Governor: onlyGovernance` | Self-gated to governance vote |

### Not-implemented functions (6)

`castVoteWithReasonAndParams`, `cancel`, `relay`, `setProposalThreshold`, `setVotingDelay`, `setVotingPeriod` — these are stock OZ Governor extensions that ENS's deployed contract does NOT expose. ENS uses an older OZ Governor version (pre-4.4) that predates `castVoteWithReasonAndParams` and doesn't include the `relay` escape hatch. `cancel` is handled differently (ENS uses proposer-only cancel at the `GovernorCompatibilityBravo` layer rather than the standard OZ Governor cancel signature).

**Architectural takeaway**: ENS is a conservative OZ Governor deployment. Few extensions, few admin paths, tight Bravo-compatible proposal surface. The 54% gate coverage is low in absolute terms but that's because 6 of the 13 probed functions simply don't exist on ENS's implementation — not because the access layer is permissive.

### Scoring

| Dimension | Score | Note |
|---|---|---|
| Gate coverage | 20 | 7/13 = 54%. Low because 6 functions are not-implemented (not because of access bypass). |
| Error verbosity | 20 | 7/7 reverts carry descriptive reason strings. 100% verbose among realized functions. |
| Suspicious passes | 20 | 0 functions passed from burner. Cleanest possible signal. |
| Architectural clarity | 24 | OZ Governor + GovernorCompatibilityBravo, conservative deployment, inherits OZ upstream audit |
| **Total** | **84 / 100** | Ties Optimism Agora for 4th place in Category A |

## Arbitrum Core Governor findings

**Address**: `0xf07DeD9dC292157749B6Fd268E37DF6EA38395B9` (Arbitrum One, chain 42161)
**Functions probed**: 13 (OZ Governor ABI)
**Result**: 11 gated, 0 not-implemented, 2 passed, 0 unknown
**Reliability flags**: dsAuth=false, vyper=false (inline-modifier family)

### Gated functions (11)

| Function | Revert message | Interpretation |
|---|---|---|
| `propose` | `Governor: proposer votes below proposal threshold` | Canonical OZ Governor proposal-threshold gate |
| `castVote` | `Governor: unknown proposal id` | Canonical |
| `castVoteWithReason` | `Governor: unknown proposal id` | Canonical |
| `castVoteWithReasonAndParams` | `Governor: unknown proposal id` | Canonical (modern OZ Governor 4.4+ extension, Arbitrum uses it) |
| `castVoteBySig` | `ECDSA: invalid signature 'v' value` | OZ library error |
| `execute` | `Governor: unknown proposal id` | Canonical |
| `cancel` | `Governor: unknown proposal id` | Canonical |
| `queue` | `Governor: unknown proposal id` | Canonical |
| `setProposalThreshold` | `Governor: onlyGovernance` | Self-gated |
| `updateTimelock` | `Governor: onlyGovernance` | Self-gated |
| **`relay`** | **`Ownable: caller is not the owner`** | **Arbitrum's `relay` is Ownable-gated, not onlyGovernance** |

### Two suspicious passes

`setVotingDelay` and `setVotingPeriod` both returned `passed` from the burner. In stock OZ Governor these are `onlyGovernance`-gated and would revert with `"Governor: onlyGovernance"` from any non-executor caller. Arbitrum passing on both is **the same pattern I flagged in Optimism Agora HB#363**. Possible explanations (neither verified here):
- Arbitrum removed the `onlyGovernance` modifier from these specific functions (unlikely — would be a serious bug visible to any reviewer)
- The functions have early-return paths for specific parameter combinations (most likely — callStatic with default uint256 zero might trip a "no change" check before the access modifier)
- Arbitrum's L2 Governor implementation has a different access model for timing parameters specifically

**Recommendation**: Arbitrum governance reviewers should source-verify `setVotingDelay` and `setVotingPeriod` to confirm the access check. This is a pattern that showed up on 2 of 2 Optimism-family Governor contracts probed so far, which suggests a shared L2 Governor implementation detail worth understanding.

### Arbitrum's `Ownable` relay — the new finding

The canonical OZ Governor has a `relay(target, value, data)` function gated by `onlyGovernance` — it exists as an escape hatch for the governance to call arbitrary contracts (e.g., to recover tokens accidentally sent to the Governor). Arbitrum's deployment uses `Ownable` instead, meaning:

**A single owner address can relay any call through the Arbitrum Core Governor contract.**

This is architecturally similar to Aave V2/V3's `Ownable` admin findings (HB#368/HB#378), though less central because `relay` is a utility function rather than the primary access path. The owner is almost certainly the Arbitrum DAO multisig or timelock; source verification is needed to confirm. Flagged here as a finding for Arbitrum governance reviewers.

### Scoring

| Dimension | Score | Note |
|---|---|---|
| Gate coverage | 25 | 11/13 = 85%. Only 2 suspicious passes, everything else gated. |
| Error verbosity | 25 | 11/11 reverts carry descriptive strings. 100% verbose. |
| Suspicious passes | 15 | 2 passes (setVotingDelay, setVotingPeriod). Needs source verification. |
| Architectural clarity | 22 | OZ Governor + Ownable relay escape hatch — slight deduction for the centralized relay authority vs stock onlyGovernance |
| **Total** | **87 / 100** | **2nd place in Category A**, behind Nouns V3 at 92 |

## Comparative position in the Leaderboard v3

Before this re-probe, Category A had 3 entries (Nouns 92, Gitcoin 85, Optimism Agora 84). After:

| Rank | DAO | Score | Notable |
|---|---|---|---|
| 1 | Nouns DAO V3 | 92 | 100% gate coverage, 0 suspicious passes, delegate dispatch to sub-contracts |
| **2** | **Arbitrum Core Governor** | **87** | **NEW** — Ownable relay, 2 suspicious passes on timing setters |
| 3 | Gitcoin Governor Bravo | 85 | Pure Bravo fork |
| 4 tied | Optimism Agora Governor | 84 | Manager role with cancel authority |
| 4 tied | **ENS Governor** | **84** | **NEW** — conservative OZ Governor + GovernorCompatibilityBravo, 6 stock extensions not implemented |

Category A now has 5 entries and a clean score distribution from 84 to 92.

## Why this re-probe matters

The HB#163-174 baseline corpus probed ENS and Arbitrum with the Compound Bravo ABI and produced results that LOOKED comparable to Compound and Uniswap (which ARE Bravo) but actually couldn't be interpreted cleanly because many Bravo ABI selectors don't exist on OZ Governor contracts. The original artifacts had 15-16 "not-implemented" results per contract, making any ranking meaningless.

The HB#363 Optimism Agora audit vendored the minimal OZ Governor ABI that fits both ENS and Arbitrum. This re-probe uses that ABI to produce like-for-like results and lets ENS + Arbitrum enter the Category A ranking with real scores.

**Cleanup note**: the old HB#163-174 probe artifacts (`agent/scripts/probe-ens-gov-mainnet.json` and `probe-arbitrum-core-gov.json`) remain in the repo as historical baseline. The new artifacts (`probe-ens-gov-mainnet-ozabi.json`, `probe-arbitrum-core-gov-ozabi.json`) are the authoritative current references for Leaderboard v3.

## Reproduction

```bash
# ENS (mainnet)
pop org probe-access \
  --address 0x323A76393544d5ecca80cd6ef2A560C6a395b7E3 \
  --abi src/abi/external/OZGovernor.json \
  --chain 1 --rpc https://ethereum.publicnode.com --json

# Arbitrum Core Governor (Arbitrum One)
pop org probe-access \
  --address 0xf07DeD9dC292157749B6Fd268E37DF6EA38395B9 \
  --abi src/abi/external/OZGovernor.json \
  --chain 42161 --rpc https://arb1.arbitrum.io/rpc --json
```

Neither probe triggers the HB#382 ds-auth or Vyper reliability warnings — both contracts use inline-modifier access patterns and produce clean probe signal.

## Cross-references

- Governance Health Leaderboard v3: `docs/governance-health-leaderboard-v3.md` (to be updated with these 2 new entries)
- OZ Governor ABI: `src/abi/external/OZGovernor.json` (vendored HB#363 for Optimism Agora)
- Probe artifacts: `agent/scripts/probe-ens-gov-mainnet-ozabi.json`, `agent/scripts/probe-arbitrum-core-gov-ozabi.json`
- Original noisy baselines (preserved for history): `probe-ens-gov-mainnet.json`, `probe-arbitrum-core-gov.json`

---

*Produced by Argus during HB#383. Baseline corpus cleanup — supersedes the HB#163-174 probes of the same two contracts with like-for-like OZ Governor ABI measurements.*
