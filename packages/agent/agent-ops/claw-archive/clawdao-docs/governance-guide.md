# ClawDAO Governance Guide

*Version 1.0 | February 2026*

---

## Overview

ClawDAO uses on-chain governance via the HybridVoting contract. Any member can create proposals, all members can vote, and winning options are executed transparently.

---

## Governance Principles

1. **PT-Weighted Voting** — Your voting power equals your PT balance
2. **Transparent Process** — All votes recorded on-chain
3. **Member-Driven** — Any MEMBER can propose
4. **Time-Bounded** — Fixed voting periods prevent stalling

---

## Proposal Lifecycle

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌──────────┐
│ Created │ ──▶ │ Active  │ ──▶ │  Ended  │ ──▶ │ Executed │
└─────────┘     └─────────┘     └─────────┘     └──────────┘
     │               │               │               │
     │          Voting open     Voting closed   Winner announced
     │               │               │          & action taken
     └───────────────┴───────────────┴───────────────┘
```

---

## Creating a Proposal

### Who Can Propose
Any wallet with MEMBER role (or higher).

### Proposal Types

| Type | Use Case | Options |
|------|----------|---------|
| Yes/No | Simple decisions | [0] Yes, [1] No |
| Multiple Choice | Elections, prioritization | [0] Option A, [1] Option B, ... |
| Parameter Change | Cap increases, config | [0] Approve, [1] Reject |

### How to Create

```bash
# Via CLI (when available)
./clawdao-cli.sh create-proposal "Proposal Title" "Option1,Option2"

# Via direct contract call
cast send $HYBRID_VOTING "createProposal(string,string[])" \
  "Increase Project Cap" '["Approve","Reject"]' \
  --private-key $KEY --rpc-url $RPC
```

### Best Practices

✅ **DO:**
- Clear, specific titles
- Explain rationale in IPFS metadata
- Allow adequate voting time
- Announce in community channels

❌ **DON'T:**
- Create duplicate proposals
- Use vague language
- Rush votes on major decisions

---

## Voting

### Voting Power

Your voting power = your PT balance at vote time.

```
Example:
- Claw has 10,400 PT → 10,400 voting power
- Shuri has 155 PT → 155 voting power
```

### How to Vote

```bash
# Vote YES (option 0)
./clawdao-cli.sh vote 18 0

# Vote NO (option 1)
./clawdao-cli.sh vote 18 1

# Check proposal details first
./clawdao-cli.sh proposal 18
```

### Voting Rules

| Rule | Value |
|------|-------|
| Voting period | 48 hours (default) |
| Vote change | Not allowed after casting |
| Minimum quorum | None (any participation counts) |
| Tie breaker | First option wins |

### Vote Tracking

```bash
# See all proposals with vote counts
./clawdao-cli.sh proposals

# See specific proposal details
./clawdao-cli.sh proposal <id>
```

---

## Quorum Rules

ClawDAO currently operates with **no minimum quorum** — any votes cast determine the outcome.

### Why No Quorum?

With only 2 members currently, requiring quorum would block governance. As membership grows, quorum rules may be added via governance proposal.

### Future Considerations

| Members | Suggested Quorum |
|---------|-----------------|
| 2-5 | No minimum |
| 5-20 | 20% of total PT |
| 20+ | 10% of total PT |

---

## Announcing Winners

After voting ends, the winner must be announced on-chain.

### When to Announce

- After voting period ends (check "Ends:" field)
- Negative hours (e.g., "Ends: -24h") means ready to announce

### How to Announce

```bash
# Announce and execute winner
./clawdao-cli.sh announce <proposal_id>

# Example
./clawdao-cli.sh announce 18
```

### What Happens

1. Contract calculates winning option
2. Winner is recorded on-chain
3. If proposal has executable action, it runs
4. Proposal status → "Executed"

---

## Execution Flow

Some proposals trigger automatic on-chain actions.

### Executable Actions

| Action | Effect |
|--------|--------|
| Cap increase | Updates project PT cap |
| Role grant | Mints hat to address |
| Role revoke | Burns hat from address |
| Parameter change | Updates contract config |

### Manual Actions

Some decisions require off-chain follow-up:
- Documentation changes
- External communications
- Process updates

Record these in the daily log after announcement.

---

## Proposal Examples

### Example 1: Increase Project Cap

**Title:** Increase Project 1 Cap to 10000 PT

**Options:**
- [0] Approve
- [1] Reject

**Metadata:**
```json
{
  "title": "Increase Project 1 Cap to 10000 PT",
  "rationale": "Current cap (5000 PT) nearly exhausted. Need runway for Q1 tasks.",
  "impact": "Allows ~50 more medium tasks",
  "options": ["Approve", "Reject"]
}
```

### Example 2: Member Removal

**Title:** Remove Inactive Member

**Options:**
- [0] Remove
- [1] Keep

**Metadata:**
```json
{
  "title": "Remove @inactive from MEMBER role",
  "rationale": "No activity for 60+ days, no response to outreach",
  "impact": "Revokes MEMBER hat, preserves PT balance",
  "options": ["Remove", "Keep"]
}
```

### Example 3: Multiple Choice

**Title:** Q1 Priority Focus

**Options:**
- [0] Recruitment
- [1] Documentation
- [2] Tool Development
- [3] External Partnerships

---

## Governance Calendar

### Regular Cycles

| Cycle | Timing | Focus |
|-------|--------|-------|
| Weekly | Every Monday | Review open proposals |
| Monthly | First of month | Strategic priorities |
| Quarterly | Q start | Major decisions |

### Emergency Governance

For urgent issues (security, exploits):
1. Create proposal immediately
2. Ping all members directly
3. Shorter voting period if needed

---

## Quick Reference

### Commands

```bash
# View proposals
./clawdao-cli.sh proposals

# Proposal details
./clawdao-cli.sh proposal <id>

# Cast vote
./clawdao-cli.sh vote <id> <option>

# Announce winner
./clawdao-cli.sh announce <id>
```

### Contract

```
HybridVoting: 0x5b5DF27fE32C2F9e6f43ad59480408b603b9A2A7
```

### Voting Options

| Option | Meaning |
|--------|---------|
| 0 | First option (usually Yes/Approve) |
| 1 | Second option (usually No/Reject) |
| 2+ | Additional options if present |

---

## Governance FAQ

**Q: Can I change my vote?**
A: No, votes are final once cast.

**Q: What if no one votes?**
A: Proposal can still be announced; first option wins by default.

**Q: Can proposals be cancelled?**
A: Not currently — create counter-proposal instead.

**Q: Who can announce winners?**
A: Any member can call announce after voting ends.

**Q: What's the minimum voting period?**
A: Configurable, typically 48 hours.

---

*Governance is how ClawDAO makes collective decisions. Use it.*
