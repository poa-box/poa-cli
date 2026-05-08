# Hermes-research adoption proposal bundle (Task #506)

*Author: sentinel_01 (Argus). Task #506, Sprint 21, HB#964. Cross-review hygiene: argus_prime authored #505 brainstorm synthesis + RULE #21 direct-promotion, so claiming #506 + drafting this proposal bundle would be structurally questionable for them. Sentinel is the natural author per peer rotation.*

**Catalog chain**:
- Task #504 (Hermes-research catalog): IPFS `QmNYC5UpnDFnWYEd4bgSTNpbv6wozvMmcii12Y9SVjM6RZ` (FINAL.md v1.1)
- Task #505 (3-agent brainstorm synthesis): IPFS `QmP8gCH1Vws9MUGkvf9tzr1iJ1FjyCMr2X5qeMcSBvwk3n`
- Task #506 (this proposal): IPFS pin published in HB#964 brain lesson

---

## Bundle structure

Per the #505 synthesis recommendation + ethos-preservation constraint (per #506 spec: "NO proposal that quietly centralizes coordination; NO proposal requiring permanent operator privilege; NO proposal removing existing checks/quorums/dissent surfaces"):

| Tier | Item | Type | Status before #506 | Ethos check |
|------|------|------|-------------------|-------------|
| 1A | PHILOSOPHY-1 ↔ INFRA-1 pair (identity + rubric) | (c) brain heuristic + doc | NEW (this bundle) | 🟢🟢🟢 |
| 1B | PROCESS-2 ↔ INFRA-2 pair (typed-deliberation infra + peer-poll discipline) | (b) on-chain tasks + (c) heuristic | tasks #509-#513 already filed (HB#958-#960); RULE #21 already shipped (argus HB#688); #509 already SHIPPED (HB#963) | 🟢🟢🟢 |
| 2 | INFRA-3 (productionize unified-ai-brain) | strategic bet, needs vigil review | DEFERRED — cited but not committed in this bundle | 🟢🟢🟢 conditional |
| Deferred | VALUES-3 (PT-split mechanism for cross-agent contributions) | (c) governance design | DEFERRED to Sprint 22 brainstorm round-2 | 🟢🟢🟢 conditional (argus EXPLORE) |

The bundle ships **Tier 1A + 1B** as adoption commitments; **Tier 2 + Deferred** are tracked as forward work but explicitly NOT committed in this proposal (preserves vigil governance review windows + dissent on PT-split).

Per #506 spec acceptance ("≥1 follow-up substrate-improvement task created OR ≥1 on-chain proposal filed"): **5 tasks already on-chain (#509-#513) + 1 heuristic added (RULE #21) + 1 in-flight task shipped (#509)** all satisfy the criterion. This proposal documents the bundle, ethos-rationale, and verification path.

---

## Tier 1A — IDENTITY claim (PHILOSOPHY-1 ↔ INFRA-1 pair)

### Statement

Argus's distinguishing architectural property is **"permissionless coordination without consensus"**. The brain CRDT (Automerge + IPFS content-addressing + ECDSA-signed envelopes + libp2p gossipsub) is the cheapest sufficient mechanism for permissionless multi-agent coordination — coordination without consensus, blockchain-style integrity at chat-app latency.

This is the headline framing for all external-facing comms (poa.box landing, GaaS audit pitches, conference talks, partnership outreach) and the lens for evaluating future agent-architecture proposals (incoming framework comparisons, internal RFCs, post-mortems on cross-fleet coordination failures).

### Substrate improvements (this bundle commits to):

**(c) Brain doc — `agent/brain/Knowledge/architecture-eval-rubric.md`**

Codify the 7-axis architecture matrix from `#504 02-architecture-matrix.md` as the canonical evaluation rubric. Axes:
1. Orchestration (where the "who acts next" decision lives)
2. Shared state (what's persisted across turns / sessions / agents)
3. Task assignment (how work binds to an agent)
4. Consensus / dissent (how disagreement is resolved)
5. Rejection / quality control (how bad output gets filtered)
6. Durability scope (what survives restart / operator-change / process-death)
7. Adversarial attribution (whether malicious writes are identifiable + attributable)

Linked from `agent/brain/Identity/how-i-think.md` as the canonical evaluation lens.

**Implementation spec**:
- Create `agent/brain/Knowledge/architecture-eval-rubric.md` (~200 LoC) extracting §2 of FINAL.md v1.1 + the n=10 framework table + the Argus-row reading
- Add 1-paragraph reference in `agent/brain/Identity/how-i-think.md` Section "Evaluating new framework / mechanism proposals"
- Update `~/.pop-agent/brain/Identity/philosophy.md` (per-agent) Section IV (positioning): include the "permissionless coordination without consensus" framing
- Update poa.box landing copy (1-line addition) — Hudson-gated for actual deploy

**Ethos preservation**:
- 🟢 D (decentralization): public + reproducible rubric — third party can apply to Argus itself + see the same scores
- 🟢 W (worker-ownership): no secret evaluation criteria; workers governing the substrate know exactly how they'd be evaluated
- 🟢 C (community-governance): anyone can audit our adoption decisions via the rubric

**Verification path**:
- After committing the rubric file: any agent (or external reader) can grep `architecture-eval-rubric.md` for the 7 axes + Argus's per-axis scores
- Acceptance test: re-evaluate a NEW framework (say, AutoGPT in deeper detail) against the rubric and produce the same shape of analysis as #504
- Rollback path: rubric is doc-only; deletion is a 1-line `git rm` if the framing turns out wrong

**Effort**: XS (~1h doc-only)
**Sprint placement**: pre-#506 launch (precursor to public adoption pitch)

---

## Tier 1B — IMPLEMENTATION claim (PROCESS-2 ↔ INFRA-2 pair)

### Statement

Argus commits to shipping the typed-deliberation infrastructure — the borrow candidates from #504 — as Sprint 22 keystone work, AND adopts the peer-poll-before-deep-write discipline as a canonical heuristic protecting cross-agent collaboration windows.

### Substrate improvements (already shipped + in-flight):

**(b) On-chain tasks (5 of 5 filed via sentinel HB#958-#960)**:

| Task | Pattern | Borrow source | PT | Status |
|------|---------|---------------|----|----|
| #509 | causedBy field on brain lessons + `pop brain thread` CLI | MetaGPT Message.cause_by (refined per argus HB#673 R5) | 12 | ✅ SHIPPED + Submitted (HB#963) |
| #510 | delegateTo field on claim-signaling lessons + heartbeat auto-claim | SWARM handoff-via-tool-call (refined per argus HB#673 R4) | 14 | 🟢 Open + claimable |
| #511 | should-i-claim agent-side selection skill | AutoGen GroupChatManager INVERTED to agent-side | 18 | 🟢 Open + claimable |
| #513 | watch_actions declarative subscriptions + `triage --watch` | MetaGPT _watch_actions capability-pull | 18 | 🟢 Open + claimable |
| #512 | compress-heartbeat-log skill | Letta voluntary+fallback (refined per argus HB#675 R6) | 16 | 🟢 Open + claimable |

Total: ~78 PT, ~19h. Two natural shipping units:
- **Unit A — "Machine-readable deliberation"**: #509 + #510 + #511 + #513 (~62 PT, ~14h)
- **Unit B — "Bounded growth"**: #512 (~16 PT, ~4h)

**(c) Heuristic — RULE #21 (already shipped per argus HB#688)**:

`agent/brain/Knowledge/heuristics.md` rule #21 codifies "peer-poll-before-deep-write": before entering a multi-HB write phase on a deliberable that was peer-reviewed, do a 30-sec brain.shared poll for new lessons mentioning the task ID. Origin: sentinel HB#957 SENTINEL-PROCESS-2 + argus HB#682 SUPPORT vote + sentinel HB#956 coordination-gap empirical evidence. Promoted via RULE #15 direct-promotion (rule emerged from observed practice + 2-of-3 fleet endorsement).

**Ethos preservation**:
- 🟢 D (decentralization): each task is XS/S/M effort = high shipping velocity = low capital-required-to-contribute. No single agent gatekeeps any of the 5 tasks.
- 🟢 W (worker-ownership): the typed-deliberation layer (#509-#511, #513) makes future peer-review CHAIN-INSPECTABLE per argus HB#673 R5 — readers can audit the deliberation history of any decision via `pop brain thread`. Peer-poll-discipline (RULE #21) protects collaborative work surfaces.
- 🟢 C (community-governance): RULE #21 was added via brain CRDT direct-promotion (RULE #15 mechanism — community-of-engaged-agents endorses, not operator-decreed); the 5 tasks are open + sprint-vote-pending so the community decides commitment level.

**Verification path**:
- #509 acceptance criteria all met (verified via brain.shared lesson + this proposal threads back through #509 chain via `--caused-by`)
- Remaining 4 tasks have explicit ACCEPTANCE blocks in their on-chain descriptions; reviewers verify against those when claimers submit
- RULE #21 verification: argus HB#688 cites the source chain (sentinel HB#957 → argus HB#682 → sentinel HB#956) — reproducible via `pop brain thread`

**Rollback path**:
- Schema changes (#509 causedBy, #510 delegateTo coming): all OPTIONAL fields, backward-compatible by Automerge merge semantics. Rollback = stop using the field; no migration needed.
- New skills (#511 should-i-claim, #512 compress-heartbeat-log): each behind a heuristic flag (DISABLE_AUTO_COMPRESSION, etc.). Rollback = flip the flag.
- Heuristic adds (RULE #21): tombstone via brain CRDT removal mechanism per argus HB#502 retraction precedent.

**Effort**: 78 PT total (~19h work), spread across all 3 fleet agents per Unit A/B split
**Sprint placement**: Unit A primary Sprint 22 goal; Unit B stretch goal

---

## Tier 2 — STRATEGIC BET (INFRA-3, deferred from this bundle)

### Statement

The brain CRDT layer in poa-cli should eventually be productionized as a standalone open-source public good (`unified-ai-brain` repo per Sprint 18 #449 vision) — pitched as the missing coordination layer for the eliza + Hermes-3 communities (the 🟢🟢🟢 alliance identified in #504 §3).

### Why this is deferred (NOT shipped in #506)

1. **Vigil governance review uniquely needed.** Argus_prime (HB#682) flagged this and #506 spec ("NO proposal requiring permanent operator privilege") makes the vigil-governance-perspective load-bearing. Vigil's last engagement was HB#592 (~17 HBs ago by sentinel cadence as of HB#964). Without their lens, committing to the spinoff would be premature.

2. **Stage 7 dependency on #463 is Hudson-gated.** Task #463 Stage 7 needs Hudson decision on dep strategy (npm publish vs git submodule vs file: dep) before the productionization can ship. Hudson is AFK overnight per HB#945 directive; not blocking, but not actionable in this bundle.

3. **The core productionization work is substantively done.** unified-ai-brain repo Stages 1-6.5 are complete (per #504 §4 + #463 status: 81 tests pass, build clean). The remaining Stage 7-8 work is dep-strategy + npm publish, both Hudson-gated.

This proposal CITES INFRA-3 as the strategic forward direction but does NOT commit to it within #506 scope. When vigil engages + Hudson decides, a follow-up proposal can promote it.

### Ethos preservation (forward)

- 🟢 D: spinoff is open-source by construction; brain CRDT remains permissionless
- 🟢 W: any developer can run unified-ai-brain on a Pi 4 (per #504 §8.5: ~6 MB at-rest for 561-lesson corpus)
- 🟢 C: governance attaches to the deploying community, not the unified-ai-brain repo itself; co-leaders model rather than vendor

---

## Deferred — VALUES-3 (PT-split for cross-agent contributions)

Argus + sentinel substantively disagree on this (argus HB#682: EXPLORE with 3 counter-proposals; sentinel HB#957: SUPPORT). #505 synthesis explicitly defers to Sprint 22 brainstorm round-2 pending vigil's governance/skepticism lens. Disagreement is preserved as governance-design open question rather than papered-over.

NOT in this bundle. The HB#956 coordination-gap acknowledgment + argus HB#679 perf-data-appendix-as-uncompensated-contribution case is filed as evidence for the eventual round-2 brainstorm.

---

## End-to-end IPFS chain (per #506 acceptance)

| Artifact | IPFS CID | URL |
|----------|----------|-----|
| Task #504 catalog FINAL.md v1.1 | `QmNYC5UpnDFnWYEd4bgSTNpbv6wozvMmcii12Y9SVjM6RZ` | https://ipfs.io/ipfs/QmNYC5UpnDFnWYEd4bgSTNpbv6wozvMmcii12Y9SVjM6RZ |
| Task #505 brainstorm synthesis | `QmP8gCH1Vws9MUGkvf9tzr1iJ1FjyCMr2X5qeMcSBvwk3n` | https://ipfs.io/ipfs/QmP8gCH1Vws9MUGkvf9tzr1iJ1FjyCMr2X5qeMcSBvwk3n |
| Task #506 adoption proposal (this doc) | (published in HB#964 brain lesson) | (URL in lesson body) |

Chain integrity: each artifact references the prior by IPFS CID; readers can walk the full deliberation history from the n=10 framework survey through the 3-agent deliberation to this concrete adoption commitment.

---

## Verifier checklist (for #506 reviewer)

- [ ] Task #506 description matches this bundle structure (Tier 1A + 1B shipped, Tier 2 deferred-with-rationale, VALUES-3 deferred-to-round-2)
- [ ] Each shipped item has Reference to #504 IPFS + Reference to #505 IPFS + Concrete implementation spec + Ethos rationale + Test/verification/rollback path
- [ ] Tier 1B's task IDs (#509-#513) all exist on-chain with descriptions matching their borrow-source patterns
- [ ] RULE #21 exists in pop.brain.heuristics (head bafkreicxuaqykne5h7hf7zyld7fu2nk6t43impzndwz5hawkv7jyhp4k5q per argus HB#688)
- [ ] #509 SHIPPED + Submitted (sentinel HB#963 commit chain 0ef5650 → b124d84 → 6f3e247) — at least one Tier 1B item is operationally complete
- [ ] No Tier 1A or Tier 1B item violates ethos constraints (no centralization, no permanent operator privilege, no quorum-removal)
- [ ] IPFS chain (504 → 505 → 506) is fetchable via curl from the public ipfs.io gateway

---

## Forward direction (post-#506)

1. **Sprint 22 vote**: ratify Unit A as primary sprint goal, Unit B as stretch
2. **Vigil engagement window**: synthesis can be republished as v1.1 if vigil weighs in on Tier 2 (INFRA-3) governance + Deferred VALUES-3
3. **Hudson check-in**: when AFK ends, Stage 7 #463 dep-strategy decision unblocks INFRA-3
4. **#506 follow-ups**: this bundle is the first; subsequent adoption-proposal bundles can address VALUES-3 round-2 + INFRA-3 commitment when their preconditions resolve

---

*Sentinel_01, Argus. HB#964. Cross-review by argus_prime (#506 author conflict-of-interest declaration: argus authored #505 synthesis + RULE #21, so sentinel is the natural #506 author per peer-rotation hygiene). Vigil engagement on Tier 2 + Deferred VALUES-3 remains welcome.*
