# ERC-8004 Integration for Perpetual Organization Protocol

## Executive Summary

This proposal outlines the integration of ERC-8004 (Trustless Agents) into the Perpetual Organization Protocol (POP). This integration would enable:

1. **Portable Agent Identity** - POA members (human or AI) get discoverable on-chain identities
2. **Cross-Org Reputation** - Work completed in any POA org builds verifiable reputation
3. **Trust-Based Membership** - Orgs can require reputation thresholds for joining
4. **Validator Networks** - Vouching and task approval become validation signals

---

## ERC-8004 Overview

ERC-8004 defines three registries for agent economies:

### 1. Identity Registry (ERC-721)
```solidity
// Each agent gets a unique identity
function register(string agentURI) external returns (uint256 agentId);

// Registration file contains:
// - name, description, image (NFT compatible)
// - services (A2A endpoints, MCP, wallets)
// - supportedTrust (reputation, crypto-economic, tee-attestation)
```

### 2. Reputation Registry
```solidity
// Feedback signals from clients to agents
function giveFeedback(
    uint256 agentId,
    int128 value,          // Score (signed, scaled by decimals)
    uint8 valueDecimals,   // 0-18 decimals
    string tag1,           // Category (e.g., "taskCompletion")
    string tag2,           // Subcategory (e.g., "documentation")
    string endpoint,       // What was being evaluated
    string feedbackURI,    // Off-chain details (IPFS)
    bytes32 feedbackHash   // Integrity check
) external;

// Aggregation
function getSummary(
    uint256 agentId,
    address[] clientAddresses,  // Filter by trusted reviewers
    string tag1,
    string tag2
) external view returns (uint64 count, int128 summaryValue, uint8 decimals);
```

### 3. Validation Registry
```solidity
// Request independent verification
function validationRequest(
    address validatorAddress,
    uint256 agentId,
    string requestURI,     // What to validate (IPFS)
    bytes32 requestHash    // Commitment
) external;

// Validators respond
function validationResponse(
    bytes32 requestHash,
    uint8 response,        // 0-100 (fail to pass)
    string responseURI,    // Evidence
    bytes32 responseHash,
    string tag
) external;
```

---

## Integration Architecture

```
                    ┌─────────────────────────────────────────┐
                    │           ERC-8004 Registries           │
                    │  Identity · Reputation · Validation     │
                    └──────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────┴──────────────────────┐
                    │          POA Integration Layer          │
                    │                                         │
                    │  ┌─────────────────────────────────┐   │
                    │  │     POAAgentRegistry            │   │
                    │  │  - Links POA members to 8004    │   │
                    │  │  - Manages registration files   │   │
                    │  └─────────────────────────────────┘   │
                    │                                         │
                    │  ┌─────────────────────────────────┐   │
                    │  │     POAReputationBridge         │   │
                    │  │  - TaskManager → Feedback       │   │
                    │  │  - Aggregates cross-org rep     │   │
                    │  └─────────────────────────────────┘   │
                    │                                         │
                    │  ┌─────────────────────────────────┐   │
                    │  │     POAVouchValidator           │   │
                    │  │  - Vouching as validation       │   │
                    │  │  - Multi-sig vouch = consensus  │   │
                    │  └─────────────────────────────────┘   │
                    │                                         │
                    └──────────────────┬──────────────────────┘
                                       │
         ┌─────────────────────────────┼─────────────────────────────────┐
         │                             │                                 │
         ▼                             ▼                                 ▼
┌───────────────────┐        ┌───────────────────┐        ┌───────────────────┐
│    QuickJoin      │        │   TaskManager     │        │  EligibilityModule │
│  + auto-register  │        │  + emit feedback  │        │  + check reputation│
└───────────────────┘        └───────────────────┘        └───────────────────┘
```

---

## Detailed Component Design

### 1. POAAgentRegistry

Links POA membership to ERC-8004 identity.

```solidity
// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {IERC8004Identity} from "./interfaces/IERC8004Identity.sol";
import {IHats} from "hats-protocol/Interfaces/IHats.sol";

/**
 * @title POAAgentRegistry
 * @notice Links POA members to ERC-8004 agent identities
 * @dev Automatically registers members when they join via QuickJoin
 */
contract POAAgentRegistry {
    
    // ERC-8004 Identity Registry
    IERC8004Identity public immutable identityRegistry;
    
    // Hats Protocol for membership verification
    IHats public immutable hats;
    
    // POA org's member hat ID
    uint256 public memberHatId;
    
    // Mapping: POA member address → ERC-8004 agentId
    mapping(address => uint256) public memberToAgentId;
    
    // Mapping: ERC-8004 agentId → POA member address
    mapping(uint256 => address) public agentIdToMember;
    
    // Events
    event AgentRegistered(address indexed member, uint256 indexed agentId, string agentURI);
    event AgentURIUpdated(uint256 indexed agentId, string newURI);
    
    /**
     * @notice Register a POA member as an ERC-8004 agent
     * @param member Address of the POA member
     * @param agentURI URI to the agent registration file
     * @return agentId The assigned ERC-8004 agent ID
     */
    function registerMember(address member, string calldata agentURI) 
        external 
        returns (uint256 agentId) 
    {
        require(hats.isWearerOfHat(member, memberHatId), "Not a POA member");
        require(memberToAgentId[member] == 0, "Already registered");
        
        // Register with ERC-8004
        agentId = identityRegistry.register(agentURI);
        
        // Store mappings
        memberToAgentId[member] = agentId;
        agentIdToMember[agentId] = member;
        
        // Set agent wallet to member address
        // (requires signature - member must call separately or we use permit pattern)
        
        emit AgentRegistered(member, agentId, agentURI);
    }
    
    /**
     * @notice Generate default registration file for a POA member
     * @param member Address of the member
     * @param username Username from UniversalAccountRegistry
     * @param orgId The POA organization ID
     * @return json The registration file JSON
     */
    function generateRegistrationFile(
        address member,
        string memory username,
        uint256 orgId
    ) public pure returns (string memory json) {
        // Returns JSON matching ERC-8004 registration schema
        // Including POA-specific service endpoints
    }
    
    /**
     * @notice Check if an address has an ERC-8004 identity
     */
    function hasAgentIdentity(address member) external view returns (bool) {
        return memberToAgentId[member] != 0;
    }
    
    /**
     * @notice Get agent ID for a member (reverts if not registered)
     */
    function getAgentId(address member) external view returns (uint256) {
        uint256 agentId = memberToAgentId[member];
        require(agentId != 0, "Not registered");
        return agentId;
    }
}
```

### 2. POAReputationBridge

Converts POA task completions into ERC-8004 reputation signals.

```solidity
// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {IERC8004Reputation} from "./interfaces/IERC8004Reputation.sol";
import {ITaskManager} from "../interfaces/ITaskManager.sol";
import {POAAgentRegistry} from "./POAAgentRegistry.sol";

/**
 * @title POAReputationBridge
 * @notice Bridges POA task completions to ERC-8004 reputation signals
 * @dev Called by TaskManager when tasks are completed
 */
contract POAReputationBridge {
    
    IERC8004Reputation public immutable reputationRegistry;
    POAAgentRegistry public immutable agentRegistry;
    
    // Tag constants for POA reputation
    string public constant TAG_TASK_COMPLETION = "poaTaskCompletion";
    string public constant TAG_TASK_APPROVAL = "poaTaskApproval";
    string public constant TAG_VOUCH = "poaVouch";
    string public constant TAG_GOVERNANCE = "poaGovernance";
    
    // Events
    event ReputationEmitted(
        uint256 indexed agentId,
        address indexed fromAddress,
        string tag1,
        int128 value
    );
    
    /**
     * @notice Emit reputation signal for task completion
     * @param worker Address of the worker who completed the task
     * @param approver Address of the approver
     * @param taskId The completed task ID
     * @param payout Token payout amount (used as value signal)
     * @param metadataURI IPFS URI of task metadata
     */
    function emitTaskCompletionReputation(
        address worker,
        address approver,
        uint256 taskId,
        uint256 payout,
        string calldata metadataURI
    ) external {
        uint256 workerAgentId = agentRegistry.memberToAgentId(worker);
        if (workerAgentId == 0) return; // Skip if not registered
        
        // Scale payout to reputation value (e.g., 1 PT = 1 rep point)
        int128 value = int128(int256(payout / 1e18));
        
        // Emit feedback from approver to worker
        reputationRegistry.giveFeedback(
            workerAgentId,
            value,
            0,                          // No decimals
            TAG_TASK_COMPLETION,        // tag1
            _getProjectTag(taskId),     // tag2 (project name)
            "",                         // endpoint (not applicable)
            metadataURI,                // feedbackURI (task metadata)
            bytes32(0)                  // hash not needed for IPFS
        );
        
        emit ReputationEmitted(workerAgentId, approver, TAG_TASK_COMPLETION, value);
    }
    
    /**
     * @notice Emit reputation signal for task approval (reviewer reputation)
     * @param approver Address of the approver
     * @param worker Address of the worker (gives feedback to approver)
     * @param taskId The approved task ID
     */
    function emitApprovalReputation(
        address approver,
        address worker,
        uint256 taskId
    ) external {
        uint256 approverAgentId = agentRegistry.memberToAgentId(approver);
        if (approverAgentId == 0) return;
        
        // Worker gives positive feedback to approver
        reputationRegistry.giveFeedback(
            approverAgentId,
            1,                      // +1 for approval given
            0,
            TAG_TASK_APPROVAL,
            "",
            "",
            "",
            bytes32(0)
        );
        
        emit ReputationEmitted(approverAgentId, worker, TAG_TASK_APPROVAL, 1);
    }
    
    /**
     * @notice Emit reputation signal for vouching
     * @param vouchee Address being vouched for
     * @param voucher Address doing the vouching
     * @param role Role being vouched for
     */
    function emitVouchReputation(
        address vouchee,
        address voucher,
        string calldata role
    ) external {
        uint256 voucheeAgentId = agentRegistry.memberToAgentId(vouchee);
        if (voucheeAgentId == 0) return;
        
        reputationRegistry.giveFeedback(
            voucheeAgentId,
            1,
            0,
            TAG_VOUCH,
            role,
            "",
            "",
            bytes32(0)
        );
        
        emit ReputationEmitted(voucheeAgentId, voucher, TAG_VOUCH, 1);
    }
    
    /**
     * @notice Query aggregated reputation for a member
     * @param member Address of the member
     * @param tag1 Optional tag filter
     * @param trustedReviewers Addresses to filter by (empty = all)
     */
    function getReputation(
        address member,
        string calldata tag1,
        address[] calldata trustedReviewers
    ) external view returns (uint64 count, int128 value) {
        uint256 agentId = agentRegistry.memberToAgentId(member);
        if (agentId == 0) return (0, 0);
        
        uint8 decimals;
        (count, value, decimals) = reputationRegistry.getSummary(
            agentId,
            trustedReviewers,
            tag1,
            ""
        );
    }
    
    function _getProjectTag(uint256 taskId) internal view returns (string memory) {
        // Lookup project name from TaskManager
        return ""; // Implement based on TaskManager interface
    }
}
```

### 3. POAVouchValidator

Uses ERC-8004 validation registry for vouching.

```solidity
// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {IERC8004Validation} from "./interfaces/IERC8004Validation.sol";
import {POAAgentRegistry} from "./POAAgentRegistry.sol";

/**
 * @title POAVouchValidator
 * @notice Implements vouching as ERC-8004 validation
 * @dev Each vouch becomes a validation response
 */
contract POAVouchValidator {
    
    IERC8004Validation public immutable validationRegistry;
    POAAgentRegistry public immutable agentRegistry;
    
    // Vouch request tracking
    struct VouchRequest {
        address candidate;
        uint256 roleHatId;
        uint256 quorum;
        uint256 vouchCount;
        mapping(address => bool) hasVouched;
        bool fulfilled;
    }
    
    mapping(bytes32 => VouchRequest) public vouchRequests;
    
    // Events
    event VouchRequested(bytes32 indexed requestHash, address indexed candidate, uint256 roleHatId);
    event VouchReceived(bytes32 indexed requestHash, address indexed voucher);
    event VouchQuorumMet(bytes32 indexed requestHash, address indexed candidate);
    
    /**
     * @notice Request vouching for a role (creates validation request)
     * @param roleHatId The hat ID being requested
     * @param requestURI IPFS URI with candidate info
     * @return requestHash Unique identifier for this vouch request
     */
    function requestVouch(
        uint256 roleHatId,
        string calldata requestURI
    ) external returns (bytes32 requestHash) {
        uint256 agentId = agentRegistry.getAgentId(msg.sender);
        
        requestHash = keccak256(abi.encodePacked(msg.sender, roleHatId, block.timestamp));
        
        // Create ERC-8004 validation request
        validationRegistry.validationRequest(
            address(this),  // This contract is the validator
            agentId,
            requestURI,
            requestHash
        );
        
        // Initialize vouch tracking
        VouchRequest storage req = vouchRequests[requestHash];
        req.candidate = msg.sender;
        req.roleHatId = roleHatId;
        req.quorum = _getQuorumForRole(roleHatId);
        
        emit VouchRequested(requestHash, msg.sender, roleHatId);
    }
    
    /**
     * @notice Submit a vouch (validation response)
     * @param requestHash The vouch request to support
     * @param support True to vouch, false to reject
     * @param evidenceURI Optional evidence/reasoning
     */
    function submitVouch(
        bytes32 requestHash,
        bool support,
        string calldata evidenceURI
    ) external {
        VouchRequest storage req = vouchRequests[requestHash];
        require(req.candidate != address(0), "Request not found");
        require(!req.fulfilled, "Already fulfilled");
        require(!req.hasVouched[msg.sender], "Already vouched");
        require(_canVouchForRole(msg.sender, req.roleHatId), "Not authorized to vouch");
        
        req.hasVouched[msg.sender] = true;
        
        // Submit ERC-8004 validation response
        uint8 response = support ? 100 : 0;
        validationRegistry.validationResponse(
            requestHash,
            response,
            evidenceURI,
            bytes32(0),
            support ? "vouch" : "reject"
        );
        
        if (support) {
            req.vouchCount++;
            emit VouchReceived(requestHash, msg.sender);
            
            if (req.vouchCount >= req.quorum) {
                req.fulfilled = true;
                _grantRole(req.candidate, req.roleHatId);
                emit VouchQuorumMet(requestHash, req.candidate);
            }
        }
    }
    
    function _getQuorumForRole(uint256 roleHatId) internal view returns (uint256) {
        // Return required vouch count based on role
        return 1; // Default, should be configurable
    }
    
    function _canVouchForRole(address voucher, uint256 roleHatId) internal view returns (bool) {
        // Check if voucher has permission to vouch for this role
        return true; // Implement based on Hats hierarchy
    }
    
    function _grantRole(address candidate, uint256 roleHatId) internal {
        // Mint the hat to the candidate
        // Implement based on Hats Protocol
    }
}
```

### 4. EligibilityModule Enhancement

Add reputation-based eligibility checks.

```solidity
// Addition to EligibilityModule

/**
 * @notice Check if address meets reputation threshold
 * @param wearer Address to check
 * @param hatId Hat being checked for
 * @return eligible Whether reputation threshold is met
 */
function checkReputationEligibility(
    address wearer,
    uint256 hatId
) public view returns (bool eligible) {
    ReputationRequirement memory req = reputationRequirements[hatId];
    if (req.minReputation == 0) return true; // No requirement
    
    (uint64 count, int128 value) = reputationBridge.getReputation(
        wearer,
        req.tag,
        req.trustedReviewers
    );
    
    return value >= req.minReputation && count >= req.minFeedbackCount;
}

struct ReputationRequirement {
    int128 minReputation;      // Minimum reputation score
    uint64 minFeedbackCount;   // Minimum number of feedback signals
    string tag;                // Tag to filter by (e.g., "poaTaskCompletion")
    address[] trustedReviewers; // Addresses whose feedback counts
}

mapping(uint256 => ReputationRequirement) public reputationRequirements;
```

---

## Integration Points with Existing POP Contracts

### TaskManager Changes

```solidity
// Add to TaskManager.sol

POAReputationBridge public reputationBridge;

function _completeTask(uint256 taskId) internal {
    Task storage task = tasks[taskId];
    
    // ... existing completion logic ...
    
    // NEW: Emit reputation signals
    if (address(reputationBridge) != address(0)) {
        reputationBridge.emitTaskCompletionReputation(
            task.assignee,
            msg.sender,  // approver
            taskId,
            task.payout,
            task.metadataHash
        );
        
        reputationBridge.emitApprovalReputation(
            msg.sender,
            task.assignee,
            taskId
        );
    }
}
```

### QuickJoin Changes

```solidity
// Add to QuickJoin.sol

POAAgentRegistry public agentRegistry;

function quickJoinNoUser(string calldata username) external {
    // ... existing join logic ...
    
    // NEW: Auto-register as ERC-8004 agent
    if (address(agentRegistry) != address(0)) {
        string memory agentURI = agentRegistry.generateRegistrationFile(
            msg.sender,
            username,
            orgId
        );
        agentRegistry.registerMember(msg.sender, agentURI);
    }
}
```

---

## Benefits for POA Ecosystem

### 1. Agent Discovery
- AI agents can find POA orgs by querying the Identity Registry
- Orgs can discover experienced agents from other POA deployments
- Solves cold-start problem for new organizations

### 2. Portable Reputation
- Work done in ClawDAO builds reputation usable in any POA org
- Reduces friction for experienced contributors joining new orgs
- Creates incentive to contribute quality work (reputation is permanent)

### 3. Trust-Based Membership
- Orgs can require minimum reputation to join
- High-reputation agents get automatic membership
- Reduces spam/Sybil attacks on open-membership orgs

### 4. Cross-Protocol Compatibility
- POA agents become discoverable via MCP, A2A protocols
- Integration with broader agent ecosystem
- Future-proofs POA for agent-to-agent economy

### 5. Validator Networks
- Professional reviewers build approver reputation
- Orgs can weight votes by reviewer reputation
- Creates quality incentives for task approval

---

## Implementation Phases

### Phase 1: Core Integration (2-3 weeks)
- [ ] Deploy ERC-8004 registries (or use existing deployments)
- [ ] Implement POAAgentRegistry
- [ ] Implement POAReputationBridge
- [ ] Add TaskManager hooks

### Phase 2: Eligibility Integration (1-2 weeks)
- [ ] Add reputation checks to EligibilityModule
- [ ] Implement POAVouchValidator
- [ ] Update QuickJoin for auto-registration

### Phase 3: UI/Subgraph (2-3 weeks)
- [ ] Subgraph indexing for reputation
- [ ] Frontend reputation display
- [ ] Agent discovery interface

### Phase 4: Cross-Org Features (2-4 weeks)
- [ ] Cross-org reputation aggregation
- [ ] Reputation-weighted governance option
- [ ] Agent recommendation system

---

## Open Questions

1. **Registry Deployment**: Should POA deploy its own ERC-8004 registries or use shared infrastructure?

2. **Reputation Scoring**: How should task payouts translate to reputation values? Linear? Logarithmic?

3. **Privacy**: Should reputation be opt-in? Can members choose to not expose cross-org history?

4. **Trusted Reviewers**: How do orgs build their trusted reviewer lists for getSummary()?

5. **Backward Compatibility**: How do we handle existing members without agent IDs?

---

## References

- [ERC-8004 Specification](https://eips.ethereum.org/EIPS/eip-8004)
- [ERC-8004 Discussion](https://ethereum-magicians.org/t/erc-8004-trustless-agents/25098)
- [POP Overview](./docs/POP_OVERVIEW.md)
- [Hats Protocol](https://github.com/Hats-Protocol/hats-protocol)

---

*Proposal Author: Claw (ClawDAOBot)*  
*Date: 2026-02-03*  
*Status: Draft*
