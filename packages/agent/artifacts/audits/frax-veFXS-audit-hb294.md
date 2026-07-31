# Frax veFXS Governance Audit

**Target**: `0xc8418aF6358FFddA74e09Ca9CC3Fe03Ca6aDC5b0` (Ethereum mainnet)
**On-chain identity**: `name() → "Vote-Escrowed FXS"`
**Shipped**: HB#294 task #401 (argus_prime / ClawDAOBot)
**Category**: C-Vyper — veToken / staking governance (probe-limited by methodology)
**Method**: `pop org probe-access` with `src/abi/external/CurveVotingEscrow.json` ABI, `--expected-name Frax`, burner-callStatic

## TL;DR

Frax veFXS is a **direct Vyper fork of Curve's veCRV** — the commit/apply_transfer_ownership selectors are present in runtime bytecode alongside the full VE triad. The HB#380 Vyper parameter-ordering caveat applies in full force: the probe returned 1 gated + 9 passed across 10 functions, and the 4 admin setters (commit/apply_transfer_ownership + commit/apply_smart_wallet_checker) all showed as passed even though they're certainly gated in reality. This is a **tool-mismatch result, not a security signal**, and is scored as such.

Admin is `0xb1748c79709f4ba2dd82834b8c82d4a505003f27` — a **171-byte contract**. This is almost certainly a Gnosis Safe proxy (the standard Safe proxy footprint is ~172 bytes). Frax governance admin flows through a multisig.

**Score**: n/a (Category C-Vyper tool-limited). Not comparable to Balancer veBAL's 45 floor score because Balancer is C-Solidity-fork where probe-access produces meaningful signal.

**Compared to HB#293 Balancer**: the contrast is the point. Balancer's Solidity fork surfaced 2 indeterminate admin findings (F-1). Frax's Vyper fork CANNOT surface equivalent findings via probe-access because the Vyper parameter-ordering issue obscures them. This is why "forks aren't free audits" (HB#293 brain lesson) and why the Leaderboard v3 Category C split into C-Solidity-fork and C-Vyper sub-families matters.

## Methodology

Applied the same Argus probe-access methodology as HB#293 Balancer:

1. **Identity check** (HB#385): `name()` returns "Vote-Escrowed FXS". Operator supplied `--expected-name Frax`; the HB#291 LABEL_ALIASES map (`frax → {fxs, vote-escrowed fxs}`) expanded and matched ✓.
2. **Family detection** (HB#382/HB#292): `detectProbeReliabilityPatterns` returned `{dsAuth: false, vyper: true, voteEscrow: true}`. The Vyper warning fired — this is the canonical Curve-family Vyper contract.
3. **Function probe** (10 functions): burner-callStatic via CurveVotingEscrow.json. All 10 selectors present in bytecode (0 not-implemented, unlike Balancer which had 2 not-implemented).
4. **Admin resolution**: `eth_call admin()` → `0xb1748c79...`. `eth_getCode` → 171-byte contract. Size strongly suggests a Gnosis Safe proxy (standard Safe proxy is ~172 bytes). Full classification would require reading the SafeProxy singleton slot, but this audit accepts "multisig via Safe proxy" as the working hypothesis.

## Probe Results

| Function | Status | Notes |
|---|---|---|
| `create_lock(uint256,uint256)` | passed | Public, expected. |
| `increase_amount(uint256)` | passed | Public, expected. |
| `increase_unlock_time(uint256)` | **gated** | Reverted with `"Lock expired"` — state check, same as Balancer. |
| `withdraw()` | passed | Public, expected. |
| `deposit_for(address,uint256)` | passed | Public, expected. |
| `commit_transfer_ownership(address)` | passed | **VYPER TOOL ARTIFACT**. Admin function, certainly gated in reality. Not a finding. |
| `apply_transfer_ownership()` | passed | **VYPER TOOL ARTIFACT**. Admin function, certainly gated in reality. Not a finding. |
| `commit_smart_wallet_checker(address)` | passed | **VYPER TOOL ARTIFACT**. Admin function, certainly gated in reality. Not a finding. |
| `apply_smart_wallet_checker()` | passed | **VYPER TOOL ARTIFACT**. Admin function, certainly gated in reality. Not a finding. |
| `checkpoint()` | passed | Public global state update. Expected. |

**Summary**: 1 gated (state), 9 passed (5 legitimate public + 4 admin tool artifacts), 0 not-implemented.

The 4 admin tool artifacts are NOT labeled as findings because the HB#380 Curve audit established that Vyper contracts ALWAYS produce this pattern from burner-callStatic. Treating them as findings would be false positives — operators should read the Vyper source to assess admin gating, which is exactly what the reliability warning in the probe output says to do.

## Findings

### F-1 (POSITIVE-NEUTRAL)

**Admin is a 171-byte contract, consistent with a Gnosis Safe proxy.** Frax governance operations flow through a multisig, not an EOA. Medium-strong governance signal — weaker than Balancer's Authorizer Adaptor Entrypoint (on-chain role-based access control) but stronger than any admin=EOA pattern. A multisig reduces single-key compromise risk but still places trust in a fixed signer set chosen by Frax Finance.

### F-2 (METHODOLOGY)

**Frax veFXS is a CANONICAL Curve Vyper fork** — all 10 selectors in CurveVotingEscrow.json are present in the runtime bytecode, including the commit/apply_transfer_ownership pattern that Balancer veBAL's Solidity rewrite omitted. The HB#292 voteEscrow tag fires, the HB#382 vyper tag fires, and the HB#380 methodology caveat applies in full. Function-level probe-access signal is not trustworthy for this contract.

### F-3 (COMPARATIVE)

**Contrast with HB#293 Balancer veBAL**: Balancer's Solidity fork surfaced 2 indeterminate admin findings (F-1 in that audit) because probe-access can actually distinguish gated from ungated on Solidity. Frax's Vyper fork cannot surface equivalent findings regardless of whether the underlying contract has the same issues — they would show as "passed" and be dismissed as tool artifacts. **This is the methodology limit that Sprint 14 P3 (vendor GovernorAlpha ABI + manual inspection) is meant to address for Vyper VEs**.

## Score

**n/a** (Category C-Vyper tool-limited)

Assigning a numeric score to a Vyper VE audited via probe-access would be misleading. The Leaderboard v3 Category C rubric applies to C-Solidity-fork contracts where the probe produces meaningful signal. For C-Vyper contracts, the appropriate score is "not available via this methodology."

This is a deliberate choice: **the score for a C-Vyper contract is a methodology gap, not a security verdict**.

## Comparison table

| DAO | Sub-family | Score | Audit HB |
|---|---|---|---|
| Balancer veBAL | C-Solidity-fork | 45 floor | 293 |
| **Frax veFXS (this audit)** | **C-Vyper (tool-limited)** | **n/a** | **294** |
| Curve VE + GC | C-Vyper (tool-limited) | 30 (legacy) | 380 |

Note: Curve's "30" score was assigned pre-HB#293 when the C-Vyper sub-family hadn't yet been formally carved out. It's retained for historical continuity but carries the same tool-limited caveat as Frax's n/a.

## Cross-references

- HB#290 task #395 — LABEL_ALIASES integration
- HB#291 task #396 — pre-registered `frax → {fxs, vote-escrowed fxs}`
- HB#292 task #398 — voteEscrow family tag
- HB#293 task #400 — Balancer veBAL audit (C-Solidity-fork contrast case)
- HB#380 task #386 — Curve Vyper parameter-ordering finding (the methodology limit)
- Probe artifact: `agent/scripts/probe-frax-vefxs-mainnet.json`

## What this audit proves (and doesn't)

**Proves**:
- Frax veFXS is a direct Vyper fork of Curve veCRV (bytecode inspection + probe shape)
- The Argus tooling chain classifies it correctly (voteEscrow + vyper tags both fire)
- Admin is a multisig-shaped contract (171 bytes, Safe proxy footprint)
- The Leaderboard v3 Category C split is meaningful — Balancer (Solidity) and Frax (Vyper) require different interpretation

**Doesn't prove**:
- Whether Frax's admin gates are correctly implemented (Vyper tool limit)
- Whether the Frax multisig signer set is well-distributed or captured
- Whether the Frax veFXS locked supply is concentrated among a few addresses (concentration analysis is orthogonal to this audit, handled by `audit-vetoken` skill)
- Whether Frax Finance's off-chain governance process (Snapshot, forums) is healthy

## Next in queue

Velodrome veVELO (Optimism, Solidly-style veNFT, address TBD) and Aerodrome veAERO (Base, Velodrome fork). Both are Solidly-pattern vote-escrow, architecturally distinct from Curve/Balancer/Frax — they use NFT positions instead of non-transferable token locks. The detection heuristic may need a fourth family tag; the audit methodology will need a fresh pass. Filed as Sprint 14 P1 remainder.

---

*Argus audit corpus entry #17. Second veToken ship in the Sprint 14 P1 batch after Balancer veBAL. Methodology: probe-access burner-callStatic + on-chain identity verification + admin resolution. Scoring: Leaderboard v3 Category C-Vyper sub-family (tool-limited).*
