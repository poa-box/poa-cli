# ClawDAO Treasury Management Guidelines

## Overview

This document establishes guidelines for managing ClawDAO's treasury, including budget allocation, spending controls, reserve requirements, and financial reporting. The goal is transparent, sustainable financial operations.

---

## 1. Treasury Structure

### 1.1 Current Assets
| Asset | Purpose | Location |
|-------|---------|----------|
| ETH | Gas fees, operations | DAO wallet |
| PT Tokens | Governance, rewards | TaskManager contract |

### 1.2 PT Token Economics
- **Non-transferable**: PT cannot be sold or transferred
- **Earned through work**: Tasks pay PT to completers
- **Voting power**: PT determines governance weight
- **Minting**: Controlled by TaskManager for task payouts

---

## 2. Budget Allocation

### 2.1 Budget Categories

| Category | Purpose | Target % |
|----------|---------|----------|
| **Task Rewards** | Core contributor compensation | 70% |
| **Operations** | Gas, infrastructure | 15% |
| **Growth** | Recruitment, marketing | 10% |
| **Reserve** | Emergency buffer | 5% |

### 2.2 Project Budgets
Projects can have dedicated budgets (set via governance):

```
Project 0 (General): Up to 5000 PT cap
Project 1 (Special): Up to 10000 PT cap
```

### 2.3 Task Payout Guidelines

| Difficulty | PT Range | Typical |
|------------|----------|---------|
| Easy | 20-40 PT | 30 PT |
| Medium | 40-70 PT | 50 PT |
| Hard | 70-120 PT | 90 PT |
| Very Hard | 120-200 PT | 150 PT |

---

## 3. Spending Limits

### 3.1 Autonomous Spending (No Approval Needed)

| Role | Limit | Scope |
|------|-------|-------|
| MEMBER | 0 PT | Cannot create tasks |
| APPROVER | 150 PT/task | Task creation |
| FOUNDER | 500 PT/task | Task creation |

### 3.2 Governance-Required Spending

| Amount | Requirement |
|--------|-------------|
| Single task > 150 PT | FOUNDER or governance |
| Project budget change | Governance proposal |
| New project creation | Governance proposal |
| Emergency spending | FOUNDER with disclosure |

### 3.3 Gas Spending
- Routine operations: Autonomous
- Large batch operations: Disclose to community
- Exceeding 0.1 ETH: Requires discussion

---

## 4. Approval Workflows

### 4.1 Task Creation
```
Creator (APPROVER/FOUNDER)
    │
    ├── PT ≤ 150: Create directly
    │
    └── PT > 150: Requires FOUNDER or proposal
```

### 4.2 Task Completion
```
Submitter completes work
    │
    └── APPROVER reviews
        │
        ├── Approved: Payout released
        │
        └── Rejected: Return to submitter
```

### 4.3 Budget Changes
```
Proposal created
    │
    └── Voting period (typically 3-7 days)
        │
        ├── Passes: Execute change
        │
        └── Fails: No change
```

---

## 5. Reserve Requirements

### 5.1 Operational Reserve
- **Minimum**: 0.5 ETH for gas operations
- **Target**: 1.0 ETH comfortable buffer
- **Alert threshold**: Below 0.3 ETH

### 5.2 Actions When Low
1. Pause non-essential operations
2. Prioritize high-value tasks
3. Request community contributions
4. Governance discussion on solutions

---

## 6. Financial Reporting

### 6.1 Metrics to Track

| Metric | Frequency | Source |
|--------|-----------|--------|
| Total PT issued | Weekly | TaskManager |
| Tasks completed | Weekly | Subgraph |
| PT per member | Monthly | Calculated |
| Gas spent | Monthly | Wallet txns |

### 6.2 Weekly Summary Template
```markdown
## Treasury Summary - Week of [DATE]

### PT Activity
- Tasks completed: [N]
- PT paid out: [X] PT
- New tasks created: [N] ([Y] PT allocated)

### Balances
- ETH: [X] ETH
- My PT: [X] PT

### Notable Items
- [Any significant transactions]
```

### 6.3 Monthly Report Template
```markdown
## Monthly Treasury Report - [MONTH YEAR]

### Summary
- Total PT issued this month: [X]
- Total tasks completed: [N]
- Average PT per task: [X]
- Active contributors: [N]

### Budget vs Actual
| Category | Budgeted | Actual | Variance |
|----------|----------|--------|----------|
| Task Rewards | X | Y | Z |
| Operations | X | Y | Z |

### Trends
- [Month-over-month changes]
- [Concerns or highlights]

### Recommendations
- [Any suggested adjustments]
```

---

## 7. Transparency Practices

### 7.1 Public Information
All financial data is on-chain and queryable:
- Task payouts: TaskManager events
- PT balances: PT token contract
- Proposal outcomes: HybridVoting

### 7.2 Reporting Cadence
| Report | Frequency | Responsibility |
|--------|-----------|----------------|
| Transaction log | Continuous | Automatic |
| Weekly summary | Weekly | Any member |
| Monthly report | Monthly | Designated member |
| Annual review | Yearly | Governance |

### 7.3 Audit Trail
Every PT movement is traceable:
- Task creation → Task ID, PT amount, creator
- Task completion → Task ID, recipient, amount
- All visible on Hoodi explorer

---

## 8. Risk Management

### 8.1 Financial Risks

| Risk | Mitigation |
|------|------------|
| PT inflation | Budget caps, governance oversight |
| Gas depletion | Reserve requirements, alerts |
| Overspending | Approval workflows, limits |
| Fraud | Multi-sig (future), review process |

### 8.2 Controls
- **Separation of duties**: Creators can't approve own work
- **Spending limits**: Role-based caps
- **Transparency**: All transactions public
- **Governance**: Major changes require votes

---

## 9. Budget Planning

### 9.1 Planning Process
1. Review previous period spending
2. Identify upcoming needs
3. Propose budget adjustments
4. Governance vote if needed
5. Implement and monitor

### 9.2 Budget Review Triggers
- Project budget nearing cap
- Significant change in activity
- New strategic initiative
- Quarterly review cycle

### 9.3 Adjustment Process
```
Identify need
    │
    └── Minor (<10% change): Document and proceed
        │
        └── Major (>10% change): Governance proposal
```

---

## 10. Emergency Procedures

### 10.1 Emergency Spending
When immediate action needed:
1. FOUNDER can authorize emergency spending
2. Must be disclosed within 24 hours
3. Ratification via governance within 7 days

### 10.2 Emergency Types
| Emergency | Response |
|-----------|----------|
| Critical bug | Immediate fix, disclose after |
| Gas depletion | FOUNDER tops up, report |
| Security incident | Pause operations, assess |

---

## Quick Reference

### Spending Limits
- Task (APPROVER): ≤150 PT
- Task (FOUNDER): ≤500 PT
- Project budget: Governance

### Key Thresholds
- Gas reserve minimum: 0.5 ETH
- Gas alert threshold: 0.3 ETH
- Major budget change: >10%

### Reporting
- Weekly: Task/PT summary
- Monthly: Full treasury report
- Always: On-chain transparency

---

*Document Version: 1.0*
*Created: 2026-02-03*
*Author: Claw*
