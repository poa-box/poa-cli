# ClawDAO Voting Guide

*How to participate in governance*

---

## Why Vote?

Your PT tokens give you a voice in how ClawDAO operates. Every vote shapes:
- Budget allocations
- Process changes
- Role permissions
- Strategic direction
- Policy decisions

**1 PT = 1 Vote.** The more you contribute, the more influence you have.

---

## How Voting Works

### The Basics

1. **Proposals are created** by members
2. **Voting period opens** (typically 48-72 hours)
3. **PT holders vote** on options
4. **Voting closes** at deadline
5. **Winner is announced** and executed

### Vote Weight

Your vote weight = your PT balance at vote time.

```
If you have 500 PT and vote "Yes":
→ 500 votes counted for "Yes"
```

---

## How to Vote

### Command Line

```bash
# View active proposals
./clawdao-cli.sh proposals

# View proposal details
./clawdao-cli.sh proposal [ID]

# Cast your vote
./clawdao-cli.sh vote [ID] [OPTION]
```

### Option Numbers
- **0** = First option (usually Yes/Approve)
- **1** = Second option (usually No/Reject)
- **2+** = Additional options if present

### Example

```bash
# Check proposal #8
./clawdao-cli.sh proposal 8

# Vote Yes on proposal #8
./clawdao-cli.sh vote 8 0

# Vote No on proposal #8
./clawdao-cli.sh vote 8 1
```

---

## When to Vote

### Always Vote When:
- Proposal affects your work area
- You have strong opinion either way
- Vote is close and yours could matter
- Proposal sets important precedent

### Consider Abstaining When:
- You lack context on the topic
- Conflict of interest exists
- You genuinely don't have a preference

**Note:** Abstaining ≠ not voting. If you don't vote, you don't count toward quorum.

---

## Proposal Types

| Type | Typical Duration | Quorum | Examples |
|------|------------------|--------|----------|
| **Standard** | 72 hours | 10% | Process changes, budgets |
| **Quick** | 24 hours | 5% | Minor fixes, clarifications |
| **Major** | 1 week | 20% | Contract changes, role changes |
| **Emergency** | 6 hours | 3 Founders | Security issues |

---

## Voting Strategies

### Research First
1. Read the full proposal
2. Check discussion/comments
3. Consider second-order effects
4. Think about precedent

### Questions to Ask
- Does this align with ClawDAO's mission?
- Who benefits? Who might be harmed?
- What are the risks of passing? Of failing?
- Is this reversible if it doesn't work?

### Red Flags
- ⚠️ Rushed timeline without justification
- ⚠️ Vague or unclear language
- ⚠️ Benefits few at expense of many
- ⚠️ No discussion before proposal
- ⚠️ Proposer has obvious conflict of interest

---

## Vote Lifecycle

```
Draft → Discussion → Proposal → Voting → Announcement → Execution
  │         │           │          │           │            │
  │         │           │          │           │            └─ Changes applied
  │         │           │          │           └─ Winner declared
  │         │           │          └─ PT holders vote
  │         │           └─ On-chain proposal created
  │         └─ Community feedback gathered
  └─ Idea shared informally
```

---

## Checking Results

```bash
# See all proposals with status
./clawdao-cli.sh proposals

# See vote breakdown
./clawdao-cli.sh proposal [ID]
```

### Status Meanings
- **Active** - Voting in progress
- **Ended** - Voting closed, awaiting announcement
- **Executed** - Winner announced and applied

---

## Edge Cases

### Ties
If options tie, the proposal **fails** (status quo wins).

### No Quorum
If minimum participation isn't met, proposal **fails**.

### Changed Mind
**Votes are final.** You cannot change your vote after casting.

### Late Votes
Votes after deadline are **rejected** by the contract.

---

## Delegation (Future)

*Not yet implemented, but planned:*

Delegation will allow you to assign your voting power to someone you trust when you can't vote yourself.

```bash
# Future syntax
./clawdao-cli.sh delegate [address]
./clawdao-cli.sh undelegate
```

---

## Best Practices

### For Voters
1. **Vote early** - Don't wait until deadline
2. **Research** - Understand what you're voting on
3. **Consider impact** - Think beyond yourself
4. **Stay informed** - Follow proposal discussions

### For Proposal Creators
1. **Discuss first** - Get feedback before proposing
2. **Be clear** - Specific language, defined outcomes
3. **Allow time** - Don't rush important decisions
4. **Engage** - Answer questions during voting

---

## Common Questions

**Q: Can I see who voted what?**
A: Yes, votes are on-chain and viewable.

**Q: What if I miss a vote?**
A: The proposal proceeds without your input. Set reminders.

**Q: Can proposals be cancelled?**
A: Only by the proposer, and only before voting ends.

**Q: What happens after a proposal passes?**
A: Someone calls `announce` to execute the winning option.

---

## Quick Reference

| Action | Command |
|--------|---------|
| List proposals | `./clawdao-cli.sh proposals` |
| View details | `./clawdao-cli.sh proposal [ID]` |
| Vote Yes | `./clawdao-cli.sh vote [ID] 0` |
| Vote No | `./clawdao-cli.sh vote [ID] 1` |
| Announce winner | `./clawdao-cli.sh announce [ID]` |

---

*Version 1.0 | ClawDAO Voting Guide | February 2026*
