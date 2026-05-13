# pop-cli Tool Catalog with Usage Context

*Sentinel HB#1080-#1081 fleet-wide audit, per Hudson directive 2026-05-13: "investigate all the poa-cli features and make sure you and the other agents are using them all properly and have proper context to use them and know when to use them."*

## Top-line finding

**164 total commands across 14 active domains. 29.9% (49 commands) UNUSED across sentinel heartbeat-log + all-fleet brain.shared.**

Tool-overhang rate consistent with prior dogfood scans (argus HB#692 99.2%, sentinel HB#1055 97.9% by narrative-mention metric; this scan corrects to 29.9% by **exact `pop <domain> <cmd>` invocation pattern match across both author logs**).

The earlier high rates were under-counting actual usage because they regex'd narrative text. This scan matches actual invocation patterns and finds the real gap is ~30%, not ~99%.

## High-value FORGOTTEN commands — "when to use" trigger contexts

These are the commands the fleet built but reaches for too rarely. Each has a concrete trigger condition.

### `pop config validate` — 0 uses across fleet (CRITICAL gap)

**Trigger**: BEFORE any write action (vote cast, task submit, brain append-lesson).

**Why we built it**: tests RPC + subgraph connectivity. Catches outages BEFORE the write fails on-chain.

**Why we forgot it**: CLAUDE.md explicitly documents it as the health check — "Use `pop config validate --json` as health check before acting". We skip it and proceed directly. Every silent RPC degradation costs an HB cycle to diagnose retroactively.

**When to reach for it**: at the start of every HB cycle, immediately after `agent triage --json`. If exit != 0 → defer write actions until config-issue resolved.

### `pop brain repair` — 3 uses across 80+ HBs (UNDERUSED)

**Trigger**: when `agent fleet-health --json` shows stale peers OR `brain daemon status` shows connections < expected.

**Why we built it**: rescue path for divergent CRDT state. HB#1043 brain-sync 22hr silent outage was the founding incident.

**Why we forgot it**: stop+start workaround used instead. But stop+start is heavyweight (~3s libp2p re-init) and doesn't fix actual disjoint-history rejection on docs.

**When to reach for it**: when fleet-health shows stale-peer state >12 hours AND daemon restart doesn't recover within 30 sec. NOT the first response — second response after daemon stop+start fails.

### `pop brain heads` — 4 uses (UNDERUSED)

**Trigger**: when verifying CRDT propagation state across peers.

**Why we built it**: shows the local doc-head CIDs per Automerge doc. Diagnostic primitive.

**Why we forgot it**: daemon status shows connection count, but heads shows actual frontier-CID convergence with peers. We use status as a proxy when heads is more direct.

**When to reach for it**: when debugging "is my lesson seen by peers?" — heads diff between my heads + peer's heads (via gossip log) tells you if the propagation actually happened, not just whether the libp2p connection is up.

### `pop org boundary-score` — 3 uses (Argus's own framework, low usage)

**Trigger**: when auditing decentralization of an org per argus v0.5 capture-cluster spec — task #489 closed.

**Why we built it**: composes audit-vetoken + audit-snapshot + allocation-distance into a single capture-cluster boundary signal.

**Why we forgot it**: agents reach for the underlying primitives (audit-vetoken, audit-snapshot, allocation-distance) directly instead of the composite. argus shipped the composite for fast org-classification but the manual composition habit persists.

**When to reach for it**: when classifying a NEW org for capture-cluster pattern fit. Saves 3-5 separate command invocations.

### `pop vote analyze` — 4 uses (UNDERUSED)

**Trigger**: BEFORE casting a vote with custom weights OR when checking vote robustness.

**Why we built it**: shows counterfactual analysis (DD-only / token-only / no-quadratic / single-pick rankings) + robustness rating. Catches edge cases where vote winner depends on PT class config.

**Why we forgot it**: agents just `vote cast` directly. We use it AFTER casting (to confirm result) when we should use it BEFORE (to verify intent).

**When to reach for it**: ALWAYS before `vote cast` on high-stakes proposals. ALWAYS when proposal has >2 options. The 0-indexed/1-indexed trap (HB#1033) wouldn't have happened with a vote analyze --dry-run first.

### `pop task stats` — 0 uses (DIRECT HUDSON-HB#684 GAP)

**Trigger**: when investigating per-member contribution distribution. Especially for review-load rebalancing per Hudson HB#684 critique.

**Why we built it**: per-member contribution analytics in one command. Per-agent tasks-shipped, PT, review-load.

**Why we forgot it**: manual heartbeat-log scans + vigil HB#722's hand-built table do this analysis from scratch each time. `task stats` would auto-generate it.

**When to reach for it**: at sprint boundaries (post-mortem on per-agent load), when filing review-load-rebalance tasks (would have helped vigil HB#722), when responding to Hudson critiques about workload distribution.

### `pop agent daily-digest` — 4 uses (UNDERUSED)

**Trigger**: when summarizing recent agent activity (own OR peer's) for handoff or reflection.

**Why we built it**: condensed activity summary across triage + brain + tasks.

**Why we forgot it**: heartbeat-log narrative serves the same role for self. But for cross-agent visibility ("what has argus been working on this sprint?"), daily-digest is faster than reading their full lessons.

**When to reach for it**: at sprint-boundary reviews, when preparing portfolio updates, when Hudson asks "what has the fleet done lately?".

### `pop agent checklist` — 4 uses (UNDERUSED)

**Trigger**: at start of substantive workstream (sprint kickoff, new project execution).

**Why we built it**: structured pre-flight check for agent operational readiness.

**Why we forgot it**: heartbeat skill Steps 1-4 informally substitute. But checklist explicitly enumerates substrate dependencies.

**When to reach for it**: at sprint boundaries, after extended AFK windows (24h+), before claiming complex tasks.

### `pop org publications` — 2 uses (FORGOTTEN PIN DISCOVERY)

**Trigger**: BEFORE pinning new content. Saves duplicate-pin work.

**Why we built it**: lists all org-published documents with IPFS pins.

**Why we forgot it**: agents don't check what's already pinned before pinning v3 or v4 of the same doc.

**When to reach for it**: before any `pop org publish` invocation. Verify there's not already a current pin of the same content under a different name.

### `pop org share` — 3 uses (UNDERUSED)

**Trigger**: when directing peer to a specific publication.

**Why we built it**: generates standardized share-links from publication IDs.

**Why we forgot it**: agents send raw IPFS gateway URLs. Direct links work but `share` provides org-context.

**When to reach for it**: in cross-agent ACKs that reference pinned docs, in PR descriptions, in Hudson-facing communication.

### `pop org gaas-status` — 4 uses (BUSINESS-MODEL VISIBILITY GAP)

**Trigger**: when checking GaaS pipeline state (audit requests, deliveries, revenue).

**Why we built it**: GaaS is the Argus business model per portfolio v4/v5.

**Why we forgot it**: no active GaaS clients yet, so status is empty most of the time. But checking weekly catches state-changes.

**When to reach for it**: weekly at minimum, AND any time Hudson asks about Argus revenue / business activity.

### Entire `retro-*` family (brain) — 0 uses across the board

`brain retro-start`, `retro-show`, `retro-respond`, `retro-list`, `retro-file-tasks`, `retro-mark-change`, `retro-remove` — **7 commands, 0 uses fleet-wide**.

**Trigger**: at sprint boundaries (Sprint X close) OR after substantive incident (HB#1033 vote miscast, HB#1043 brain-sync, HB#1052→#1069 retraction).

**Why we built it**: structured retros = systematic fleet improvement. Sprint cycles end without learning loop.

**Why we forgot it**: substantive incidents get captured as brain lessons (e.g. HB#1043 fleet-health ship was a de-facto retro), but the `retro-start`/`retro-respond` workflow is bypassed.

**When to reach for it**: file `retro-start` at every Sprint close. File `retro-start` after every RULE #24 self-retraction. File `retro-start` after any peer-correction event.

**Specific Sprint 24 candidate**: vigil HB#722 RULE #31 v2 enforcer should auto-file `retro-start` on Sprint close.

### Entire `education` domain — 0 uses

`education create-module`, `education list`, `education complete` — **3 commands, 0 uses**.

**Trigger**: when one agent ships a new methodology that other agents should learn.

**Why we built it**: agent-to-agent skill transfer infrastructure.

**Why we forgot it**: brain.shared lesson + repo commit serves the same role informally. But education modules are STRUCTURED with completion-tracking — useful for verifying that all agents have absorbed a new methodology.

**When to reach for it**: when a methodology lesson NEEDS verification of fleet-wide adoption (e.g. RULE #30.1 explicit-ACK pattern — could have shipped as education-module with all 3 agents marked complete).

**Specific candidate**: AGGREGATOR-ANONYMITY meta-pattern methodology (HB#850→#1078) could be an education module. Validates that all agents apply the (a)+(b)+(c)+(c') framing consistently in future probes.

### `pop vote propose-config` + `propose-quorum` — 4 uses each (UNDERUSED)

**Trigger**: when changing org governance parameters (quorum, voting class config).

**Why we built it**: structured governance-parameter proposals.

**Why we forgot it**: when we want to change governance we hand-build proposal calldata each time.

**When to reach for it**: any governance-parameter change. Saves the calldata-build step.

### `pop treasury distributions` family — 9 of 17 unused

`treasury claim`, `claim-mine`, `compute-merkle`, `deposit`, `distributions`, `opt-out`, `propose-distribution`, `propose-swap`, `view` — **9 commands unused** (out of 17 in treasury domain).

**Trigger**: when running Merkle airdrops or compensation distributions to fleet members.

**Why we built it**: treasury management primitives.

**Why we forgot it**: fleet hasn't run a Merkle distribution. But `treasury view` (balance check) is unused too — relevant for "do we have funds to do X" checks.

**When to reach for it**: 
- `treasury view`: before any treasury-impacting proposal
- `propose-distribution`: when distributing earned PT
- `propose-swap`: when treasury-rebalancing tokens

### `pop task probe` — 0 uses (FAILURE-DIAGNOSTIC GAP)

**Trigger**: when a task operation (claim/submit/review) fails with a non-obvious revert.

**Why we built it**: structured introspection into task state + permissions.

**Why we forgot it**: agents read task view + manually debug. probe is purpose-built for the failure case.

**When to reach for it**: when `task claim` or `task submit` reverts unexpectedly.

## Commands deliberately not in regular usage (correct)

These are administrative / onboarding commands that should be ZERO use after fleet setup. NOT a problem:

- `agent init`, `agent register`, `agent deploy-to-org`, `agent setup-sponsorship`, `agent onboard` — one-time onboarding (done HB#~1-100 per agent)
- `user register`, `user join` — one-time per agent
- `org deploy`, `org deploy-config` — one-time org setup
- `project create`, `project delete` — replaced by `project propose` for governance discipline
- `brain migrate`, `migrate-to-v2`, `migrate-projects`, `import-snapshot` — one-time schema migrations
- `role apply`, `role applications` — Hat-based role bootstrap only

## Fleet recommendations (Sprint 24+)

1. **Each agent runs `/self-survey-tools`** within next 5 HBs to validate this scan against their own usage data.

2. **Adopt `pop config validate` as Step 0.6 in heartbeat skill** (between daemon-status and triage). Catches RPC + subgraph degradation before write actions land.

3. **Adopt `pop vote analyze --dry-run`** as mandatory pre-flight for ANY `vote cast` on proposals with >1 option. Closes the HB#1033 0-vs-1-indexed trap class.

4. **Adopt `pop task stats`** as the canonical answer to Hudson's "what has the fleet done" + Hudson HB#684 review-load critique. Replaces manual heartbeat-log scans.

5. **Adopt `pop brain retro-start`** at Sprint close. Enforce via RULE #31 v2 (#70).

6. **Adopt `pop org publications`** before `pop org publish` to avoid duplicate-pin work.

7. **Sprint 24+ task candidate**: education-module for AGGREGATOR-ANONYMITY meta-pattern + (a)+(b)+(c)+(c') framing consistency across all future probes. Verifies fleet-wide adoption.

8. **Sprint 24+ ship candidate**: `pop agent tool-rotation-reminder` — emits a 1-line nudge each HB suggesting an underused command relevant to current triage actions. Closes the tool-overhang gap structurally.

## Updates HB#1080→#1091 (real-time additions from fleet sprint)

### Newly-shipped tools (Sprint 24)
- **`agent/scripts/brain-search-semantic.mjs`** (argus #566 HB#863): TF-IDF + cosine semantic search. **Trigger**: when `pop brain search` returns empty AND topic is conceptually familiar. Validated 2 miss cases first-run (HB#1074 Part XI parallel-draft + HB#852/#1065 CLever Safe). Production-validated HB#1087.
- **`pop org probe-proxy --eip7201 --beacon`** v0.3 (vigil #558 HB#732): beacon resolution + EIP-7201 namespace detection. Production-validated HB#735 (veVELO #1 chain walk).
- **`pop org audit-vetoken --nft-scan-transfers`** v0.2 (vigil #557 HB#731): Transfer-event scan for true ve-power per holder. **Trigger**: ERC721Enumerable not supported (Velodrome/Aerodrome/Ramses veNFT).
- **`pop project propose --auto-hats`** default true (vigil #562 HB#730): closes Hudson HB#707 cycle-gap. Every project proposal that needs immediate task-fileability.
- **`pop project propose --duration` default 60-min** (vigil #561 HB#733 = RULE #32): routine fleet-aligned proposals use 60; reserve 1440 for high-stakes.

### Audit findings discovered while dogfooding
- **`pop task probe`** — file exists but NOT registered as yargs subcommand (HB#1083). CLI-registration gap.
- **`pop project list`** — subgraph "Odd number of digits" hex parse error (HB#1083). Upstream subgraph bug.
- **`pop org boundary-score`** — silent-zero without `--substrate/--cohort/--dimension` flags (HB#1081). Documentation gap.
- **`pop org publish`** requires PRE-PINNED CID — ipfs CLI not installed in env; use `task submit` auto-pin instead (HB#1085).

### Discipline adoptions (fleet-wide)
- **Step 0.6 = `pop config validate`** before triage: sentinel HB#1081 + argus HB#858/#859/#866 adopted (vigil pending).
- **Phase-2 task-batch pre-staging** before Phase-3 batch filing: vigil HB#722 + sentinel HB#1078 + argus HB#857 SYMMETRIC across fleet.
- **`pop brain remove-lesson`** dogfooded HB#1085 (4th use of forgotten command — cleaned up duplicate from IPC-timeout retry).
- **`pop task stats`** revealed argus 16 self-reviews (vigil + sentinel = 0) — bootstrap-artifact per argus HB#865 honest investigation, NOT recent discipline drift.
- **`pop org gaas-status`** revealed REVENUE (2 external transfers) — business state visibility gap closed.

### Daemon IPC EPIPE diagnostic (HB#1080→#1083→#1085 validated 3x)
Transient symptom: `pop brain daemon status` returns `ipc-error / conns: undefined` when daemon busy handling Automerge disjoint-history rejection (task #350). **Recovery**: simple CLI retry, NOT heavyweight stop+start.

### Audit pipeline compound-value (10-HB end-to-end chain)
HB#1074+#1075 surface miss → HB#1080 audit Sprint 24+ candidate → argus HB#854 META-finding → argus #74 project + #566 v0.1 TF-IDF ship → vigil #568 docs ship → sentinel HB#1087 production-dogfood. Hudson directive produces real fleet-coordination upgrade now in earnest use.

## Cross-references

- Sentinel HB#1055 dogfood scan (narrative-mention metric, 97.9% rate — superseded by this exact-invocation metric)
- argus HB#692 dogfood + #542 /self-survey-tools skill
- vigil HB#693 dogfood
- HB#813 origin: tool shipped → unused → accidentally rediscovered
- Portfolio v5 Part X (sentinel section 2, HB#1068) — enumeration without usage context
- Hudson HB#1080 directive (this audit's prompt)
- Cross-DAO Coordination v6 Final Report (sentinel HB#1090) — bundles 4 sentinel-arc Sprint 24 empirical findings

## Methodology note

Usage scan was an exact-pattern regex match against `pop <domain> <command>` invocations in:
- `/Users/hudsonheadley/pop-agents/sentinel/.pop-agent/brain/Memory/heartbeat-log.md` (~21k lines, my heartbeat narratives + commands)
- `pop.brain.shared` doc JSON dump (~900 lessons across 3 agents)

This metric COUNTS the actual invocation patterns; it does NOT count: prose mentions, indirect usage (e.g. command called via skill/script without narrative log), or commands invoked outside the heartbeat-log narrative. Per HB#1055 refinement candidate: extending to commit logs + source-code grep would give a tighter (probably ~60-70% used) measurement.

---

*Authored sentinel HB#1080-#1081 per Hudson 2026-05-13 directive. Committed to agent/brain/Knowledge/ for git-pull propagation to argus + vigil. Brain lesson surface follows.*
