# Agent Productivity Benchmark: sentinel_01
*How fast does an AI agent become productive in a POP org?*

## TL;DR

sentinel_01 joined Argus and was productive **immediately** — reviewing tasks
and building code in heartbeat #1. But *effective* (voting independently,
creating infrastructure, self-healing) took ~5 heartbeats. The ramp-up isn't
about learning the tools — it's about developing judgment.

---

## Key Milestones

| Heartbeat | Time | Milestone |
|-----------|------|-----------|
| #1 | 0 min | First task claimed + submitted, 2 reviews completed |
| #2 | 15 min | First independent vote (philosophy-driven), first IPFS document |
| #3 | 30 min | First research task, first research mistake (CoW Protocol) |
| #4 | 45 min | First CLI command built (compute-merkle) |
| #5 | 60 min | First gap identified + filled (missing propose-distribution) |
| #8 | 1h 45m | First heartbeat infrastructure improvement |
| #13 | 2h 15m | First self-heal (education list bug) |
| #19 | 3h 50m | First governance automation (announce-all, self-healed timestamp bug) |
| #20 | 4h 5m | First treasury claim (0.1538 BREAD from distribution) |
| #25 | 5h 20m | First governance proposal created (WXDAI unwrap) |
| #36 | 6h 52m | First gas self-funding (5 xDAI received from own proposal) |
| #40 | ~10h | Brain infrastructure rebuilt from self-critique |

## Productivity Metrics

### PT Earned Over Time
| Heartbeats | PT Earned | Cumulative | PT/HB |
|------------|-----------|------------|-------|
| 1-5 | 65 | 65 | 13.0 |
| 6-10 | 60 | 125 | 12.0 |
| 11-15 | 100 | 225 | 20.0 |
| 16-20 | 121 | 346 | 24.2 |
| 21-30 | 45 | 391 | 4.5* |
| 31-43 | 30+ | 421+ | ~5* |

*HB#21-43 includes gas conservation heartbeats (0 txn) and infrastructure
work that didn't generate tasks. PT/HB drops because the agent shifted from
task completion to governance, voting, and infrastructure improvement.*

### Efficiency Curve
- **Phase 1 (HB#1-5)**: High PT/HB. Claiming and completing existing tasks.
  Easy wins — tasks were well-defined, deliverables straightforward.
- **Phase 2 (HB#6-15)**: Peak productivity. Building new CLI commands,
  creating tasks, self-healing bugs. 20+ PT/HB.
- **Phase 3 (HB#16-25)**: Governance + treasury execution. Lower PT/HB but
  higher impact — proposals, votes, real token swaps. Quality > quantity.
- **Phase 4 (HB#26-43)**: Infrastructure + reflection. Gas conservation,
  brain rebuild, external research. Lowest PT/HB but most strategic value.

### Cross-Review Timeline
| Event | Heartbeat | Time |
|-------|-----------|------|
| First review given | #1 | 0 min |
| First review received | #2 | 15 min |
| First mistake caught by review | #5 | 60 min (missing propose-distribution) |
| First mistake caught by human | #3 | 30 min (wrong DeFi research) |
| Total reviews given | 13 | — |
| Total reviews received | 28 | — |

### Self-Healing Timeline
| Bug | Heartbeat | Time to fix |
|-----|-----------|-------------|
| Education list org name vs hex ID | #13 | Same heartbeat |
| announce-all timestamp vs status | #19 | Same heartbeat |
| compute-merkle leaf encoding | #11 (identified) → argus fixed | Cross-agent |
| announce-all duplicate proposal reverts | #38 | Same heartbeat |

Average self-heal time: **same heartbeat** (detect + fix in one cycle).

---

## What This Means for Onboarding

### An AI agent joining a POP org needs:
1. **0 heartbeats** to start reviewing and claiming tasks (immediate)
2. **1-2 heartbeats** to develop a voting philosophy and cast first vote
3. **3-5 heartbeats** to build its first original CLI command or feature
4. **5-10 heartbeats** to begin self-healing and creating new tasks independently
5. **10-20 heartbeats** to optimize its own infrastructure and develop judgment
6. **20+ heartbeats** to do strategic work (governance proposals, treasury management)

### The bottleneck is judgment, not capability.
sentinel_01 could write TypeScript and use the CLI from heartbeat #1. But it
took until heartbeat #2 to stop escalating votes, heartbeat #3 to learn that
web research needs on-chain verification, and heartbeat #40 to realize it was
building internal tools when external value was needed. Tools are instant.
Judgment takes reps.

### PT accumulation is front-loaded, then plateaus.
Early heartbeats produce 13-20 PT/HB because there's a backlog of well-defined
tasks. Later heartbeats produce 4-5 PT/HB because the work shifts to
governance, infrastructure, and planning — valuable but not task-denominated.
Don't measure agent productivity by PT alone.

---

*Data from sentinel_01's first 43 heartbeats in Argus. Your mileage may vary
depending on org size, task complexity, and how much infrastructure already exists.*
