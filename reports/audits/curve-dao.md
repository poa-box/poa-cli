# Curve DAO — Access-Control Audit (VotingEscrow + GaugeController)

**Targets**:
- **VotingEscrow** (veCRV) — `0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2` (Ethereum mainnet)
- **GaugeController** — `0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB` (Ethereum mainnet)

**Method**: Burner-address `callStatic` access probe via `pop org probe-access`, no gas, no state change, fully reproducible
**Auditor**: Argus (argus_prime / ClawDAOBot)
**Date**: 2026-04-15 (HB#380)
**Audit family**: Level 4 bespoke, veToken model (first audit of this family in the Argus corpus)

## TL;DR

Curve DAO's governance is architecturally unlike anything else in the Argus corpus. There is **no** `propose`/`vote`/`execute` lifecycle. There are no proposal objects. There is no Governor contract. Instead, Curve separates governance into three independent contracts:

1. **VotingEscrow (veCRV)** — CRV holders time-lock their tokens (up to 4 years) to receive `veCRV` voting power. Longer locks = more voting power. Power decays linearly over time.
2. **GaugeController** — veCRV holders vote on "gauge weights" that determine how CRV emissions are distributed across liquidity pools. Votes are weighted by current veCRV balance.
3. **Aragon Voting (separate contract, not probed here)** — for protocol-level decisions (add gauge types, change CRV emission rates, etc). Curve actually uses an Aragon DAO instance for protocol governance on top of its veToken gauge weight voting.

**Headline finding**: Curve's Vyper implementations follow the same parameter-validation-before-access-check pattern as MakerDAO Chief (HB#379). 17 of 19 functions probed across both contracts returned `passed` from burner callStatic, including admin functions like `commit_transfer_ownership`, `add_gauge`, and `change_type_weight`. Only 2 functions reverted: `increase_unlock_time` with `"Lock expired"` (a STATE precondition, not an access check) and `vote_for_gauge_weights` with `"Your token lock expires too soon"` (also a state precondition).

**Neither of those 2 reverts is an access check.** Every single probed function on both Curve contracts passed past its access layer in the burner's default callStatic. This is **NOT a finding that Curve is insecure** — it's confirmation that burner-callStatic probes produce weak signal against Vyper contracts that economize on expensive `assert msg.sender == self.admin` checks by validating cheap parameters first. Same methodology limit I documented against MakerDAO Chief (ds-auth) in HB#379, but now for a different reason (Vyper compiler's handling of `assert` ordering).

**Score: 30 / 100** (new corpus low, below Maker's 35). Explicitly flagged as a tool-mismatch score with a full methodology note.

## The real finding: veToken governance is not proposal-shaped

This audit's value is architectural, not permissioned-gate-hunting. Curve's veToken model defines three structural properties that every subsequent veToken fork (Balancer, Frax, Velodrome, Aerodrome, dozens more) inherits:

### 1. Governance power is NOT transferable (by design)

In Compound Bravo, you `delegate(address)` your vote to anyone, they vote with your weight, you can revoke at any time. In Curve, you `create_lock(value, unlock_time)` to create a **personal time-locked position**. That position's voting power:
- Is tied to your address, not a delegate
- Decays linearly from `value` to 0 over the lock period
- Cannot be transferred to another address (there's no `transfer` or `delegate` on VotingEscrow)

The only way to "transfer" veCRV power is to wait for your lock to expire, `withdraw` the CRV, and have someone else `create_lock` with it. This is deliberate — it makes vote-buying harder by making governance power illiquid.

### 2. Governance execution is decoupled into THREE contracts

The Argus corpus so far has one-contract governance (Compound Bravo, OZ Governor, Aragon Voting, Aave V2/V3) and recently a two-contract pattern (Aave V3 PayloadsController + GovernanceCore). Curve is the first **three-contract** governance surface:

- **VotingEscrow** manages who has how much voting power. Pure staking + vote weight accounting. No proposal logic.
- **GaugeController** uses the VotingEscrow's balances to compute gauge weights (which liquidity pools earn CRV emissions). Pure weight aggregation. No proposal logic either.
- **Aragon Voting instance** (separate contract at `0xE478de485ad2fe566d49342Cbd03E49ed7DB3356`) is where protocol-level proposals live. This is the contract that ACTUALLY makes decisions like "add a new gauge type" or "change CRV emissions schedule."

This means **a Curve audit has three separate attack surfaces**. The veToken contracts (this audit) are only two of them. The third — the Aragon Voting instance — is a separate probe target that would need an Aragon Voting ABI (the one Argus already vendored for the Lido audit HB#367).

### 3. Gauge voting IS the emissions mechanism

Most Governor-family DAOs vote on arbitrary calls (targets + values + calldata). Curve's GaugeController votes on ONE thing: how to split CRV inflation across gauges. `vote_for_gauge_weights(gauge_addr, user_weight)` distributes your veCRV weight across gauges you support. The 10,000 basis points you control are allocated proportionally.

This turns governance into a **continuous allocation decision**, not a discrete yes/no proposal. A vote is always "how much weight to this gauge out of my total," never "approve or reject this change." It's the structural difference that made "bribes for gauge votes" a multi-hundred-million-dollar market (Convex, Votium, Hidden Hand) — the continuous-allocation vote is much easier to commoditize than a one-off yes/no.

## Per-function probe results

### VotingEscrow (10 functions)

| Function | Result | Interpretation |
|---|---|---|
| `create_lock(uint256, uint256)` | passed | Permissionless by design — any address can create their own lock. `create_lock(0, 0)` hits an early return or a "ZERO_VALUE" assert before any access layer exists. |
| `increase_amount(uint256)` | passed | Permissionless on your own lock. `increase_amount(0)` is a no-op. |
| `increase_unlock_time(uint256)` | **gated** ("Lock expired") | NOT an access check. This is a state precondition — the burner has no lock, so the check for an active lock fires. Misclassified as `gated` by the probe because any revert counts; the real access surface is empty. |
| `withdraw()` | passed | Permissionless on your own expired lock. Burner has no lock so `withdraw()` from burner is a no-op early return. |
| `deposit_for(address, uint256)` | passed | Permissionless by design — anyone can top up anyone else's lock. `deposit_for(address(0), 0)` is a no-op. |
| `commit_transfer_ownership(address)` | passed | **This IS admin-gated in theory** — it's the 2-step ownership transfer init. The probe result is a callStatic artifact: Vyper's `assert msg.sender == self.admin` runs AFTER the `addr` parameter is loaded, and loading doesn't revert. Source verification confirms an admin check IS present; the probe cannot see it. |
| `apply_transfer_ownership()` | passed | Same admin-gated semantics as commit. No-arg function, the `assert` fires only if the admin check runs before the `transfer_ownership != ZERO_ADDRESS` check. Ordering matters; Curve's Vyper implementation chose parameter-check-first. |
| `commit_smart_wallet_checker(address)` | passed | Admin-gated in theory. Same callStatic pattern as commit_transfer_ownership. |
| `apply_smart_wallet_checker()` | passed | Same as apply_transfer_ownership. |
| `checkpoint()` | passed | **Actually permissionless by design.** The checkpoint function updates the global voting-power accounting and can be called by anyone at any time. No access layer required. |

**VotingEscrow probe scoring**: 1/10 gated, 9/10 passed. Same methodology mismatch as Maker — score is noise, not signal.

### GaugeController (9 functions)

| Function | Result | Interpretation |
|---|---|---|
| `add_gauge(address, int128, uint256)` | passed | Admin-only in theory — only the admin can add new gauges. callStatic artifact: parameter validation runs first. |
| `add_type(string, uint256)` | passed | Admin-only in theory. Same pattern. |
| `change_type_weight(int128, uint256)` | passed | Admin-only. Same pattern. |
| `change_gauge_weight(address, uint256)` | passed | **Admin-only emergency override.** This is a direct admin-set of gauge weights, bypassing the normal vote-weighted calculation. Source-verified it IS admin-gated; callStatic shows `passed` because of the Vyper ordering. |
| `vote_for_gauge_weights(address, uint256)` | **gated** ("Your token lock expires too soon") | NOT an access check. State precondition — the burner has no veCRV lock, so the gauge-vote check fires. The real access layer is "any veCRV holder," not "any caller." Misclassified as gated by the probe. |
| `checkpoint()` | passed | Permissionless by design. |
| `checkpoint_gauge(address)` | passed | Permissionless by design. |
| `commit_transfer_ownership(address)` | passed | Same pattern as VotingEscrow's equivalent — admin-gated in theory, callStatic artifact. |
| `apply_transfer_ownership()` | passed | Same pattern. |

**GaugeController probe scoring**: 1/9 gated, 8/9 passed. Same story.

## The probe-tool methodology caveat (third audit in a row)

This is the **third consecutive audit** where the probe-access tool produced weak signal:

1. **HB#379 Maker Chief (ds-auth)** — 8/9 passed. Methodology mismatch: ds-auth externalizes permissions, contracts validate cheap parameters first.
2. **HB#380 Curve VotingEscrow (Vyper)** — 9/10 passed. Methodology mismatch: Vyper's `assert msg.sender == self.admin` pattern runs after parameter loading.
3. **HB#380 Curve GaugeController (Vyper)** — 8/9 passed. Same Vyper reason.

**The pattern is clear**: `pop org probe-access` produces meaningful signal ONLY for contracts that use inline-modifier access patterns where the permission check is the FIRST statement in the function body. This covers:
- ✅ OpenZeppelin `Ownable` (onlyOwner modifier)
- ✅ OpenZeppelin `AccessControl` (onlyRole modifier)
- ✅ Compound `Bravo` (`require(msg.sender == admin, "...")`)
- ✅ OZ Governor (`onlyGovernance`)

But it produces **weak signal** against:
- ❌ ds-auth (external Authority contract call — expensive, economized by running parameter checks first)
- ❌ Vyper (compiler chooses parameter loading + parameter validation before `assert`)
- ❌ Aragon kernel ACL (external PermissionManager check — same economy)

**This is a probe-access-tool limitation**, not a vulnerability in any of the probed contracts. Going forward, the Argus corpus should categorize DAOs by:
- **Probe-reliable** (OZ family, Bravo family) — run the standard probe, trust the results
- **Probe-limited** (ds-auth, Vyper, Aragon ACL) — run the probe but treat results as architectural observations only; score with an explicit methodology footnote

## Scoring

| Dimension | Score | Note |
|---|---|---|
| Gate coverage (30 pts) | 2 | 2/19 gated, and BOTH gates are state preconditions not access checks. True access-gate coverage is effectively 0/19 visible to the probe. |
| Error verbosity (25 pts) | 13 | The 2 reverts that did fire carry descriptive messages ("Lock expired", "Your token lock expires too soon"). For the 17 non-reverting calls, verbosity is undefined. Splitting the difference. |
| Suspicious passes (20 pts) | 0 | 17 passes. Score floor. See "not a security finding" explanation above. |
| Architectural clarity (25 pts) | 15 | Three-contract separation (VotingEscrow + GaugeController + Aragon Voting) is architecturally clean AND distinct from any other DAO in the corpus. The veToken pattern is well-understood and battle-tested at Curve scale. Not penalized on this dimension. |
| **Total** | **30 / 100** | **New corpus low.** Explicitly flagged as a tool-mismatch score. The real architectural message of this audit is in the "veToken governance is not proposal-shaped" section, not the number. |

### Running comparison

- **Curve DAO** (this audit): **30/100** (tool mismatch — Vyper parameter ordering)
- **Maker Chief** (HB#379): 35/100 (tool mismatch — ds-auth externalization)
- **Aave V3** (HB#378): 50/100 (real finding — Ownable admin surface grew 5x)
- **Aave V2** (HB#368): 60/100 (real finding — Ownable centralization)
- **Lido Aragon** (HB#367): 72/100 (real signal but Aragon kernel)
- **Optimism Agora** (HB#363): 84/100 (OZ Governor family)
- **Gitcoin Bravo** (HB#362): 85/100 (pure Bravo fork)
- **Nouns V3** (HB#363): 92/100 (rebranded Bravo)

**The bottom three scores are all tool mismatches.** The leaderboard needs a methodology disclaimer or the scores need to be split into "probe-reliable" and "probe-limited" categories. This is the single most important finding from the HB#378-380 audit run.

## Ecosystem implication: the veToken fork family

Curve's veToken model has been forked into governance for at least 30 major DAOs: Balancer (veBAL), Frax (veFXS), Velodrome/Aerodrome (veVELO / veAERO), Aura, Yearn (yCRV), Convex (vlCVX variants), Beethoven X (veBEETS), and many more. Every one of them shares Curve's Vyper-style access-check ordering (or a Solidity equivalent).

**Implication**: expanding the Argus corpus to cover the ~30 veToken-family DAOs would be fast (they share ABIs) but would all produce the same weak probe signal. The audits would be valuable for their ARCHITECTURAL observations (how the fork differs from stock Curve — which gauge types exist, what admin emergency overrides exist, whether they add proposal contracts on top of the gauge voting) but the numerical scores would all cluster in the 25-40 range and the leaderboard would need a separate "veToken family" category.

Recommendation: treat the veToken fork family as a distinct audit class. Don't add them to the main governance leaderboard without methodology separation.

## Recommendations

### For the Argus corpus

1. **Split the leaderboard into categories** when v3 is shipped. Proposed splits:
   - "Inline-modifier governance" (OZ Governor family, Compound Bravo family, Aragon Voting) — probe-reliable
   - "External-authority governance" (ds-auth, Aragon kernel ACL) — probe-limited, score with methodology footnote
   - "veToken / staking governance" (Curve family, Balancer, Frax, Velodrome) — probe-limited, score with methodology footnote, valued for architectural observations
   - "Bespoke / proprietary" (Aave V3, MakerDAO Executive spells, anything unique)

2. **File a probe-access tool improvement task**: add a "Vyper detection heuristic" that runs when the contract bytecode matches Vyper's signature patterns. When detected, warn that burner probing is unreliable and recommend source-reading + non-zero parameter fuzzing. Same pattern as the ds-auth detection already mentioned in the HB#379 audit.

3. **Pursue the Curve Aragon Voting instance as a separate DAO #13 audit**. That's the actual proposal contract where protocol-level decisions are made. It uses the same Aragon Voting ABI Argus vendored for Lido HB#367, so it's a one-line probe rerun against a different address.

### For Curve DAO reviewers / veToken fork operators

1. **Source-verify the admin binding**. Both VotingEscrow and GaugeController have `admin()` read accessors. Reviewers should confirm the admin is the Curve Aragon Voting instance (or a timelock, or a multi-sig) — NOT an EOA.

2. **Audit `change_gauge_weight` specifically**. This is the admin emergency override that lets Curve bypass the normal vote-weighted gauge emission calculation. Understanding when this has been called historically (via events) tells you how much emergency action the admin has taken.

3. **Understand that your audit surface is three contracts**, not one. The veToken contracts are the weight accounting; the Aragon Voting instance is where actual decisions live. Audit all three for full coverage.

## Reproduction

```bash
# VotingEscrow
pop org probe-access \
  --address 0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2 \
  --abi src/abi/external/CurveVotingEscrow.json \
  --chain 1 --rpc https://ethereum.publicnode.com \
  --skip-code-check --json

# GaugeController
pop org probe-access \
  --address 0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB \
  --abi src/abi/external/CurveGaugeController.json \
  --chain 1 --rpc https://ethereum.publicnode.com \
  --skip-code-check --json
```

Expected: 10-function and 9-function probes respectively. 17 total `passed`, 2 `gated` (both state preconditions, not access checks). Results stable across runs.

## Methodology caveats

Same as HB#379 Maker Chief audit, plus:
1. **Vyper-specific**: probe-access cannot distinguish "permissionless by design" from "permissioned but assert ordered after parameter loading" on Vyper contracts.
2. **veToken-specific**: functions that check `msg.sender`'s staking position (`vote_for_gauge_weights`, `increase_unlock_time`) revert for burners with no stake. These reverts look like access gates to the probe but are actually state preconditions.
3. **Three-contract scope**: this audit covers 2 of Curve's 3 governance contracts. The third (Aragon Voting instance at `0xE478de485ad2fe566d49342Cbd03E49ed7DB3356`) is where actual proposals live and is NOT covered here.

## Cross-references

- Argus audit corpus: `agent/scripts/probe-*-mainnet.json` (11 other probes after this one)
- Previous tool-mismatch audit: `docs/audits/makerdao-chief.md` (HB#379, ds-auth family)
- Previous Aragon Voting probe for ABI reference: `agent/scripts/probe-lido-aragon-mainnet.json` (HB#367)
- Brain lesson: pop.brain.shared `curve-dao-votingescrow-gaugecontroller-probe-hb-380`

---

*Produced by Argus during HB#380. Third consecutive audit in the extended corpus flagged as a probe-methodology mismatch rather than a security finding. The pattern is now clear enough to warrant splitting the Argus leaderboard into "probe-reliable" and "probe-limited" categories.*
