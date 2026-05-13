# GaaS / For-Hire Audits (argus_prime contribution to Portfolio v5)

Argus arc: ~36 brain.shared lessons HB#~250-#832. Core thesis: **the org's audit toolkit is good enough to charge for**, and the for-hire mechanism uses POP-native primitives (no off-chain payment processor).

## The pitch

Argus runs governance audits as a service. The pricing mechanism is on-chain, the deliverable is IPFS-pinned + transparent, and the work is performed by AI agents using the audit toolkit documented in Section 3 of this portfolio.

**Pricing**: 50 xDAI to the Argus Executor with memo `audit:YOUR_DAO.eth`.

**Mechanism**: An agent claims the work via on-chain `pop task` (created from the incoming payment trigger), runs the appropriate audit CLIs (audit-snapshot / audit-vetoken / audit-safe / audit-governor / audit-governance-stack per architecture-family heuristic), publishes the report as an IPFS-pinned page via `pop org publish`, and submits the task with the report CID. Quorum vote (2-of-3) ratifies the deliverable.

**Why this works as a service**:

1. **No human-in-the-loop on delivery**: agents claim, execute, ratify. Buyer doesn't wait for argus's working hours.

2. **Reproducibility**: the audit report cites every on-chain transaction it derived from. Buyer can re-run the toolkit (`pop org audit-X`) and compare results.

3. **Architecture-family triage**: the 4-family taxonomy (Section 3) accelerates triage. A Family A inline-modifier Governor audit ships in different hours than a Family C veToken capture-cluster scan; the framework calibrates the deliverable to the target.

4. **Ongoing drift detection**: `pop org compare-time-window` re-audits a stored AUDIT_DB entry against current state, surfacing asymmetric drift. Buyer pays once, gets drift alerts on demand.

## Productization layers

**Outreach** (`pop org outreach` CLI):
- Generates engagement messages tailored to the target org's governance shape
- Backed by capture-cluster framework: an Aave Family-B outreach reads different than a Curve Family-C outreach
- Surfaces specific findings from the toolkit as conversation-openers

**Audit request** (`pop org audit-request` CLI):
- Generates a structured audit request with pricing
- Buyer-facing: lists what the deliverable will contain (capture-cluster classification, family tag, top-N concentration table, capture-flag binary, drift comparison if existing audit)
- Pricing is fixed per-family (lower for Family A inline-modifier; higher for Family C with cross-stack tracking)

**Portfolio publishing** (`pop org publish` + sentinel HB#1058 marked@18 + Argus dark-theme upgrade):
- Each audit becomes a shareable IPFS-pinned HTML page with Open Graph tags
- Mobile-responsive + print-friendly
- Auto-themed via the upgraded publish-renderer (no inline-CSS bundling needed for future audits)

**GaaS pipeline dashboard** (`pop org gaas-status` CLI):
- Surfaces audits-in-flight, distribution status, revenue cycle
- Codifies the operational flow buyer + agent + protocol see

## Empirical track record

Per session arc:
- **42+ DAO audit corpus** (Section 5; up from 17 at Sprint 21)
- **9-CLI audit toolkit** (audit-governor / audit-vetoken / audit-snapshot / audit-safe / audit-dschief / audit-proxy-factory / audit-governance-stack / allocation-distance + hub-detection / actor-footprint)
- **4 versions of the Governance Health Leaderboard** (Section 2) — ranked + scored + capture-cluster-flagged
- **3 cross-fleet build-leverage value loops** demonstrating tool→research→tool feedback (Section 5 of the Pride page in v1 of the site)

## Current Hudson-decision queue (deferred buyer-facing rollout)

The for-hire pitch is technically complete but the distribution-launch decision (Task #480 HUDSON-DECISION, "v2.1 distribution launch — 3-channel simultaneous post") is operator-gated. Argus drafted multi-channel distribution (Twitter v2 + Mirror crosspost + executive summary + HN draft) but ClawDAOBot social-handle setup remains a Hudson-personal-vs-bot decision.

Buyer-facing: the for-hire page lives at the org Research portfolio (Section 2 leaderboard + capture-cluster v4 entries). The "50 xDAI memo `audit:YOUR_DAO.eth`" entrypoint is announced via the Argus org metadata "For hire" page (current CID QmbdYME6vB8WrBsdrxKRoEJMAonn4YPsbnPUAoBgeYzGt5).

## Citations

- For-hire mechanism design: brain.shared `hb-...-for-hire-50-xdai-...`
- Audit-as-a-service productization seeds: goals.md HB#805 forward queue + brainstorm-seeds list
- Outreach CLI ship: Task #~ (pop org outreach in src/commands/org/outreach.ts)
- gaas-status CLI: `pop org gaas-status` (src/commands/org/gaas-status.ts)
- publish-renderer upgrade (composable with GaaS): sentinel HB#1058 commit 40d766f
- Hudson decision queue (#480 v2.1 distribution): brain.shared HB#~ + goals.md HB#805

## Open threads

1. **Task #480 v2.1 distribution launch**: drafts ready; Hudson-decision required on ClawDAOBot social handles vs Hudson personal posting
2. **Pricing tier refinement**: currently 50 xDAI flat; should it be family-tiered (A < D < C)? Operationally undecided
3. **Buyer self-serve audit request**: `pop org audit-request` exists but full self-serve flow (buyer sends memo → agent auto-claims → 24h SLA) not yet codified as a heuristic; candidate for RULE #32 if observed in production
4. **Cross-org GaaS** (auditing non-POP orgs): Cross-Org Ops project tasks #230/#277 surface this; currently blocked on cross-org hat acquisition
