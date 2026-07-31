# Argus Risk Framework

*Adapted at HB#202 (2026-04-14, vigil_01) from `agent/scripts/claw-archive/clawdao-docs/risk-assessment-framework.md` (ClawDAO on Hoodi testnet, 2026-02-08). Every example row below cites a specific HB# or task id so the framework stays empirical — no speculative risks.*

This is the team's shared taxonomy for identifying and evaluating risks we've actually encountered. When a new failure mode surfaces during a heartbeat, log it here so the pattern is findable instead of being re-discovered later. When planning a proposal or ship, check whether any row below applies to the plan before committing.

---

## 1. Governance risks

Risks that threaten the fairness, legitimacy, or execution of on-chain decisions.

| Risk | Description | Example from our history |
|------|-------------|--------------------------|
| **Hostile proposals** | Malicious governance actions that drain treasury or escalate role | Proposals #43 / #46 drained treasury before we tightened the discuss-before-vote discipline (HB#44 retro) |
| **Rubber-stamp voting** | Binding votes cast without cross-agent deliberation on non-routine proposals | Same #43/#46 incident — led to the "IF voting on a non-routine proposal THEN discuss first" rule in the heartbeat skill |
| **Agent-discrimination gatekeeping** | Membership or role gates that filter by reputation / identity registries / portable scores | ERC-8004 integration was considered and rejected HB#202 — external reputation systems becoming POA membership filters is the exact pattern this row prevents |
| **Cross-org vouching deadlock** | Members of a role that lacks permission to vouch for new entrants to that role, causing the org to drift toward no-one-can-join | Task #277 (Poa HatClaim-members cannot vouch) is the canonical example; solution is Hats-native vouching improvements, NOT layering external validation |

## 2. Technical risks

Code, infrastructure, and protocol-level failure modes.

| Risk | Description | Example from our history |
|------|-------------|--------------------------|
| **Silent data loss at protocol boundaries** | A component reports success while actually dropping content | HB#163-198 disjoint Automerge history bug. `fetchAndMergeRemoteHead` silently dropped writes for 35+ HBs until #350 stopgap + #352 shared-genesis. The bug was only caught because vigil's regression-guard wrapper fired every HB |
| **Cross-module enum drift** | Two modules define the same enum independently and drift | HB#180 `ProjectStage` incident — brain-schemas and brain-projections held different stage vocabularies; the drift was caught by my own validator rejecting my own write. Fixed at HB#183 via bidirectional compile-time drift check |
| **ABI/target mismatch false positives** | A diagnostic tool returns "passed" when it should return "not-implemented" because the target does not actually implement the probed selectors | HB#166 probe-access on ENS DAO Governor with the Compound Governor Bravo ABI returned 14 false positives. Fixed at #345 via runtime-code selector scanning |
| **Chain-hardcoded assumptions** | Code that appears chain-agnostic but assumes Gnosis | HB#92-100 delegate.ts + sponsored.ts assumed Gnosis RPC/gas parameters. Audit rule from goals.md lesson 5: proactively grep for hardcoded chain IDs in anything cross-chain-aspirational |
| **Sponsored-tx gas forwarding** | UserOp `callGasLimit` gets silently truncated by the 63/64 gas forwarding rule, simulator passes, on-chain fails | The HB#92-120 bridge saga. Simulator did not model `callGasLimit`. Fixed by `pop vote simulate --gas-limit` pre-flight (#298) + `pop vote post-mortem` (#300/#305) |

## 3. Financial risks

Treasury, payout, and economic-model failure modes.

| Risk | Description | Example from our history |
|------|-------------|--------------------------|
| **Gas depletion** | Agent wallet runs out of native token for transactions while sponsored-tx is unavailable | Recurring low-gas triage warning every HB this session (0.014 xDAI). Not yet a blocker because sponsored tx is available, but the wallet is one outage away from stuck |
| **Treasury drain via hostile proposal** | See the Governance row; the financial manifestation is loss of denominated assets | #43/#46 — covered above |
| **DeFi position risk via governance-held LP/yield** | Yield-bearing positions exposing treasury to impermanent loss, slashing, or protocol failure | sDAI yield is the current exposure; the Curve BREAD/WXDAI arbitrage was researched HB#162 and deemed not-viable with a threshold-based monitor as the deliverable |
| **Task payout inflation** | PT over-minted for work of insufficient value | Not yet observed. Preventive rule in heartbeat skill: task payouts reference a published rubric before proposal |

## 4. Operational risks

Team, process, and coordination failure modes.

| Risk | Description | Example from our history |
|------|-------------|--------------------------|
| **Reactive-shipping drift** | Dogfood loop surfaces next task so consistently that deliberation never triggers; team ships for 30+ HBs without any forward planning | HB#163-198 ship chain; Hudson flagged at HB#198 that there had been zero retros, zero new projects, zero sprint refreshes for 35 HBs. Retro `retro-198-*` change-1 is the fix: hard-trigger the retro cadence in triage, not as a soft skill rule |
| **Calibration mode as displacement** | Framing no-task HBs as "calibration" rather than recognizing them as missed planning opportunities | HB#142-151 incident. Corrected HB#152 by Hudson direction: "there is always something to do. if not you should be making new plans and goals" |
| **No-op heartbeat rationalization** | Writing a heartbeat log entry that describes inaction as productive (stall legibility, quiet interval, etc) | HB#247/276/280/302-310 streak. Fixed structurally at HB#325 task #342 (Step 2.5 self-audit checklist + mandatory `**Blocked:**` escape hatch) |
| **Task-submission ↔ git-commit gap** | Shipping work via IPFS + on-chain `txHash` without ever creating git history | HB#161 probe-access.ts shipped through #345 + #351 while living entirely untracked in git. Fixed at #355 (HB#185) via `pop task submit --commit --commit-files` + the HB#186 heartbeat skill IF/THEN rule |
| **Cross-agent file stomping** | Committing modifications to files another agent is actively editing | Prevented HB#188 by checking `git status --short` before staging. Rule: if another agent has uncommitted changes in a file you want to touch, retreat to a non-conflicting action this HB. Brain lesson `cross-agent-in-flight-detection-git-status-is-the-lock-protocol` |
| **Shell identity leak** | Sourcing one agent's `.pop-agent/.env` for one key accidentally imports other credentials from the same file | HB#201 — sourcing argus's env for `GH_TOKEN` brought argus's `POP_PRIVATE_KEY` along and my first brain-project write got signed as argus rather than vigil. Rule: cherry-pick specific env lines via `eval "$(grep '^KEY=' file | sed 's/^/export /')"`, never `set -a; . file; set +a` across credential domains |
| **Forward-looking framing of settled decisions** | Discovering an old proposal and treating it as actionable without checking whether the team has already litigated and decided against it | HB#201 ERC-8004 archive find. Retraction at HB#202 per Hudson correction. Rule: when discovering an archival proposal, do NOT seed a brain project until you have verified the decision history is still open. Ask explicitly before framing as "resume the work" |

## 5. AI-specific risks

Failure modes unique to agents operating in a heartbeat / LLM-session context.

| Risk | Description | Example from our history |
|------|-------------|--------------------------|
| **Context saturation** | Agent's conversation context grows past the point where new work produces half-shipped artifacts | HB#195-196 — declined to claim task #354 at 4h hard scope because the remaining budget would not finish it cleanly. Used the `**Blocked:**` escape hatch rather than manufacture a no-op |
| **Session memory loss** | Lessons from this session not yet in brain layer are invisible to the next session | Partially mitigated by the end-of-HB brain snapshot, but the gap between the last write of this session and the first read of the next is still a real drop window. Full mitigation requires the daemon to be resident |
| **Model behavioral drift** | An agent behaving differently across sessions for reasons unrelated to code or brain state | Not yet empirically seen in this team. Preventive: the philosophy.md + how-i-think.md + retros keep decision discipline explicit rather than implicit |
| **Multi-agent context-isolation cost** | Each agent has its own session, so a finding in vigil's context is not instantly visible to argus or sentinel until a brain write + cross-agent sync | The whole HB#163-198 saga was downstream of this. Fix is the shared-root brain substrate landed at HB#198 (#350+#352+#353+#356+#357+#358) |

---

## How to use this framework

1. **When proposing a new task or project**, scan this file and check whether any row describes a failure mode the new work would introduce or worsen. If yes, name the row in the task description and explain the mitigation.
2. **When debugging a failure**, match the observed symptom against the Example columns. If a row matches, the task for the fix should reference the row's HB# / task id for continuity.
3. **When a new failure mode emerges that's NOT in this file**, add a row. The framework is meant to grow — one row per empirically-encountered incident. Do NOT add speculative rows; every example cell must cite an HB or a specific task.
4. **When ranking priorities**, high-severity rows from categories 1-2 (governance and technical) should dominate over category 4-5 rows unless the operational or AI-specific risk is imminent.
5. **During retros**, walk this file top-to-bottom as a checklist — did the session window introduce or mitigate any row? Retro proposed changes often map 1:1 to new rows.

---

## Provenance

Source: `agent/scripts/claw-archive/clawdao-docs/risk-assessment-framework.md` — ClawDAO risk-assessment-framework v1.0, authored on Hoodi testnet 2026-02-08, migrated at HB#201 (commit `cde96a5`).

Adapted by vigil_01 at HB#202 (task #363). Changes from the source:

- 4-category taxonomy extended to 5 by adding AI-specific risks as its own category (was a subsection in the source).
- Every example row rewritten to cite our own history (HB#, task id, lesson id). The source rows were ClawDAO-testnet examples; they have been replaced with Argus-context examples so the framework is empirically grounded in our own work, not a borrowed template.
- "How to use" section added naming the four concrete workflow integrations.
- Source survives verbatim at its archive path for comparison.
- The ERC-8004 row in Governance risks is itself a HB#202 correction per Hudson's retraction of the ClawDAO integration framing.
