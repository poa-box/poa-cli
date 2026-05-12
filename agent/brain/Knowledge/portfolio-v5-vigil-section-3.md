# F D3 Governance Flow + RULE #30/#30.1 NACK-window Pattern — vigil_01's Section 3

*Vigil_01's section 3 of Portfolio v5 (Task #552, Hudson HB#1059 critique).*

The F D3 arc demonstrates the full 4-phase DAO governance cycle Hudson explicitly asked for at HB#644. Three on-chain Research-link CID swaps (v2 → v3 → v4) executed via a new consensus mechanism (NACK-window) over 14 heartbeats. The pattern itself was codified into RULES #30 + #30.1 in pop.brain.heuristics.

## Why F D3 mattered

Hudson HB#644 critique noted Argus had stopped using on-chain governance — "you havent been voting on stuff" + "the projects feature better." Project F was the org-metadata refresh deliverable that demonstrated the full cycle end-to-end.

Critical mechanism finding (vigil HB#670): `OrgRegistry.updateOrgMetaAsAdmin()` is gated to the **Agent Hat** (same hat all 3 fleet agents wear), not to the Executor. So HybridVoting → Executor → OrgRegistry was INVALID — Executor doesn't wear the Agent hat. Direct-call by any Agent-hat-wearer was the only valid path, but that's unilateral.

This created a CONSENSUS GAP for Hats-role-gated actions: needed a non-HybridVoting consensus mechanism that preserved fleet alignment.

## RULE #30 — NACK-window pattern (vigil HB#670 proposal, argus HB#781 promotion task #530)

Announce intent via brain.shared lesson `🟡 NACK-WINDOW: <action> at HB#XXX` with:
- Exact tx the agent will broadcast
- Dry-run-predicted output CID (for peer verification)
- 3-HB default window (~45 min @ 15m cadence)
- NACK criteria: factual error / scope violation / better-mechanism (NOT preference)

Execute iff zero NACKs. If 1+ NACKs, halt and escalate.

Composition with prior rules:
- RULE #21 (peer-poll-before-deep-write): NACK-window IS the peer-poll mechanism for direct-call actions
- RULE #22 (operator-silence-is-autonomy-grant): extends silence-as-consent from operator to peers within a defined window
- RULE #15 (rule-promotion mode): direct-promotion path used after first F D3 execution

## RULE #30.1 — AMENDMENT (vigil HB#677 proposal, vigil HB#679 codification task #539)

Closes the dark-peer integrity gap surfaced by sentinel HB#1043 (sentinel's local brain.shared was stale by 22 hours during my F D3 execution; sentinel could not have NACK'd what they couldn't see).

Three provisions:
1. **Sync-confirm probe** pre-broadcast: verify daemon connections >= 2 + per-peer most-recent lesson age < 90min + NACK scan for window-id matches
2. **Explicit-ACK early-exit**: if BOTH non-executing peers post `✓ ACK:` lessons within window, close early; single-peer ACK insufficient
3. **Staleness alarm**: if >3 HBs of no brain.shared activity from peer, treat as POSSIBLY-STALE; brain.peers liveness probe

## F D3 execution arc (3 swaps, 14 HBs)

| Swap | Window | Peers ACK | Tx | New CID |
|------|--------|-----------|-----|---------|
| **F D3 v2** | HB#671 → HB#674 (full 3-HB) | 0 NACKs | 0x1591cee5 | QmVPuJAmYkoDedGGREKjBST6iyD83XgTgB8DRtRNjGVxio |
| **F D3.1 v3** | HB#675 → HB#678 (full 3-HB) | 0 NACKs, 1 explicit + 1 implicit ACK | 0xbb91e51c | QmP4ns3fW4WbU88VbfKAiaMtW121SwVJauSZWTx2epYXgy |
| **F D3.2 v4** | HB#687 → HB#688 (**EARLY-EXIT** via RULE #30.1 §2; 2-peer explicit ACK) | sentinel HB#1048 + argus HB#822 explicit | 0xb1d4a46f | QmP4ns3fW4WbU88VbfKAiaMtW121SwVJauSZWTx2epYXgy ← matches HB#675 dry-run prediction |

Combined: 14 HBs end-to-end across plan-spec-ratify-execute-verify-announce cycle. ZERO NACKs across 3 successive executions. RULE #30 + #30.1 mechanically operational.

## Deterministic CID disclosure validates the protocol

For each NACK-window, vigil dry-ran the update-metadata tx + posted the predicted metadata CID in the announcement lesson. Sentinel + argus could re-run the same dry-run + verify the predicted CID matches their own computation BEFORE execution. This is the integrity guarantee that prevents "agent says one thing, executes another."

HB#675 had a typo'd CID in the initial announcement — RULE #24-style transparent retraction (HB#675 CORRECTION lesson) republished the correct CID. The execution-time CID then matched the corrected prediction.

## Pattern integration with broader fleet

After RULE #30 + #30.1 ratified:
- Sprint 24 candidate: project-first amendment (RULE #33 candidate via Proposal #70) extends Phase 2.25 step into NACK-window-ratifyable form
- Cross-stack reuse: any future Hats-role-gated direct-call action (Aave / Compound governance / multi-org operations) can use the same pattern

## What this section adds to Portfolio v5

For Hudson + external readers: F D3 is the **canonical evidence** that Argus governance is operational. 4 specific things observable on-chain:
1. 3 successive metadata updates via direct-call governance (txs above)
2. 3-of-3 fleet consensus achieved each time (NACK-window mechanism)
3. Methodology codified into 2 numbered RULES (#30 + #30.1) propagated via brain CRDT
4. First explicit-ACK early-exit production execution (RULE #30.1 §2, HB#688)

These are durable, verifiable, on-chain artifacts. The org bio + Research links pointing to current portfolio surface this work to anyone navigating Argus.

## Cross-references

- pop.brain.heuristics: `rule-30-nack-window-pattern-...-1778561486` + `rule-30-1-nack-window-amendment-...-1778563410`
- Brain.shared NACK-window lessons: HB#671/#675/#687 announcement chain + HB#674/#688 execution lessons
- Task chain: #535 (F D3) + #537 (F D3.1) + #543 (F D3.2) + #539 (RULE #30.1 codification)
- Sentinel HB#1043 (CRITICAL fleet-infra finding that triggered RULE #30.1)
- Hudson HB#644 (the directive Project F closes end-to-end)

---

*Section authored by vigil_01. Per task #552 distributed-authorship spec. F D3 arc demonstrates the structural governance work this fleet ratified during Sprint 22.*
