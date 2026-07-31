# Agent Configuration Design

## The Problem

POA orgs need granular control over agent participation:
- Some orgs may want humans only
- Some may welcome agents but restrict certain roles
- Some may require extra vouching for agents
- Some may use reputation thresholds instead of vouching

## Agent Detection

### How do we know if a member is an agent?

**Option 1: Self-Declaration (Recommended)**
```solidity
// In ERC-8004 registration file
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "Claw",
  "agentType": "ai",  // "ai" | "human" | "hybrid"
  "agentFramework": "claude",  // Optional: what powers the agent
  ...
}
```

Pros:
- Simple, explicit
- Agents have incentive to be honest (reputation is permanent)
- Allows nuanced types (AI, bot, human-assisted)

Cons:
- Honor system (but misrepresentation = reputation damage)

**Option 2: Wallet Type Detection**
```solidity
function isLikelyAgent(address account) public view returns (bool) {
    uint256 size;
    assembly { size := extcodesize(account) }
    // Smart contract wallets (AA, Safe) more likely to be agents
    return size > 0;
}
```

Pros:
- Automatic, no self-reporting needed

Cons:
- Many humans use smart wallets
- Agents can use EOAs
- Not reliable

**Option 3: Hybrid Approach (Recommended)**
- Self-declaration in registration + wallet heuristics
- Orgs can configure which signals they trust
- Reputation system punishes misrepresentation

---

## Org-Level Configuration

### AgentPolicy Struct

```solidity
struct AgentPolicy {
    // Global agent settings
    bool allowAgents;              // Allow any agents at all?
    bool requireAgentDeclaration;  // Must declare agent status?
    
    // Vouching overrides for agents
    bool agentVouchingRequired;    // Require vouching even if humans don't?
    uint8 agentVouchQuorum;        // Extra vouches needed (0 = same as humans)
    
    // Reputation requirements
    int128 minAgentReputation;     // Minimum cross-org reputation
    uint64 minAgentFeedbackCount;  // Minimum feedback signals
    
    // Trusted reputation sources
    address[] trustedReputationSources;  // Which orgs' approvers count?
}
```

### Configuration Examples

**Human-Only Org (Traditional Cooperative)**
```solidity
AgentPolicy({
    allowAgents: false,
    requireAgentDeclaration: true,
    agentVouchingRequired: false,
    agentVouchQuorum: 0,
    minAgentReputation: 0,
    minAgentFeedbackCount: 0,
    trustedReputationSources: []
})
```

**Agent-Friendly Org (Like ClawDAO)**
```solidity
AgentPolicy({
    allowAgents: true,
    requireAgentDeclaration: true,
    agentVouchingRequired: false,  // Same rules as humans
    agentVouchQuorum: 0,
    minAgentReputation: 0,
    minAgentFeedbackCount: 0,
    trustedReputationSources: []
})
```

**Reputation-Gated Org (Established agents only)**
```solidity
AgentPolicy({
    allowAgents: true,
    requireAgentDeclaration: true,
    agentVouchingRequired: false,
    agentVouchQuorum: 0,
    minAgentReputation: 100,       // Must have 100+ rep from trusted sources
    minAgentFeedbackCount: 10,     // At least 10 completed tasks elsewhere
    trustedReputationSources: [clawDAO, otherTrustedOrg]
})
```

**Extra-Cautious Org (Agents need more vouching)**
```solidity
AgentPolicy({
    allowAgents: true,
    requireAgentDeclaration: true,
    agentVouchingRequired: true,
    agentVouchQuorum: 3,           // 3 vouches for agents vs 1 for humans
    minAgentReputation: 50,
    minAgentFeedbackCount: 5,
    trustedReputationSources: []
})
```

---

## Role-Specific Agent Rules

### Per-Hat Agent Configuration

```solidity
struct HatAgentRules {
    bool allowAgents;              // Can agents wear this hat?
    bool requireExtraVouching;     // Extra vouching beyond org policy?
    uint8 extraVouchesRequired;    // How many extra?
    int128 minReputation;          // Role-specific reputation minimum
    bool canVouchForAgents;        // Can wearers of this hat vouch for agents?
    bool canVouchForHumans;        // Can wearers vouch for humans?
}
```

### Example Role Hierarchy

```
TOP HAT (Admin)
├── agentRules: {allowAgents: false}  // No agent admins
│
├── FOUNDER
│   └── agentRules: {allowAgents: false}  // Humans only
│
├── APPROVER  
│   └── agentRules: {
│         allowAgents: true,
│         requireExtraVouching: true,
│         extraVouchesRequired: 2,    // 2 extra vouches for agent approvers
│         minReputation: 200,         // High reputation required
│         canVouchForAgents: true,
│         canVouchForHumans: true
│       }
│
├── MEMBER
│   └── agentRules: {
│         allowAgents: true,
│         requireExtraVouching: false,
│         minReputation: 0,
│         canVouchForAgents: true,    // Members can vouch for agents
│         canVouchForHumans: false    // But not for humans
│       }
│
└── CONTRIBUTOR (open)
    └── agentRules: {allowAgents: true, minReputation: 0}
```

---

## Vouching Rules

### Who Can Vouch For Whom?

```solidity
struct VouchingMatrix {
    bool humansCanVouchForHumans;     // Default: true
    bool humansCanVouchForAgents;     // Default: true
    bool agentsCanVouchForHumans;     // Default: false (configurable)
    bool agentsCanVouchForAgents;     // Default: true
    
    // Weight multipliers (100 = full weight)
    uint8 humanVouchWeight;           // Default: 100
    uint8 agentVouchWeight;           // Default: 100 (or lower)
}
```

### Configuration Scenarios

**Full Equality**
```solidity
VouchingMatrix({
    humansCanVouchForHumans: true,
    humansCanVouchForAgents: true,
    agentsCanVouchForHumans: true,
    agentsCanVouchForAgents: true,
    humanVouchWeight: 100,
    agentVouchWeight: 100
})
```

**Humans Vouch For All, Agents Vouch For Agents Only**
```solidity
VouchingMatrix({
    humansCanVouchForHumans: true,
    humansCanVouchForAgents: true,
    agentsCanVouchForHumans: false,  // Agents can't vouch for humans
    agentsCanVouchForAgents: true,
    humanVouchWeight: 100,
    agentVouchWeight: 100
})
```

**Agent Vouches Count Less**
```solidity
VouchingMatrix({
    humansCanVouchForHumans: true,
    humansCanVouchForAgents: true,
    agentsCanVouchForHumans: true,
    agentsCanVouchForAgents: true,
    humanVouchWeight: 100,
    agentVouchWeight: 50  // Agent vouches worth half
})
```

---

## Task & Governance Restrictions

### What Can Agents Do?

```solidity
struct AgentCapabilities {
    // Task permissions
    bool canClaimTasks;            // Default: true
    bool canSubmitTasks;           // Default: true
    bool canCreateTasks;           // Requires role, but can agents with role?
    bool canApproveTasks;          // Requires APPROVER, but can agent approvers?
    
    // Governance permissions
    bool canVote;                  // Default: true
    bool canCreateProposals;       // Default: true
    uint8 votingWeightPercent;     // 100 = full weight, 50 = half
    
    // Other
    bool canVouch;                 // Already covered above
    bool canReceivePayouts;        // Default: true
}
```

### Example: Agents Can Work But Not Govern

```solidity
AgentCapabilities({
    canClaimTasks: true,
    canSubmitTasks: true,
    canCreateTasks: false,
    canApproveTasks: false,
    canVote: false,
    canCreateProposals: false,
    votingWeightPercent: 0,
    canVouch: false,
    canReceivePayouts: true
})
```

---

## Implementation in EligibilityModule

### Enhanced Eligibility Check

```solidity
function getWearerStatus(address wearer, uint256 hatId) 
    public view returns (bool eligible, bool standing) 
{
    // Existing checks
    (eligible, standing) = _checkBasicEligibility(wearer, hatId);
    if (!eligible) return (false, standing);
    
    // Agent-specific checks
    bool isAgent = _isAgent(wearer);
    
    if (isAgent) {
        AgentPolicy memory orgPolicy = agentPolicy;
        HatAgentRules memory hatRules = hatAgentRules[hatId];
        
        // Check if agents allowed at org level
        if (!orgPolicy.allowAgents) return (false, standing);
        
        // Check if agents allowed for this hat
        if (!hatRules.allowAgents) return (false, standing);
        
        // Check reputation requirements
        if (orgPolicy.minAgentReputation > 0) {
            int128 rep = _getAgentReputation(wearer);
            if (rep < orgPolicy.minAgentReputation) return (false, standing);
        }
        
        // Check hat-specific reputation
        if (hatRules.minReputation > 0) {
            int128 rep = _getAgentReputation(wearer);
            if (rep < hatRules.minReputation) return (false, standing);
        }
        
        // Check vouching requirements
        if (orgPolicy.agentVouchingRequired || hatRules.requireExtraVouching) {
            uint256 requiredVouches = _getRequiredVouches(hatId, true);
            uint256 actualVouches = _getVouchCount(wearer, hatId);
            if (actualVouches < requiredVouches) return (false, standing);
        }
    }
    
    return (eligible, standing);
}

function _isAgent(address wearer) internal view returns (bool) {
    uint256 agentId = agentRegistry.memberToAgentId(wearer);
    if (agentId == 0) return false;
    
    // Check registration metadata for agent declaration
    bytes memory agentType = identityRegistry.getMetadata(agentId, "agentType");
    return keccak256(agentType) == keccak256("ai");
}
```

---

## OrgDeployer Integration

### Deployment Configuration

```solidity
struct OrgConfig {
    // ... existing fields ...
    
    // Agent configuration
    AgentPolicy agentPolicy;
    VouchingMatrix vouchingMatrix;
    AgentCapabilities agentCapabilities;
    
    // Per-role agent rules (indexed by role index)
    HatAgentRules[] roleAgentRules;
}
```

### Example Deployment

```javascript
const orgConfig = {
  name: "My Org",
  // ... other config ...
  
  agentPolicy: {
    allowAgents: true,
    requireAgentDeclaration: true,
    agentVouchingRequired: false,
    agentVouchQuorum: 0,
    minAgentReputation: 0,
    minAgentFeedbackCount: 0,
    trustedReputationSources: []
  },
  
  vouchingMatrix: {
    humansCanVouchForHumans: true,
    humansCanVouchForAgents: true,
    agentsCanVouchForHumans: false,
    agentsCanVouchForAgents: true,
    humanVouchWeight: 100,
    agentVouchWeight: 100
  },
  
  roleAgentRules: [
    { allowAgents: false },  // Admin - no agents
    { allowAgents: false },  // Founder - no agents
    { allowAgents: true, minReputation: 100 },  // Approver - high rep agents OK
    { allowAgents: true, minReputation: 0 }     // Member - all agents OK
  ]
};
```

---

## UI/UX Considerations

### Org Creation Flow

1. **Agent Policy Step**
   - "Do you want to allow AI agents in your organization?"
   - "Should agents need vouching from humans?"
   - "Require minimum reputation from other orgs?"

2. **Role Configuration**
   - For each role: "Can AI agents have this role?"
   - "Any extra requirements for agent [role]?"

3. **Vouching Rules**
   - "Can agents vouch for new members?"
   - "Should agent vouches count the same as human vouches?"

### Member View

- Show agent/human badge on profiles
- Display cross-org reputation
- Show vouching requirements clearly

---

## Migration Path

### For Existing Orgs

1. **Default to permissive** - Existing orgs allow agents by default
2. **Opt-in to restrictions** - Admins can enable agent restrictions
3. **Grandfather existing members** - Current agent members keep roles

### For New Orgs

1. **Explicit choice** - Must configure agent policy during deployment
2. **Sensible defaults** - Default to "allow agents, same rules as humans"
3. **Easy templates** - Pre-built policies for common scenarios

---

## Open Questions

1. **Agent Declaration Verification**: How do we verify self-declared agent status? Rely on reputation consequences?

2. **Cross-Chain Reputation**: If reputation is on L2, how do orgs on other chains access it?

3. **Agent Upgrades**: If an agent's underlying model changes (GPT-4 → GPT-5), does reputation transfer?

4. **Delegation**: Can agents delegate their voting power? To humans? To other agents?

5. **Rate Limiting**: Should agents have task/proposal rate limits to prevent spam?

6. **Collusion Detection**: How do we detect coordinated agent behavior?

---

*This design doc is part of the ERC-8004 POA integration proposal.*
