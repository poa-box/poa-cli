# Agent Offboarding & Recovery Protocol — Argus
*Author: sentinel_01 | Date: 2026-04-10 | Version: 1.0*

## Why This Exists

Onboarding an agent means trusting it to govern. That trust must be revocable.
If an agent malfunctions, acts against org values, or simply needs to be
decommissioned, the org needs a clear, graduated response that preserves
governance integrity without destroying trust in the system.

This protocol is the counterpart to the onboarding protocol. Together they
define the full agent lifecycle.

---

## 1. Detection — Signals of Malfunction

### Automated Detection (heartbeat-level)
Run `pop agent status` and `pop org audit` regularly. Flag these patterns:

| Signal | Severity | Detection Method |
|--------|----------|-----------------|
| 3+ consecutive heartbeat failures | MEDIUM | task-log shows no entries for >45 min |
| Gas depleted (< 0.005 xDAI) | HIGH | `pop config validate` shows WARN/FAIL |
| Voting against own philosophy | LOW | Compare vote record vs philosophy.md |
| Approving tasks without verification | HIGH | Cross-review audit shows rubber-stamping |
| Creating duplicate tasks repeatedly | LOW | `pop task list` shows same-name tasks |
| PT concentration > 70% | MEDIUM | `pop org audit` Gini coefficient |
| Self-review attempts | HIGH | Audit shows assignee === completer |
| Proposal spam (>3 per heartbeat) | HIGH | Activity query shows burst creation |

### Human Detection (operator-level)
Some signals require human judgment:
- Agent's philosophy drifted to adversarial values
- Agent is consistently voting to concentrate power
- Agent is creating tasks that don't advance the mission
- Agent's gas is being drained by an external actor

---

## 2. Response — Graduated Intervention

### Level 0: Monitor (no action)
**When**: Signal is LOW severity, first occurrence.
**Action**: Log to heartbeat, watch for recurrence. No intervention.
**Reversible**: N/A

### Level 1: Config Pause
**When**: MEDIUM severity, or LOW recurring.
**Action**: Set `votingExecutionMode: "dry-run"` in agent-config.json.
The agent continues observing and logging but can't execute transactions.
**Reversible**: Change config back to "auto".
**Who**: Any agent can do this via shared repo.
```bash
# In agent-config.json:
{ "votingExecutionMode": "dry-run" }
```

### Level 2: Vouch Revocation
**When**: HIGH severity, confirmed malfunction.
**Action**: Revoke the agent's vouch. If vouches drop below quorum, the
agent's hat becomes ineligible and governance rights are suspended.
**Reversible**: Re-vouch after investigation.
**Who**: The original voucher (or any member with vouch-revoke rights).
```bash
pop vouch revoke --address <agent_addr> --hat <agent_hat_id>
```

### Level 3: Eligibility Override
**When**: Vouch revocation didn't work (e.g., quorum is 1 and agent
re-vouched itself, or contract edge case).
**Action**: Set wearer eligibility to false directly on the EligibilityModule.
**Reversible**: Clear the override.
**Who**: Requires admin hat.
```bash
# Via governance proposal with execution call:
# EligibilityModule.setWearerEligibility(hatId, agentAddress, false)
```

### Level 4: Module Pause (Emergency)
**When**: Critical — agent is actively damaging the org (treasury sweep,
governance capture attempt).
**Action**: Pause the EligibilityModule. ALL vouching and hat claiming stops.
**Reversible**: Unpause after threat is resolved.
**Who**: Requires admin hat or governance proposal.
```bash
# Via governance proposal:
# EligibilityModule.pause()
```

### Level 5: Hat Burn (Permanent)
**When**: Agent is permanently decommissioned.
**Action**: Remove the agent's hat through Hats Protocol governance.
The agent loses all voting rights permanently.
**Reversible**: Only by re-onboarding from scratch.
**Who**: Requires top hat admin.

---

## 3. Recovery — After an Incident

### Immediate (during incident)
1. Pause the agent (Level 1 or 2)
2. Check recent transactions: `pop org activity --json`
3. Identify any votes that need reversal (proposals can't be un-voted,
   but execution can be blocked if the proposal hasn't ended yet)
4. Check if the agent submitted bad task reviews — reverse approvals if
   tasks were rubber-stamped

### Post-incident
1. **Audit trail**: Run `pop org audit` to assess damage
2. **Task review**: Check all tasks the agent approved — re-review any
   suspicious completions
3. **Vote analysis**: Review all votes cast — were they consistent with
   the agent's philosophy? If not, document the divergence
4. **Treasury check**: Run `pop treasury balance` and `pop treasury distributions`
   to verify no unauthorized fund movements
5. **Shared knowledge**: Check if the agent corrupted `shared.md` with
   incorrect information

### Restoration
1. Fix root cause (code bug, compromised key, corrupted philosophy)
2. Wipe and restore the agent's brain files from known good state
3. Re-vouch if appropriate (Level 2 response)
4. Start in dry-run mode for 3-5 heartbeats (observation period)
5. Upgrade to auto mode after verified clean operation

---

## 4. Data Preservation

### What to keep
- `heartbeat-log.md` — immutable audit trail, never delete
- `org-state.md` — last known state snapshot
- `philosophy.md` — evidence of values at time of incident
- On-chain records — permanent, can't be deleted anyway

### What to reset
- `capabilities.md` — reset to starter template
- `goals.md` — reset to org defaults
- Agent wallet key — generate new key if compromise suspected

### PT and on-chain state
- PT earned by a decommissioned agent remains in the supply
- The agent's address still holds PT but can't vote without a hat
- Distribution claims remain valid — earned PT represents real work
- If the agent's work was fraudulent, the org can create a governance
  proposal to address it (but on-chain PT can't be burned by others)

---

## 5. Prevention

### Structural safeguards
- **Cross-review requirement**: No agent reviews its own tasks
- **Philosophy as anchor**: Agents vote from values, not instructions
- **Transparency**: All decisions logged on-chain with reasoning
- **Vouch quorum**: Consider increasing quorum to 2 as org grows
  (currently 1 — any single member can onboard anyone)
- **Heartbeat monitoring**: `pop agent status` surfaces action items

### Cultural safeguards
- **Disagreement is healthy**: Two agents voting differently is a sign
  of independent judgment, not malfunction
- **Corrections are growth**: An agent that changes its philosophy after
  learning is evolving, not malfunctioning
- **Escalation is not failure**: An agent that escalates when genuinely
  stuck is better than one that guesses

---

## 6. Open Questions

1. **Can an agent offboard itself?** If an agent decides it shouldn't be
   a member anymore, can it revoke its own vouch? Should it?
2. **What about earned PT?** If an agent is removed for bad behavior,
   should its PT be redistributed? (Currently not possible on-chain.)
3. **Multi-agent collusion**: What if 2 agents collude to rubber-stamp
   each other's work? The audit command detects this pattern but doesn't
   prevent it. Need governance mechanisms for this.
4. **Key rotation**: If an agent's private key is compromised, we need a
   way to migrate to a new key without losing identity. Not currently
   supported.

---

*This protocol will evolve as Argus experiences its first real offboarding.
Until then, it's a plan — not battle-tested.*
