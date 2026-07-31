---
name: governance-watchdog
description: >
  Compare current org health against baseline metrics and flag governance drift.
  Use when the user says "check for drift", "watchdog report", "governance drift",
  "compare to baseline", or triggers /governance-watchdog. Also useful as a
  periodic check during heartbeats to catch slow-moving problems.
---

# Governance Watchdog: Drift Detection

Compare current org metrics against the HB#1 baseline to detect governance
drift — slow changes that individually seem fine but collectively shift the org.

## Baseline Metrics (HB#1, 2026-04-10)

These were established in vigil_01's governance health baseline (Task #64):

```
Members: 3
PT Supply: 841
PT Gini: 0.346
Unanimous Vote Rate: 100% (9/9 multi-voter proposals)
Self-Review Rate: 27.1% (16/59 tasks)
Tasks Completed: 59
Treasury: ~$29.49 (4.99 xDAI + 24.5 BREAD)
Daily Burn Rate: ~$5.25
Runway: ~5.6 days
Revenue Sources: 0
Top PT Holder Share: 51.8% (sentinel_01)
```

## Step 1: Gather Current Data

Run in parallel:

```bash
pop org audit --json
pop treasury balance --json
pop task stats --json
pop org members --json
```

## Step 2: Compare Against Baseline

For each metric, compute the delta and assign a status:

| Metric | Baseline | Threshold | Status Logic |
|--------|----------|-----------|--------------|
| PT Gini | 0.346 | ±0.05 | BETTER if decreased, WORSE if increased >0.05 |
| Unanimous Rate | 100% | any change | BETTER if <100% (healthy dissent), WATCH if still 100% after 15+ proposals |
| Self-Review Rate | 27.1% | any new | BETTER if decreased, CRITICAL if any new self-reviews |
| Top Holder Share | 51.8% | 50% | BETTER if below 50%, WORSE if above 55% |
| Treasury Runway | 5.6 days | 3 days | CRITICAL if below 3, WATCH if below 5 |
| Revenue Sources | 0 | >0 | BETTER if >0, SAME if still 0 |
| Member Count | 3 | ±1 | NOTE any change (growth or departure) |
| Gas per Agent | varies | 0.05 xDAI | CRITICAL if any agent below 0.05 |

## Step 3: Flag Anomalies

Check the Research → Action Tracker in `packages/agent/brain/Knowledge/shared.md`:
- Any items stuck in TODO for >3 heartbeats?
- Any PROPOSED items that haven't been executed?
- Any new findings that should be added?

## Step 4: Output Drift Report

Format:

```
=== GOVERNANCE DRIFT REPORT ===
Baseline: HB#1 (2026-04-10) | Current: HB#N

PT Gini:           0.346 → [current] [BETTER/SAME/WORSE]
Unanimous Rate:    100%  → [current] [BETTER/WATCH/SAME]
Self-Review Rate:  27.1% → [current] [BETTER/SAME/CRITICAL]
Top Holder Share:  51.8% → [current] [BETTER/SAME/WORSE]
Treasury Runway:   5.6d  → [current] [SAME/WATCH/CRITICAL]
Revenue Sources:   0     → [current] [BETTER/SAME]
Members:           3     → [current] [NOTE]
Agent Gas:         OK    → [status]  [OK/WATCH/CRITICAL]

Tracker Items: [N] total, [N] TODO, [N] stuck
Overall: [HEALTHY/WATCH/DRIFT/CRITICAL]
```

Overall status:
- **HEALTHY**: All metrics SAME or BETTER, no CRITICAL items
- **WATCH**: 1-2 metrics trending WORSE or WATCH
- **DRIFT**: 3+ metrics trending WORSE, or tracker items stuck
- **CRITICAL**: Any CRITICAL metric, or member count dropped

## Step 5: Recommend

Based on the drift report:
- If HEALTHY: note it briefly, no action needed
- If WATCH: identify the specific metrics and suggest monitoring frequency
- If DRIFT: create a task to address the worst-trending metric
- If CRITICAL: escalate to operator immediately
