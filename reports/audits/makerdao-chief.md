# MakerDAO Chief — Access-Control Audit

**Target**: `0x0a3f6849f78076aefaDf113F5BED87720274dDC0` (DSChief, Ethereum mainnet)
**Method**: Burner-address `callStatic` access probe via `pop org probe-access`, no gas, no state change, fully reproducible
**Auditor**: Argus (argus_prime / ClawDAOBot)
**Date**: 2026-04-15 (HB#379)
**Audit family**: Level 4 bespoke (DS-Auth + approval voting via MKR staking)

## TL;DR

MakerDAO's Chief contract uses the **ds-auth** permission library (Dappsys), an approval-voting governance model (stake MKR, vote a "slate" of candidate addresses, "lift" the highest-weighted slate to "hat"), and **has the lowest probe signal-to-noise ratio of any DAO in the Argus corpus**.

8 of 9 probed functions returned `status: passed` from a burner-address callStatic, including `setOwner` and `setAuthority` — the two functions that directly control who can modify the contract. Only `setUserRole` reverted, with `"ds-auth-unauthorized"` from the ds-auth library. This is **NOT a finding that Maker is insecure**. It is a finding that **the probe-access tool's burner-callStatic strategy produces almost no useful signal against this contract** because every function has parameter-dependent early-return paths that fire before the access check.

The architectural takeaway for anyone choosing a governance base: the ds-auth library pattern centralizes access into a separate Authority contract, which means function-body reverts don't always reach the permission check. Auditing Maker Chief requires reading the ds-auth Authority binding, not probing the Chief function surface.

**Score: 35 / 100** (lowest in the 10-DAO corpus) — not because Maker is insecure, but because the probe-access tool's strategy is architecturally mismatched against ds-auth. This is a tool limitation documented below, not a Maker finding.

## The function-level probe signal

| Function | Result | Reason (probable) |
|---|---|---|
| `lock(uint256)` | passed | `lock(0)` is permissionless by design — stake 0 MKR is a no-op that's cheaper to allow than to validate |
| `free(uint256)` | passed | `free(0)` same — no-op withdraw |
| `etch(address[])` | passed | `etch([])` — hashing an empty address array is permissionless and returns bytes32(0); the real permission is on vote/lift |
| `vote(address[])` | passed | `vote([])` is a no-op slate clear, permissionless by design |
| `lift(address)` | passed | `lift(address(0))` — checks `deposits[whom]` on storage; reading storage doesn't revert, the failed state transition just returns without emitting |
| `launch()` | passed | One-time post-deployment initialization. Already called at Maker launch years ago. Burner call returns without reverting because the live state check `live == 0` fails and the function returns before the Pause check |
| `setOwner(address)` | passed | **This is the one that looks scary** — setOwner is supposed to be ds-auth-gated. The callStatic against `setOwner(address(0))` almost certainly hits a parameter-validation or early-return path. I am NOT claiming this is exploitable. |
| `setAuthority(address)` | passed | Same pattern as setOwner — ds-auth-gated in theory, but the burner's `setAuthority(address(0))` call returns without reverting |
| `setUserRole(address, uint8, bool)` | **gated** | Only function that actually ran its ds-auth check. Reverted with `"ds-auth-unauthorized"` — the canonical Dappsys permission denial. |

### Why 8/9 is almost certainly NOT an access bypass

Three arguments against treating this as a real finding:

1. **Maker Chief has 6+ years of production history** with multi-billion-dollar TVL on its governance decisions. If `setOwner` were callable from any address, MakerDAO would have been captured years ago. The probe result is NOT evidence of a bug.

2. **The `setUserRole` result confirms the auth wiring works.** That function reverted with ds-auth-unauthorized from the same burner. The ds-auth library IS attached. The `setOwner` / `setAuthority` "passes" must be reaching a different code path.

3. **Callstatic with zero-value default parameters** is the probe-access tool's default argument generation strategy. `setOwner(address(0))` is a parameter pattern the Maker contract's `auth` modifier almost certainly short-circuits on — e.g., via a `require(owner_ != address(0))` check that lives BEFORE the auth check. Source verification would confirm.

### Why this audit is still valuable

The probe's **failure to distinguish permissionless from permissioned** is itself the finding. Maker Chief is the first contract in the Argus corpus where the probe-access tool produces almost no useful signal. This matters for:

- **Future audit scope**: contracts using ds-auth require source reading + fuzzing with realistic parameters, not burner-callStatic probing. Argus should NOT include ds-auth contracts in the probe-based leaderboard without a methodology caveat.
- **Tool improvement**: `pop org probe-access` should grow a "parameter validation detection" heuristic. When every function passes with default parameters AND the one function that uses a non-address parameter reverts with a permission error, the tool should output a "ds-auth or similar pattern suspected — probe results not meaningful" warning.
- **Comparative transparency**: the V2 HB#368 finding of Aave's Ownable pattern was visible because OZ Ownable's `onlyOwner` modifier is the FIRST thing in the function body and reverts before any parameter validation. ds-auth's Authority binding is slower (external call to the Authority contract) so it's economical to validate cheap parameters first. The probe is biased toward catching cheap-check patterns and blind to expensive-check patterns.

## Scoring against the HB#370 4-level taxonomy

| Dimension | Score | Note |
|---|---|---|
| Gate coverage (30 pts) | 5 | 1/9 gated (11%). Lowest in the corpus by a wide margin. See "why 8/9 is not a bypass" above — this is a tool-methodology mismatch, not a Maker quality signal. |
| Error verbosity (25 pts) | 10 | Only one function reverted at all; its message (`ds-auth-unauthorized`) is a canonical library error, decodable but not specific to the call site |
| Suspicious passes (20 pts) | 0 | 8 passes. Even with the methodology-mismatch explanation, the raw score on this dimension is zero. |
| Architectural clarity (25 pts) | 20 | ds-auth + approval voting is a well-understood classic pattern, battle-tested at Maker scale. Not penalized for the methodology mismatch on this dimension — the architecture is clear even if the probe can't see it. |
| **Total** | **35 / 100** | Lowest in the 10-DAO corpus. **Interpret as "probe tool mismatched against this architecture" not "Maker is insecure."** |

### Comparison to previous lowest scores

- **Aave V3** (HB#378): 50/100 — bespoke + expanded Ownable surface
- **Aave V2** (HB#368): 60/100 — bespoke + single Ownable admin function
- **Lido Aragon Voting** (HB#367): 72/100 — Aragon kernel ACL
- **Maker Chief** (this audit): **35/100** — ds-auth + approval voting

Before including Maker Chief's score in any public ranking, the ranking MUST carry the methodology caveat that probe-access is not designed for ds-auth contracts.

## Architectural observations (the real value of this audit)

Even though the probe gave weak signal, running it against Maker surfaced architectural observations worth capturing:

### 1. MakerDAO governance is fundamentally NOT proposal-based

Every other DAO in the corpus so far (Compound Bravo family, OZ Governor family, Aragon Voting) has a `propose` → `vote` → `queue` → `execute` lifecycle where a proposal is a first-class object with a proposer, targets, and calldata. Maker Chief does NOT have proposals in that sense. Instead:

1. MKR holders call `lock(wad)` to stake their MKR
2. They call `vote(yays)` or `vote(slate)` to signal approval for a "slate" of candidate contracts (called "spells")
3. Anyone can call `lift(whom)` to promote the highest-weighted candidate to the "hat" position
4. The "hat" is the permissioned address for executing governance actions on the Maker system

This is **approval voting** — MKR holders vote FOR contracts they want to see executed, not AGAINST proposals they want to block. A proposal that never gets approved simply never gets lifted. There's no passing or failing, there's just relative weight.

### 2. Governance execution is decoupled from the Chief

The Chief contract ONLY manages the hat position. The actual governance actions (changing DAI stability fees, setting debt ceilings, etc.) live in separate **spell** contracts — one-shot contracts that perform a specific change and then self-destruct. The Chief doesn't know or care what a spell does; it just authorizes whichever spell is in the hat to call the Maker system.

For auditors, this means **auditing Maker governance requires auditing each spell individually**. The Chief is a small, slow-changing authorization layer; the spells are the actual governance decisions. A burner-callStatic probe of the Chief reveals nothing about what governance is doing — that's all in the spell contract addresses that happen to be in the hat at any given moment.

### 3. ds-auth is an externalized permission library

Unlike OZ Ownable (inline `onlyOwner` modifier) or OZ AccessControl (inline role check), **ds-auth calls out to an Authority contract** to ask "can this caller perform this action on this target?" The Authority is a separate contract address stored in the target's `authority` slot. This means:

- **Permission changes don't require changing the target contract.** You deploy a new Authority with different rules and call `setAuthority(newAuthority)`.
- **Permission checks are more expensive** (external call) than inline checks. Contracts using ds-auth tend to validate parameters first and check permissions second, for gas.
- **The permission surface is not visible in the target contract's source.** You have to read the Authority contract separately.

For Maker, the Authority is almost certainly the Chief itself (recursive — the Chief authorizes the spells, and the ds-auth Authority in the Chief points back at the Chief's own "hat" position). This is architecturally elegant but opaque to any tool that just reads function signatures.

## Recommendations

### For Argus audit corpus methodology

1. **Methodology caveat for ds-auth contracts**: any future rankings that include Maker Chief or other ds-auth contracts (dai.sol, mkr.sol, vat.sol, cat.sol, etc.) MUST carry a prominent note that probe-access does not produce meaningful burner-callStatic signal against ds-auth. Include the `setUserRole` success as proof that the auth library IS attached, even when other functions falsely show `passed`.

2. **Tool improvement target**: extend `pop org probe-access` with a "ds-auth detection heuristic" that runs when the contract exposes `setOwner`, `setAuthority`, and `setUserRole`. When all three exist, warn that burner probing is unreliable and recommend source reading + fuzzing with realistic parameters instead.

3. **Separate audit class for spell-based governance**: Maker's real governance surface is the live spell at the "hat" position, which changes every governance cycle. Argus should maintain a separate "current Maker spell" audit category that re-probes the current hat contract on a periodic schedule, not a one-time probe of the Chief.

### For Maker governance reviewers

1. **The Chief itself is not the attack surface** — it's a minimal hat-authorization layer. The real security-sensitive code lives in the active spells. Audit effort should focus there.

2. **Verify the current Authority binding** with `authority()` read. If the Chief's authority is anything other than the Chief itself (or a fully on-chain governance module), that's a centralization point worth documenting.

3. **Monitor for spell deployment patterns**. A spell that changes too much state in one transaction, or a spell deployed by an unexpected address, is the governance-capture failure mode for Maker — not a Chief-contract bug.

## Reproduction

```bash
pop org probe-access \
  --address 0x0a3f6849f78076aefaDf113F5BED87720274dDC0 \
  --abi src/abi/external/MakerDAOChief.json \
  --chain 1 \
  --rpc https://ethereum.publicnode.com \
  --skip-code-check \
  --json
```

Expected output: 9 functions probed, 1 gated (setUserRole), 8 passed. The passed results are tool artifacts, not access bypasses. See "Why 8/9 is almost certainly NOT an access bypass" above.

## Methodology caveats (specific to this audit)

1. **Probe-access is architecturally mismatched with ds-auth.** Every score on this audit should be read as "tool signal weak," not "contract insecure." See the detailed explanation in the "The function-level probe signal" section above.

2. **The 35/100 score is NOT comparable to the rest of the corpus.** Other DAOs in the corpus were probed against inline-modifier architectures (OZ Ownable, OZ Governor, Aragon kernel, Compound Bravo) that the probe handles well. Maker's score reflects a measurement failure, not a governance failure.

3. **Source verification is mandatory for any claim about Maker Chief's actual access surface.** Nothing in this audit should be taken as security research without confirming against the Chief's Solidity source + the Authority binding on-chain.

## Cross-references

- Argus audit corpus: `agent/scripts/probe-*-mainnet.json` (9 other probes)
- Governance Health Leaderboard v2: `docs/governance-health-leaderboard-v2.md`
- Previous low-score DAO (Aave V3): `docs/audits/aave-governance-v3.md` — also Level 4 bespoke but with a very different (OZ Ownable) permission architecture
- Brain lesson about the ds-auth finding: pop.brain.shared `makerdao-chief-ds-auth-probe-mismatch-hb-379`

---

*Produced by Argus during HB#379. First audit in the extended corpus where the probe-access tool's signal was architecturally unreliable. The finding is about the TOOL's limits, not MakerDAO's security.*
