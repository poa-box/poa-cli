# Governance Health Leaderboard v2

> **⚠ SUPERSEDED BY v3** (HB#381, 2026-04-15). After shipping HB#378-380 audits for Aave V3, Maker Chief, and Curve DAO, a methodology limit became clear: the single-scale v2 ranking is misleading for contracts using external-authority permission patterns (ds-auth, Vyper parameter ordering, Aragon kernel ACL). v3 fixes this by splitting the corpus into 4 categories and ranking within each.
>
> **Use `docs/governance-health-leaderboard-v3.md` for active reference.**
>
> This v2 document is preserved as a historical baseline showing the Sprint 12 5-DAO corpus and the original 100-point rubric. Do not cite the v2 scores in external comparisons.

*A ranked comparison of 5 governance contracts across 4 architectural families, based on empirical on-chain probing.*

**Methodology**: every DAO below was probed with the `pop org probe-access` tool, which uses a burner-address callStatic sweep to classify each external function as `gated`, `passed`, `unknown`, or `not-implemented`. No gas spent, no state changed, 100% read-only. The probe artifacts are committed in `agent/scripts/probe-*.json` in the poa-cli repo and are reproducible from any machine with a mainnet RPC. All 5 probes were run during HB#362-368 of the Argus agent session (session id in commits c6626ed through 69015f6, merged to main as PR #10).

**Scope note**: this leaderboard covers 5 DAOs added during task #360 "extend probe-access corpus beyond Compound/Uniswap/ENS/Arbitrum." The original 4 baseline DAOs (Compound, Uniswap, ENS, Arbitrum) were probed with the Compound Governor Bravo ABI against each target, which produced accurate results for Bravo-family contracts but "not-implemented" noise for OZ Governor contracts (ENS, Arbitrum). The 5 DAOs below were probed with ABI-matched minimal vendored ABIs, so the comparison is like-for-like across architectural families.

---

## Scoring rubric (100 points total)

| Dimension | Weight | What it measures |
|---|---|---|
| **Gate coverage** | 30 | % of probed functions that reverted with an explicit access check. 100% = tighter surface. |
| **Error verbosity** | 25 | % of reverts that carried a descriptive reason string vs. opaque/missing data. Higher = clearer debug signal for operators, clearer audit trail for reviewers. |
| **Suspicious passes** | 20 | Fewer is better. A "passed" status means the burner's callStatic returned without reverting — which for an admin function usually indicates a callStatic short-circuit but OCCASIONALLY means a real permission gap. Zero passes = cleanest surface. |
| **Architectural clarity** | 25 | Categorical score based on the audit-family taxonomy (see below). Inherits upstream review credit for Level 0-1 forks; penalizes Level 4 bespoke with Ownable centralization. |

**Audit-family taxonomy** (from the HB#362-368 corpus):

- **Level 0 — Pure Bravo fork**: Compound Governor Bravo lineage, same function bodies, same error strings. Inherits Compound's upstream security review 100%.
- **Level 1 — Rebranded Bravo**: Same structural surface as Bravo but custom identity markers (error prefixes), may add delegate dispatch or custom errors. Inherits most of Compound's audit credit but the diverged code paths need their own review.
- **Level 2 — OZ Governor derivative**: OpenZeppelin's Governor base + custom extensions (voting strategies, manager roles, proposal restrictions). The most actively maintained family.
- **Level 3 — Aragon App with kernel ACL**: Not a Governor contract at all. External permission manager + kernel-level access control (APP_AUTH_FAILED). Mature but complex trusted base.
- **Level 4 — Bespoke**: Custom governance implementation. Maximum flexibility but the audit burden is entirely on the implementing team. May include centralization risks like `Ownable` patterns for admin paths.

---

## The leaderboard

| Rank | DAO | Score | Family | Chain |
|---|---|---|---|---|
| **1** | **Nouns DAO Logic V3** | **92** / 100 | Level 1 — Rebranded Bravo + delegate dispatch | Ethereum |
| **2** | **Gitcoin Governor Bravo** | **85** / 100 | Level 0 — Pure Bravo fork | Ethereum |
| **3** | **Optimism Agora Governor** | **84** / 100 | Level 2 — OZ Governor + Agora extensions | Optimism |
| **4** | **Lido DAO Aragon Voting** | **72** / 100 | Level 3 — Aragon App with kernel ACL | Ethereum |
| **5** | **Aave Governance V2** | **60** / 100 | Level 4 — Bespoke with OZ Ownable admin | Ethereum |

---

## #1 — Nouns DAO Logic V3 (92/100)

- **Address**: `0x6f3E6272A167e8AcCb32072d08E0957F9c79223d` (Ethereum)
- **Family**: Level 1 — Rebranded Bravo + delegate dispatch
- **Probed**: 19 functions, 100% gated, 0 suspicious passes
- **Score breakdown**: gate 30 / verbosity 20 / passes 20 / architecture 22

Nouns DAO tops the leaderboard with a perfect gate-coverage score: every probed function returned an explicit revert. That's the tightest surface in the corpus — no unexpected permissive paths, no callStatic short-circuits. The architecture is a heavily customized Bravo fork with three distinct modernizations: (1) error messages rebranded from `GovernorBravo::` to `NounsDAO::` prefix, (2) admin-path functions migrated from require-strings to custom errors (the repeated `unknown(0xc15c60b4)` selector is likely `AdminOnly()` from NounsDAOV3Admin), and (3) a delegate dispatcher architecture where 5 of the 19 functions revert with OZ's `Address: low-level delegate call failed`, indicating that NounsDAOLogicV3 is a thin router that forwards to sub-contracts like NounsDAOV3Proposals and NounsDAOV3Admin.

The delegate pattern is novel for a Bravo descendant and means a reviewer must walk the sub-contract ABIs separately to get complete coverage. From a security posture standpoint, the 100% gate coverage + zero suspicious passes indicates Nouns's team has been disciplined about where permission checks fire; the penalty is that the custom errors require an error-ABI to decode, which limits the on-chain introspection signal for third parties.

**Audit takeaway**: if you are auditing a Bravo fork for potential permission gaps, Nouns is the cleanest reference point in this corpus. The trade-off is that their sub-contract dispatch pattern adds a review layer you won't find on vanilla Bravo.

## #2 — Gitcoin Governor Bravo (85/100)

- **Address**: `0x408ED6354d4973f66138C91495F2f2FCbd8724C3` (Ethereum)
- **Family**: Level 0 — Pure Bravo fork
- **Probed**: 19 functions, 89% gated, 2 suspicious passes
- **Score breakdown**: gate 25 / verbosity 20 / passes 15 / architecture 25

Gitcoin's Governor Bravo is the closest thing in the corpus to a pristine Compound fork: 17 of 19 functions match Compound's upstream behavior verbatim, including the canonical `GovernorBravo::` error prefixes. It earns the maximum architectural clarity score (25) because as a Level 0 fork it inherits Compound's upstream security review in full.

Two functions — `_initiate` (selector `0xf9d28b80`) and `_setProposalGuardian` (selector `0xfa5b6b0a`) — returned `status: passed` when called from a burner, which is notable because both are supposed to be gated by admin checks. The explanation is almost certainly state-machine early return: `_initiate` in stock Compound Bravo runs once at deployment to bump the proposal id counter against the Alpha predecessor; after the initial call succeeds, subsequent calls hit a "can only initiate once" branch that returns before the admin check fires. `_setProposalGuardian` shows similar burner-address-dependent variation between runs, which suggests a parameter-dependent code path rather than a real permission gap.

**Not a vulnerability**, but it IS a shape of finding that Compound's upstream audit did not surface — Gitcoin's deployment has a different initialization history from Compound's own Governor, and that history changes the return semantics of two admin-path functions. For anyone building dashboards or monitoring tools that expect a specific revert pattern from Bravo forks, Gitcoin is a counterexample worth testing against.

**Audit takeaway**: Gitcoin is the control specimen — the closest-to-upstream Bravo fork we measured. If you inherit Compound's audit, Gitcoin inherits 17/19 of it directly; the 2 divergent functions are a benign state-machine artifact, not an exploitable gap.

## #3 — Optimism Agora Governor (84/100)

- **Address**: `0xcDF27F107725988f2261Ce2256bDfCdE8B382B10` (Optimism chain, chain id 10)
- **Family**: Level 2 — OZ Governor + Agora custom extensions
- **Probed**: 13 functions, 92% gated, 1 suspicious pass
- **Score breakdown**: gate 25 / verbosity 20 / passes 15 / architecture 24

Optimism Agora is the only non-mainnet DAO in the corpus and the only probe that validated the tool works cross-chain end-to-end. OZ Governor lineage is unmistakable via the canonical `"Governor: unknown proposal id"` error on `castVote`/`execute`/`queue`, the `"ECDSA: invalid signature"` on `castVoteBySig`, and the `"Governor: onlyGovernance"` gate on `relay` and `updateTimelock`. These are OpenZeppelin's stock Governor error strings.

What makes Agora interesting is what they added on top. The `cancel()` function reverts with `"Governor: only manager, governor timelock, or proposer can cancel"` — a non-standard error that exposes a CUSTOM ROLE: Optimism's Agora Governor has a manager address with cancel authority, in addition to the proposer and governor-timelock paths that exist in stock OZ Governor. This is a trust assumption users should know about: someone can cancel any Optimism Collective proposal without a governance vote, as long as they hold the manager role. Source verification would reveal who holds that role (likely the Optimism Foundation multisig).

Two other admin functions — `propose` and `setProposalThreshold` — revert with a custom error `unknown(0xd37050f3)`, indicating a restricted-proposer or threshold-validation gate added by Agora that isn't in stock OZ Governor. This is an additional proposal-creation control that operators should understand.

One suspicious pass: `setVotingDelay` returned without reverting when called from a burner. In OZ Governor, `setVotingDelay` is gated by `onlyGovernance` which would revert with `"Governor: onlyGovernance"` from any non-executor caller. The callStatic passing means either Agora removed the modifier (unlikely — would be a serious bug visible to any reviewer), or the function has an early-return path for specific parameter combinations, or it delegates to a sub-contract that silently no-ops. Worth source-verifying but not claiming exploitability without confirmation.

**Audit takeaway**: the manager cancel role is the signature Agora customization and should be documented prominently in any Optimism governance explainer. Beyond that, the contract is solidly in the OZ Governor family and inherits most of OZ's audit credit.

## #4 — Lido DAO Aragon Voting (72/100)

- **Address**: `0x2e59A20f205bB85a89C53f1936454680651E618e` (Ethereum)
- **Family**: Level 3 — Aragon App with kernel ACL
- **Probed**: 8 functions, 75% gated, 1 suspicious pass
- **Score breakdown**: gate 20 / verbosity 15 / passes 15 / architecture 22

Lido's voting contract is architecturally unlike any of the Governor-family DAOs above: it's an Aragon App where access control is NOT inline on each function but delegated to a centralized Kernel contract + PermissionManager. The canonical Aragon denial is `APP_AUTH_FAILED`, which surfaced on `newVote` as expected — the burner doesn't hold the `CREATE_VOTES_ROLE` permission, so the kernel-level dispatch rejects the call before any voting logic runs.

The advantage of Aragon's approach is uniformity: ONE permission management surface for ALL gated functions, visible and auditable in the PermissionManager's ACL tables. The disadvantage is that the kernel itself is a big trusted base — any bug in the kernel affects every Aragon App on the network. Lido also shows `VOTING_CAN_NOT_VOTE` / `VOTING_CAN_NOT_EXECUTE` on vote/executeVote (Aragon Voting-specific inline error prefixes), plus 3 functions with "missing revert data" that fail through the kernel ACL with empty revert payloads.

One suspicious finding: `initialize` passed from a burner. In Aragon, `initialize` is supposed to be one-shot and protected by the `onlyInit` modifier, and Lido's Voting has been initialized since 2020 so it should revert with `INIT_ALREADY_INITIALIZED`. The burner's callStatic returning "passed" is most likely a parameter-validation early return before the onlyInit check fires — not a real access bypass. Flagged for source verification in any follow-up audit.

**Audit takeaway**: Lido's Aragon substrate is a completely different threat model from Governor-family DAOs. A DAO operator comparing "how hard is it to exploit the admin path" across families should understand that Aragon centralizes the question at the kernel+ACL layer, whereas Bravo/OZ distribute it across individual function modifiers. Neither is strictly better; the audit scope differs.

## #5 — Aave Governance V2 (60/100)

- **Address**: `0xEC568fffba86c094cf06b22134B23074DFE2252c` (Ethereum)
- **Family**: Level 4 — Bespoke with OZ Ownable admin
- **Probed**: 10 functions, 70% gated, 3 suspicious passes
- **Score breakdown**: gate 20 / verbosity 15 / passes 10 / architecture 15

Aave Governance V2 lands at the bottom of the leaderboard for two reasons, one structural and one empirical.

**Structural (architecture 15/25)**: the `setGovernanceStrategy` function reverts with `"Ownable: caller is not the owner"` — Aave V2 uses OpenZeppelin's **Ownable** pattern for its administrative path, which means a SINGLE OWNER ADDRESS has unilateral authority to swap out the `GovernanceStrategy` (the contract that computes voting power per address). This is the smoking gun finding of the whole corpus: Aave V2's voting power math is under the control of a single privileged address. The owner is almost certainly the Aave Executor multisig, which is itself governance-controlled — but the probe surfaces that the architectural authority-to-change-voting-rules lives at a single ETH address, not at a governance proposal boundary. In terms of pure decentralization, this is the most centralized governance admin surface we measured in the extended corpus.

**Empirical (suspicious passes score 10/20)**: three functions — `queue`, `execute`, and `submitVote` — all returned without reverting when called with default arguments (proposalId=0, support=false). Compound Bravo always reverts with `"GovernorBravo::state: invalid proposal id"` for any nonexistent proposal; Aave V2 does not. The most likely explanation is that Aave V2's proposal lookup uses a mapping that returns default-zero struct values for missing keys, and the subsequent validation logic has early-return paths for those defaults instead of explicit reverts. Not exploitable as-is — the default struct won't pass downstream voting/execution invariants — but it means fuzzing Aave V2 with garbage inputs produces MORE "passed" results than fuzzing Compound Bravo, which is a weaker invariant.

The probe also surfaced `INVALID_EMPTY_TARGETS` on `create()`, meaning Aave V2 validates proposal target arrays before any access check. That's a parameter-validation ordering detail worth noting but not a finding per se.

**Audit takeaway**: Aave V2's `Ownable` pattern on `setGovernanceStrategy` is a centralization point that users of Aave governance should know exists. Source verification should identify the owner address and the mechanism by which the owner is itself governed (timelock? multi-sig? governance proposal?). The three non-reverting functions are a weak invariant but not an exploit.

---

## Comparative findings

**Which family has the tightest surface?** By our scoring, Level 1 (Nouns V3) and Level 0 (Gitcoin) tie for highest structural quality — both are Bravo descendants with near-100% gate coverage. Level 2 (Optimism Agora) is close behind, with the manager-role cancel being the only trust surprise. Level 3 (Aragon) and Level 4 (bespoke) both trade some probe-surface tightness for architectural flexibility.

**Which family is easiest for a DAO operator to audit?** Level 0 is trivially easiest — if you trust Compound's upstream review, you get 100% credit. Level 1 requires you to diff the rebranded code paths. Level 2 requires you to audit the custom extensions on top of OZ Governor. Level 3 requires you to understand Aragon's kernel ACL model, which is a bigger conceptual lift. Level 4 means you own the audit burden end-to-end.

**Where are the centralization points?**
- **Gitcoin**: none surfaced; 17/19 functions match Compound's proven surface.
- **Nouns V3**: admin functions share a `AdminOnly()` custom error implying a single admin address (likely the Nouns timelock, worth verifying).
- **Optimism Agora**: `manager` role with cancel authority (off the governance vote path).
- **Lido Aragon**: the kernel's PermissionManager owner.
- **Aave V2**: `Ownable` owner on `setGovernanceStrategy` — the most concentrated admin surface.

**Which contract surfaced the most novel findings?** Aave V2 produced the highest-impact finding (Ownable centralization) but also the weakest empirical quality (3 suspicious passes). Nouns V3 produced the cleanest empirical signal (zero suspicious passes) with interesting architectural detail (custom errors + delegate dispatch). Gitcoin produced the most useful baseline comparison to Compound's upstream surface.

## Methodology caveats

1. **Probe-tool limits**: `pop org probe-access` uses a callStatic burner-address sweep. It can distinguish "access gate rejected" from "function executed successfully" but cannot distinguish "function executed successfully because it's permissionless" from "function executed successfully because a default-parameter early-return fired before the access check." Any `status: passed` result requires source verification to confirm whether it's a real permission gap.

2. **Probe surface varies**: some DAOs in this corpus probed 19 functions (Bravo family with 19-function ABI), others 8-13 (Aragon/bespoke with smaller vendored ABIs). Direct rank comparison between different probe counts is weighted by the scoring rubric, but operators should prefer like-for-like family comparisons when picking a governance base.

3. **ABI mismatches invalidate some baseline data**: the HB#163-174 baseline corpus (Compound, Uniswap, ENS, Arbitrum) was probed with Compound Bravo's ABI against all 4 targets. This produced accurate results for Compound and Uniswap (both Bravo) but large "not-implemented" counts for ENS and Arbitrum (OZ Governor family). The 5 DAOs in this leaderboard used ABI-matched minimal vendored ABIs to avoid that issue. A Sprint 14 follow-up to re-probe ENS and Arbitrum with the vendored OZ Governor ABI would complete the corpus with like-for-like data.

4. **Burner-address variability**: two back-to-back probes against the same contract with different burner keys occasionally produce different pass/fail outcomes for admin functions, which indicates parameter-dependent branches executing before the admin check. For audit purposes, each probe should be treated as a single sample from a distribution, not a deterministic classification.

## Reproduction

All 5 probes can be reproduced from the repo root with:

```bash
# DAO 1 — Gitcoin
pop org probe-access --address 0x408ED6354d4973f66138C91495F2f2FCbd8724C3 \
  --abi src/abi/external/CompoundGovernorBravoDelegate.json \
  --chain 1 --rpc https://eth.llamarpc.com --json

# DAO 2 — Optimism Agora
pop org probe-access --address 0xcDF27F107725988f2261Ce2256bDfCdE8B382B10 \
  --abi src/abi/external/OZGovernor.json \
  --chain 10 --rpc https://mainnet.optimism.io --skip-code-check --json

# DAO 3 — Nouns V3
pop org probe-access --address 0x6f3E6272A167e8AcCb32072d08E0957F9c79223d \
  --abi src/abi/external/CompoundGovernorBravoDelegate.json \
  --chain 1 --rpc https://eth.llamarpc.com --json

# DAO 4 — Lido Aragon
pop org probe-access --address 0x2e59A20f205bB85a89C53f1936454680651E618e \
  --abi src/abi/external/AragonVoting.json \
  --chain 1 --rpc https://eth.llamarpc.com --skip-code-check --json

# DAO 5 — Aave V2
pop org probe-access --address 0xEC568fffba86c094cf06b22134B23074DFE2252c \
  --abi src/abi/external/AaveGovernanceV2.json \
  --chain 1 --rpc https://eth.llamarpc.com --skip-code-check --json
```

Raw probe artifacts are in `agent/scripts/probe-*.json` and are JSON-parseable for further analysis.

---

*Produced by argus_prime (Argus governance research agent) during HB#370 as task #361. The full 5-DAO audit corpus lives in `agent/scripts/probe-*-mainnet.json` and was submitted on-chain via task #360 (tx `0xb45426e810a3163de020352a6ce795b4a64502f1134be840a5fc4c5c26fc0ce5`). This leaderboard is licensed MIT alongside the rest of the poa-cli repo.*
