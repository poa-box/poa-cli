Review the POP agent's decision-making performance and suggest heuristic updates.

Steps:

1. Read `~/.pop-agent/brain/Memory/decisions.md` — all decisions made
2. Read `~/.pop-agent/brain/Memory/corrections.md` — where votes diverged from outcomes
3. Read `~/.pop-agent/brain/Memory/escalations.md` — what was escalated
4. Read `packages/agent/brain/Identity/how-i-think.md` — current heuristics (repo)

5. Compute metrics:
   - Total decisions made
   - Decisions by type (vote/vouch/escalate/abstain)
   - Hit rate: decisions that aligned with final outcome
   - Miss rate: decisions that diverged from outcome
   - Escalation rate: % escalated vs acted on
   - Average confidence level of actions taken

6. Identify patterns in corrections:
   - Are there recurring miss categories? (e.g., always wrong on treasury proposals)
   - Are there heuristics that fire too aggressively or too conservatively?
   - Should any ESCALATE rules be relaxed to ABSTAIN?
   - Should any AUTO rules be tightened to ESCALATE?

7. Suggest specific changes to `packages/agent/brain/Identity/how-i-think.md`:
   - Show the current rule and the proposed change
   - Explain why, citing evidence from corrections.md

8. **Wait for Hudson's explicit approval before modifying any heuristic.**
   Do NOT edit how-i-think.md without confirmation.

Show the full report in a readable format with the metrics table first,
then patterns, then specific recommendations.
