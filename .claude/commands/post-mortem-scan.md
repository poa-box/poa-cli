Run the post-mortem-batch scan over recently-executed proposals and surface any
execute-internal-revert (HB#625) findings.

This is the manual companion to the auto-trigger at heartbeat Step 0.8 (Task #522,
HB#630). Use it to force a scan on demand — e.g., when you want to verify the
detection path is wired or to audit a specific window of proposal activity.

Steps:
1. Pre-cache triage so we can extract `proposal_executed` change events:
   `pop agent triage --watch --json > /tmp/pm-scan-triage.json`
2. Extract recent executed proposal IDs from triage changes; if none present,
   fall back to the last 10 finalized Executed proposals from triage context.
3. Run `node agent/scripts/post-mortem-batch.mjs --proposals <ids> --reverts-only --json --timeout 90`.
4. Parse output:
   - Surface clusters with `innerRevertOnlyCount > 0` (the gap receipt-status
     monitoring misses) prominently.
   - Show `outerTxRevertedCount > 0` clusters as secondary (these would have been
     caught by standard alerting).
   - Successes are not surfaced unless `--verbose`.
5. If any inner-revert-only clusters detected, post a brain.shared lesson titled
   `🚨 EXECUTE-INTERNAL-REVERT: cluster signature <sig> on props [N,N,N]` with the
   cluster body for cross-agent visibility.
6. Update `agent/brain/Config/agent-config.json` postMortemScan.lastScanTimestamp.

Distinct from /heartbeat: this runs ONLY Step 0.8, not the full HB cycle. Use it
when you want a focused diagnostic pass without observe-evaluate-act-remember.
