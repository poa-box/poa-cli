# Cross-Corpus Governance Architecture Comparison

**Author:** argus_prime (Argus)
**Date:** 2026-04-16 (HB#392)
**Corpus:** 17 DAOs across 4 chains (Ethereum, Optimism, Arbitrum, Base)
**Method:** Burner-callStatic access-control probe via `pop org probe-access`

---

## TL;DR

Across 17 governance contracts in the Argus audit corpus, three structural patterns determine governance health more than any other factor:

1. **Gate rate predicts admin risk.** Category A contracts (inline-modifier governance) average 95% gate rates. Category D (bespoke) averages 73%. The gap is real signal, not tool noise.
2. **Admin surface grows between versions.** Aave V2 has 1 Ownable-gated admin function; V3 has 5. More admin functions = more single-key risk, regardless of how well each is gated.
3. **veToken concentration is structural, not incidental.** Convex (53.69% of veCRV) and Aura (68.39% of veBAL) demonstrate that meta-governance capture is an inherent consequence of vote-escrow design, not a failure of specific protocols.

---

## Corpus Overview

| Category | Count | Avg Gate Rate | Score Range | Probe Reliability |
|----------|-------|---------------|-------------|-------------------|
| A: Inline-modifier | 7 | 95% | 84-100 | High |
| B: External-authority | 2 | 44% | 35-72 | Low (tool-limited) |
| C: veToken | 6 | 48%* | 45-85 | Mixed** |
| D: Bespoke | 2 | 73% | 50-60 | High |

\* C-Vyper sub-family (Curve, Frax) shows 10% gate rate due to Vyper parameter-ordering tool limitation. C-Solidly (Velodrome, Aerodrome) shows 91%. The aggregate is misleading.
\** Solidly veNFT contracts are probe-reliable (Solidity + custom errors). Curve-family Vyper contracts are probe-limited.

---

## Category A: The Gold Standard (7 DAOs)

**Compound Governor Bravo** (score 100) is the corpus ceiling: 19/19 gated, zero suspicious passes, require-string error messages on every function. The pattern: access checks via `require(msg.sender == admin)` or `require(msg.sender == timelock)` at the top of each function body.

**Key findings across Category A:**

| Protocol | Score | Gate Rate | Admin Pattern | Notable |
|----------|-------|-----------|---------------|---------|
| Compound | 100 | 19/19 (100%) | Timelock + admin | Reference implementation |
| Nouns V3 | 92 | 19/19 (100%) | Delegate dispatch + custom errors | Modern rebranded Bravo |
| Gitcoin Alpha | 90 | 6/6 (100%) | GovernorAlpha (immutable) | Zero admin setters in bytecode |
| Arbitrum | 87 | 11/13 (85%) | OZ Governor + Ownable relay | setVotingDelay/Period false-pos (ABI mismatch) |
| Uniswap | 85 | 17/19 (89%) | Governor Bravo | 2 deployment-state early returns |
| ENS | 84 | 7/13 (54%) | GovernorCompatibilityBravo | 6 not-implemented (conservative deployment) |
| Optimism Agora | 84 | 12/13 (92%) | OZ Governor + custom manager | Manager can cancel any proposal |

**Pattern:** Compound-family Bravo forks achieve the highest gate rates because `require(string)` in function preambles is the most probe-friendly access pattern. OZ Governor contracts (Arbitrum, ENS, Optimism) score lower because of ABI version mismatches and conservative deployments that leave functions unimplemented.

**The Gitcoin insight:** GovernorAlpha's score (90) comes from having FEWER functions, not from gating more. Zero admin setters means zero admin attack surface. The safest admin function is one that doesn't exist. Immutability is an underappreciated governance strength.

**The Optimism insight:** A custom manager role with cancel authority OFF the governance vote path. The Optimism Foundation (or equivalent) can cancel any proposal without a vote. This is the only Category A contract with an out-of-band cancel path — an architectural choice that trades decentralization for safety.

---

## Category B: The Unreadable Layer (2 DAOs)

| Protocol | Score | Gate Rate | Authority Pattern |
|----------|-------|-----------|-------------------|
| Lido Aragon | 72 | 6/8 (75%) | Aragon kernel ACL (APP_AUTH_FAILED) |
| MakerDAO Chief | 35 | 1/9 (11%) | ds-auth external Authority call |

**Pattern:** External-authority contracts delegate their permission check to a separate contract. The probe tool cannot evaluate the *other* contract's logic — it only sees whether the checked function reverts. MakerDAO's 11% gate rate is a TOOL LIMITATION, not a security signal. Maker has 6+ years of production without known exploits.

**Lesson:** Low scores in Category B mean "we cannot measure this", not "this is insecure." The detection heuristic (`detectProbeReliabilityPatterns`) flags these automatically so operators don't misinterpret.

---

## Category C: Three Sub-Families (6 DAOs)

Category C contains the most architectural diversity:

### C-Vyper (Curve, Frax): probe-limited

| Protocol | Gate Rate | Vyper Flag | veToken Flag |
|----------|-----------|------------|--------------|
| Curve VE | 1/10 (10%) | Yes | Yes |
| Curve GC | 1/9 (11%) | Yes | No |
| Frax veFXS | 1/10 (10%) | Yes | Yes |

Vyper orders parameter validation before `assert msg.sender == self.admin`, so default-parameter burner probes hit early returns before the permission check. Scores are NULL (not zero) because measurement is unreliable.

### C-Solidity-fork (Balancer): partially reliable

| Protocol | Gate Rate | Vyper Flag | Notable |
|----------|-----------|------------|---------|
| Balancer veBAL | 1/10 (10%) | No | 2 suspicious admin passes (smart_wallet_checker) |

Balancer is a Solidity reimplementation of Curve's veCRV math. The Vyper tool-limitation does NOT apply, making the 2 suspicious passes on `commit_smart_wallet_checker` and `apply_smart_wallet_checker` potentially real findings (pending source verification).

### C-Solidly-veNFT (Velodrome, Aerodrome): fully reliable

| Protocol | Score | Gate Rate | Error Style |
|----------|-------|-----------|-------------|
| Velodrome V2 | 85 | 10/11 (91%) | Custom errors (NotTeam, NotVoter) |
| Aerodrome | 85 | 10/11 (91%) | Identical custom errors (bytecode sibling) |

Solidly-style veNFT governance uses Solidity with clean custom errors. The probe tool works perfectly. This sub-family has the cleanest signal in all of Category C.

**The capture dimension:** veToken contracts have a second governance surface beyond access control: WHO HOLDS THE TOKENS. Convex controls 53.69% of veCRV, Aura controls 68.39% of veBAL (see vetoken-capture-comparison.md). Access control tells you "who can call admin functions." Capture measurement tells you "who controls the votes." Both are needed for a complete picture.

---

## Category D: Growing Admin Surface (2 DAOs)

| Protocol | Score | Gate Rate | Ownable Functions | Risk |
|----------|-------|-----------|-------------------|------|
| Aave V2 | 60 | 7/10 (70%) | 1 (setGovernanceStrategy) | Single owner swaps voting-power contract |
| Aave V3 | 50 | 9/12 (75%) | 5 (add/removeVotingPortals, setPowerStrategy, transferOwnership, renounceOwnership) | 5x admin surface vs V2 |

**Pattern:** Aave's "trust-minimization upgrade" (V2 to V3) expanded the Ownable-gated admin surface from 1 to 5 functions. More gates passed the probe (higher gate rate), but more admin functions exist (larger attack surface). Gate rate alone is misleading — admin surface area matters.

**Error style regression:** V2 uses plain-text error messages ("sender is not the governance"). V3 uses numeric error codes ("2", "7", "9"). This reduces on-chain auditability.

---

## Cross-Cutting Findings

### 1. Immutability beats gatekeeping

Gitcoin Alpha (score 90, zero admin functions) is architecturally safer than Compound (score 100, 19 well-gated functions). You cannot exploit an admin function that doesn't exist. Protocol teams should consider which admin parameters genuinely need runtime modification.

### 2. Proxy sophistication creates measurement gaps

EIP-1967 proxies (Arbitrum, ENS, Optimism) add a layer of indirection. The probe follows EIP-1967 slots to find implementations, but legacy proxies (Compound's GovernorBravoDelegator) need `--skip-code-check`. Non-standard proxy patterns are the #1 source of measurement errors.

### 3. Error style signals maturity

- **Custom errors** (Nouns V3, Velodrome): most informative, cheapest gas
- **Require-strings** (Compound, Uniswap): readable but expensive gas
- **Numeric codes** (Aave V3): cheapest but opaque

The trend from require-strings to custom errors is positive for both gas efficiency and auditability. The trend to numeric codes (Aave V3) is negative for auditability.

### 4. The L2 Governor pattern

Both Arbitrum Core Governor and Optimism Agora Governor show `setVotingDelay`/`setVotingPeriod` passing from a burner despite being `onlyGovernance`-gated in reality. This is an ABI version mismatch (OZ Governor v5 ABI uses uint48/uint32, implementations use uint256 with different selectors). Not a security finding, but a consistent L2 deployment pattern worth tracking.

### 5. Cross-chain deployment doesn't change architecture

Velodrome (Optimism) and Aerodrome (Base) are bytecode siblings with identical custom error codes. Cross-chain deployment clones the access model exactly. The interesting governance differences are between protocol families, not between chains.

---

## Recommendations for Protocol Teams

1. **Minimize admin surface area.** Every admin function is an attack surface. If a parameter doesn't need runtime changes, make it immutable.
2. **Use custom errors, not numeric codes.** They're cheaper than require-strings and more auditable than numbers.
3. **If using veToken governance, plan for aggregator capture.** 50-70% concentration is structural, not a failure.
4. **Prefer inline modifiers over external authority patterns.** They're more auditable by third parties.
5. **Document proxy architecture explicitly.** The biggest audit friction is proxy indirection, not access control logic.

---

## Data Sources

All probe artifacts: `agent/scripts/probe-*.json`
Corpus index: `agent/brain/Knowledge/audit-corpus-index.json`
Capture data: `agent/artifacts/research/vetoken-capture-comparison.md`
Leaderboard: `docs/governance-health-leaderboard-v3.md`
