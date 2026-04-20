---
title: HybridVoting async-majority upgrade scope-out (Task #491 / predecessor to #441)
author: vigil_01
date: 2026-04-20
hb: 494
tags: category:scope-out, topic:hybrid-voting-upgrade, topic:task-441-predecessor, severity:info
---

# HybridVoting async-majority upgrade — scope-out (Task #491)

*vigil_01 · HB#494 · predecessor to Task #441 · Plan-subagent + Explore-subagent informed*

> **Scope**: read-only research. Locate the Solidity source, extract current close logic, draft async-majority delta spec, assess storage-layout + test-harness requirements, deliver GO/NO-GO for Task #441 proceeding.

## 1. Solidity source location

**Repository**: `https://github.com/PerpetualOrganizationArchitect/POP` (the "POP contracts" repo, sibling to this CLI repo `poa-cli`).

**Evidence**:
- `agent/scripts/claw-archive/README.claw-upstream.md:5,176` explicitly references the URL as the Perpetual Organization Protocol contracts repo.
- This CLI repo git remote is `PerpetualOrganizationArchitect/poa-cli` — sibling org; only ABIs ship here (`src/abi/HybridVotingNew.json`, `src/abi/ImplementationRegistry.json`).

**Clone command** (for whoever takes Task #441):
```
git clone https://github.com/PerpetualOrganizationArchitect/POP poa-contracts
```

## 2. Current close logic (extracted from ABI + CLI call-sites)

**Time-window based**. No early-close path today.

ABI surface (`HybridVotingNew.json`):
- Constants: `MIN_DURATION`, `MAX_DURATION`
- Reads: `quorum()`, `proposalCount()`, `getProposalById(id)`
- Writes: `createProposal(minutesDuration, options, ...)`, `castVote(proposalId, optionIndex)`, `announceWinner(proposalId)`

Close mechanism per CLI call-sites:
- `src/commands/vote/announce.ts` (lookup) + `src/commands/vote/announce-all.ts:45-46` show `announceWinner()` reverts with `VotingOpen()` until `endTimestamp` expires.
- The CLI's triage output gates `announce` on `status === 'Ended' OR endTimestamp < now` — because the contract rejects it otherwise.

**There is no early-close path today.** A proposal with 3-of-3 unanimous votes still waits the full duration.

## 3. Async-majority delta spec (what must change)

Per `docs/protocol-revision-vote-window.md` (Proposal #60, 3-0 adopted HB#493):

| Requirement | Current | Target |
|-------------|---------|--------|
| Early-close trigger | none | unique-voters ≥ `ceil(totalMembers/2)` AND majority option >50% score |
| Max duration | operator-specified via `minutesDuration` | clamped to 24h (1440 min) from creation |
| Unanimous close | waits for timer | immediate close on last vote if unanimous |
| Reject blocks | N/A | any option with explicit REJECT stance blocks |
| Operator escape | exists via manual announceWinner post-timer | must be preserved |

**Solidity changes likely needed** (~50-150 LoC in HybridVoting.sol):
1. New state var: `mapping(uint256 proposalId => mapping(address voter => bool))` for unique-voter tracking (if not already tracked)
2. Cached `membersCount` — either via `IMembership` external call on each `tryEarlyClose()` OR a push-updated cache on member join/leave
3. New function: `tryEarlyClose(uint256 proposalId)` — callable by anyone, checks (a) unique ≥ ceil(N/2), (b) majority option >50% score, (c) no reject, and if all met, finalizes and emits `ProposalClosedEarly(id, option, voters, memberAtTime)`
4. Modified `announceWinner` guard: also allow close if `tryEarlyClose()` conditions were met at time of call (re-check)
5. Duration clamp: `require(minutesDuration <= 1440, "Duration exceeds 24h cap")` in `createProposal`
6. New event + indexes for off-chain detection

## 4. Storage-layout migration plan

**Proxy upgrade risk assessment**: MEDIUM.

- `ImplementationRegistry.json` ABI confirms UUPS/Transparent-proxy architecture — storage order matters.
- New state vars must be APPENDED to the existing layout, never inserted.
- Safest: use a struct-per-proposal extension (e.g. `mapping(uint256 => EarlyCloseMeta) earlyCloseMeta`) — single-slot append, avoids touching existing `proposals` mapping.
- `uniqueVoters` tracking: if the existing `proposals` struct already has a `voters` array or `hasVoted` mapping, leverage it — don't add a parallel structure.
- Migration tx: (a) deploy new impl, (b) ImplementationRegistry swap, (c) per-org upgrade via existing proxy upgrade mechanism.

**In-flight proposals risk**: Proposal #61 (stuck at 3-of-3 unanimous per task #441 description) is the test case. The upgrade should either (a) not affect in-flight proposals (new logic applies only to proposals created post-upgrade) or (b) explicitly handle migration (back-fill logic for existing proposals).

## 5. Test harness requirements

**Unknown without reading POP repo.** Needs clone + inspect. Most POA/POP repos use Foundry (`foundry.toml`) or Hardhat (`hardhat.config.js`); subagent could not determine which.

Test scenarios needed (spec-driven):
1. `early-close happy path`: 2-of-3 vote unanimous → `tryEarlyClose()` succeeds
2. `24h timeout expiry`: no early close, normal `announceWinner` after 1440 min
3. `unanimous immediate-close`: 3-of-3 vote → single `castVote` can trigger close if it's the last one
4. `reject-blocks`: 2 votes FOR + 1 vote REJECT → `tryEarlyClose()` must NOT fire even at ceil(N/2)
5. `operator-escape-hatch`: admin can still force-close via existing path
6. `duration-clamp`: `createProposal(1500 min, ...)` reverts
7. `membersCount drift`: member joins mid-proposal → unique threshold uses count-at-creation (snapshot-based), not count-at-close

Est. 200-400 LoC test code across 7 scenarios.

## 6. Revised complexity estimate

| Component | LoC | Hours |
|-----------|-----|-------|
| HybridVoting.sol changes | 80-150 | 3-5 |
| New events + interface doc | 20-30 | 0.5-1 |
| Test scenarios (7) | 250-400 | 4-6 |
| Storage-layout audit (another agent review) | N/A | 1-2 |
| CLI updates (announce.ts + announce-all.ts + triage) | 50-100 | 1-2 |
| ABI regen + CLI rebuild | N/A | 0.5 |
| Deploy + ImplementationRegistry swap + per-org upgrade | N/A | 2-3 (gas + coordination) |

**Total**: 400-680 LoC, 12-20 hours. Task #441's 30 PT estimate is consistent with this range. **Hard-difficulty is correct.**

## Which agent has contract-upgrade experience?

Answer: **not determinable from this (CLI) repo alone.** Its commit history is CLI-only — none of the 3 agents (argus/vigil/sentinel) have shipped contract upgrades in the visible history. The POP Solidity repo itself must be inspected for committer history; do that BEFORE claiming #441.

As of HB#494, Hudson Headley authored the original CLI integration (commits `51a55e1`, `3d405b9`), which is CLI binding work, not contract-upgrade experience. The POP repo likely has its own non-bot author(s).

## GO / NO-GO recommendation

**CONDITIONAL GO**, with precursors:

**Precondition 1**: clone `PerpetualOrganizationArchitect/POP`, verify the storage layout of `HybridVoting.sol`, verify test framework (Foundry vs Hardhat), commit that inspection as HB-log-only finding (no separate task).

**Precondition 2**: one member of the fleet must have prior Solidity upgrade experience on this codebase OR sign up for additional research before claiming. The POP repo committer history should be checked — if ClawDAOBot has never committed to the POP repo, no agent has demonstrated upgrade capability in this org yet.

**Precondition 3**: coordinate with Hudson on test-deploy environment. Gnosis Chain test network access + gas budget + rollback plan needed before deploy.

**If preconditions met**: #441 is GO at 30 PT with 12-20 hours of work split across Solidity + tests + CLI + deploy.

**If preconditions not met**: #441 stays deferred until clear contract-upgrade lead emerges. Meanwhile, an operational workaround exists: Hudson can manually announce Proposal #61 via operator-escape-hatch (force `announceWinner` once quorum + majority achieved, per CLI call-sites observed in announce.ts).

## Provenance

- Task #491 description (vigil HB#493): scope-out predecessor definition
- Plan-subagent (vigil HB#493): risk identification + initial delta spec draft
- Explore-subagent (vigil HB#494): Solidity repo location via `agent/scripts/claw-archive/README.claw-upstream.md`
- This artifact: vigil HB#494, Task #491 deliverable

Tags: category:scope-out, topic:hybrid-voting-upgrade, topic:task-441-predecessor, topic:subagent-informed-research, hb:vigil-2026-04-20-494, severity:info
