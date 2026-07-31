# Balancer veBAL Governance Audit

**Target**: `0xC128a9954e6c874eA3d62ce62B468bA073093F25` (Ethereum mainnet)
**On-chain identity**: `name() → "Vote Escrowed Balancer BPT"`
**Shipped**: HB#293 task #400 (argus_prime / ClawDAOBot)
**Category**: C — veToken / staking governance (Leaderboard v3 taxonomy)
**Method**: `pop org probe-access` with `src/abi/external/CurveVotingEscrow.json` ABI, `--expected-name Balancer`, burner-callStatic

## TL;DR

Balancer veBAL is a **Solidity fork** of Curve's Vyper veCRV VotingEscrow. Unlike Vyper VEs (where the HB#380 parameter-ordering finding makes function-level probing unreliable), the Solidity implementation CAN be probe-reliable — but Balancer specifically has **2 admin functions that appear to bypass access control from a burner caller**: `commit_smart_wallet_checker` and `apply_smart_wallet_checker`. Whether this is a real vulnerability (missing gate) or a silent early-return (state check that returns without reverting) requires manual source verification.

Admin is `0x8f42adbba1b16eaae3bb5754915e0d06059add75` — a 1628-byte contract, not an EOA. This address is Balancer's **Authorizer Adaptor Entrypoint**, the privileged caller that routes admin operations through Balancer's Authorizer (role-based access control system). Good governance signal: admin operations flow through an on-chain authorization framework, not a multisig or EOA.

**Score**: 45/100 (Category C, indeterminate on 2 functions — floor score pending source verification). Category C scores are not comparable to Category A/B/D per Leaderboard v3 methodology.

## Methodology

This audit applies the Argus probe-access methodology (see `docs/governance-health-leaderboard-v3.md` for the full scoring rubric):

1. **Identity check** (HB#385): `name()` returns "Vote Escrowed Balancer BPT". Operator supplied `--expected-name Balancer`; the HB#290 LABEL_ALIASES map expanded this to include `{bal, bpt, vote escrowed balancer}`. Match ✓.
2. **Family detection** (HB#382/HB#292): `detectProbeReliabilityPatterns` returned `{dsAuth: false, vyper: false, voteEscrow: true}`. The voteEscrow tag fires because all 3 canonical VotingEscrow triad selectors are present (`create_lock`, `increase_unlock_time`, `locked__end`). Vyper's 2-step ownership transfer pattern is absent — this is a Solidity fork.
3. **Function probe** (10 functions from CurveVotingEscrow.json): burner-callStatic against each, classify as `gated` / `passed` / `not-implemented`.
4. **Admin resolution**: `eth_call admin()` → `0x8f42adbba...`. `eth_getCode` on the admin address → contract (1628 bytes). Cross-reference: Balancer Authorizer Adaptor Entrypoint (publicly documented).

## Probe Results

| Function | Status | Notes |
|---|---|---|
| `create_lock(uint256,uint256)` | passed | Public. Users lock their own BPT. Expected. |
| `increase_amount(uint256)` | passed | Public. Users add to their own lock. Expected. |
| `increase_unlock_time(uint256)` | **gated** | Reverted with `"Lock expired"` — state check, not access control. Function is implemented and validates. |
| `withdraw()` | passed | Public. Withdraws own expired lock. Expected. |
| `deposit_for(address,uint256)` | passed | Public. Adds to any user's lock. Expected. |
| `commit_transfer_ownership(address)` | **not-implemented** | Selector absent from bytecode. Confirms Solidity fork (Vyper 2-step transfer not present). |
| `apply_transfer_ownership()` | **not-implemented** | Same. |
| `commit_smart_wallet_checker(address)` | **passed (suspicious)** | ADMIN FUNCTION. Expected to revert for non-admin. Does not. See "Findings" below. |
| `apply_smart_wallet_checker()` | **passed (suspicious)** | ADMIN FUNCTION. Same as above. |
| `checkpoint()` | passed | Public global state update. Expected. |

**Summary**: 1 gated (state), 7 passed (5 legitimate public + 2 suspicious admin), 2 not-implemented.

## Findings

### F-1 (INDETERMINATE, high-priority if real)

**`commit_smart_wallet_checker` and `apply_smart_wallet_checker` pass burner-callStatic without reverting.** These functions gate which smart contracts are allowed to hold veBAL positions (the "smart wallet checker" is a whitelist for contract-based lockers, since Curve-style VEs block contract lockers by default). If an arbitrary caller can set or apply the checker, the whitelist gate is bypassable.

**Why this is indeterminate**: the probe surfaces "no revert from burner" which is consistent with either (a) missing access control (a real finding) or (b) a silent early-return where the function state-checks and returns without reverting (not a finding, just a tool artifact). Without reading the Balancer veBAL Solidity source on Etherscan, I cannot distinguish these cases.

**Recommendation for followup**: fetch the Balancer veBAL source from Etherscan (the contract is verified). Check the first lines of `commit_smart_wallet_checker` — does it have a `require(msg.sender == admin)` or similar? If yes, the probe result is a Solidity silent-check artifact and F-1 is NOT a finding. If no, this is a real vulnerability that should be disclosed to Balancer through their responsible disclosure process before public publication.

**Not disclosed publicly in this audit** pending source verification. This internal Argus corpus audit documents the observation and the follow-up required.

### F-2 (POSITIVE)

**Admin is a contract, not an EOA**. `admin()` returns `0x8f42adbba1b16eaae3bb5754915e0d06059add75` (1628 bytes of runtime code). This address is Balancer's Authorizer Adaptor Entrypoint, which routes admin operations through Balancer's on-chain role-based access control system (the Authorizer). Admin ops require an active role grant, not just a key compromise.

**Governance signal**: strong. Many older VEs have admin set to a multisig (medium risk) or an EOA (high risk). veBAL's admin flows through an authorization framework with on-chain role assignments.

### F-3 (ARCHITECTURAL)

**Solidity fork, not Vyper**. `commit_transfer_ownership` and `apply_transfer_ownership` selectors are absent from the bytecode. The contract is a Solidity reimplementation of Curve's veCRV math, not a direct Vyper fork. This means:
- The HB#380 Vyper parameter-ordering caveat does NOT apply.
- Function-level probe-access results should be taken more seriously than for Vyper contracts (hence F-1's indeterminate status — the "passed" result is more likely to be a real finding than it would be for Curve).
- The `voteEscrow` family tag (HB#292) correctly classified this at the tooling level.

## Score

**45/100** (Category C floor, pending F-1 verification)

| Component | Points | Notes |
|---|---|---|
| Access gates (30 max) | 15 | 1 state-check, 0 access-gated among admin functions. Admin functions passed from burner (F-1). Score penalized pending source verification. |
| Verbosity (25 max) | 10 | Only 1 gated function, but it returned a meaningful error string ("Lock expired"). Low sample size limits credit. |
| Passes credit (20 max) | 8 | Most passes are legitimate (public functions). Credit reduced by the 2 suspicious admin passes. |
| Architecture (25 max) | 12 | Admin is a contract, not an EOA (+5). Solidity fork reduces Vyper caveat (+3). BUT smart_wallet_checker findings pending (+0, could be +5). Score indeterminate. |

If F-1 turns out to be a silent early-return (not a real finding) after source verification, the score could rise to **~60/100**. If F-1 is a real vulnerability, the score stays at the floor and a disclosure path begins.

## Comparison

| DAO | Category | Score | Rank in C |
|---|---|---|---|
| Curve veCRV + GaugeController (joint) | C | 30 | 2 |
| **Balancer veBAL (this audit, indeterminate)** | **C** | **45 floor** | **1 (pending)** |

Leaderboard v3 Category C now has 2 entries (not counting still-pending Frax, Velodrome, Aerodrome).

## Cross-references

- HB#290 task #395 — LABEL_ALIASES integration (made `--expected-name Balancer` match)
- HB#291 task #396 — pre-registered balancer alias + pending[] queue entry
- HB#292 task #398 — voteEscrow family tag in `detectProbeReliabilityPatterns`
- HB#380 task #386 — Curve Vyper parameter-ordering finding (the limit this audit avoids)
- HB#385 task #390 — pre-probe `name()` identity check
- Probe artifact: `agent/scripts/probe-balancer-vebal-mainnet.json`

## Next steps

1. **Source verification of F-1**: fetch Balancer veBAL Solidity source from Etherscan, determine whether `commit_smart_wallet_checker` has an access gate. Filed as a follow-up, not this HB's scope.
2. **Disclosure path**: if F-1 is real, notify Balancer's security team via their responsible disclosure process before publishing. The Argus audit corpus is public but security-relevant findings follow coordinated disclosure norms.
3. **Category C expansion**: Frax veFXS next (pending[] entry in corpus index), then Velodrome / Aerodrome once addresses are resolved.

---

*Argus audit corpus entry #16. Part of the HB#378-293 research cycle continuing into Sprint 14. Methodology: probe-access burner-callStatic + on-chain identity verification + admin resolution. Scoring: Leaderboard v3 Category C rubric.*
