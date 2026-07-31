// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

/**
 * @title IERC8004Reputation
 * @notice Interface for ERC-8004 Reputation Registry
 * @dev Provides feedback signals between clients and agents
 * @custom:reference https://eips.ethereum.org/EIPS/eip-8004
 */
interface IERC8004Reputation {
    
    // ============ Events ============
    
    /// @notice Emitted when new feedback is given
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    
    /// @notice Emitted when feedback is revoked
    event FeedbackRevoked(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 indexed feedbackIndex
    );
    
    /// @notice Emitted when a response is appended to feedback
    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI,
        bytes32 responseHash
    );
    
    // ============ Core Functions ============
    
    /**
     * @notice Give feedback to an agent
     * @param agentId The agent receiving feedback
     * @param value Feedback value (signed fixed-point)
     * @param valueDecimals Decimal precision (0-18)
     * @param tag1 Primary tag for categorization
     * @param tag2 Secondary tag for subcategorization
     * @param endpoint The endpoint being evaluated (optional)
     * @param feedbackURI URI to off-chain feedback details (optional)
     * @param feedbackHash Keccak256 hash of feedbackURI content (optional for IPFS)
     */
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
    
    /**
     * @notice Revoke previously given feedback
     * @param agentId The agent ID
     * @param feedbackIndex Index of feedback to revoke (1-indexed)
     */
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;
    
    /**
     * @notice Append a response to existing feedback
     * @param agentId The agent ID
     * @param clientAddress The original feedback giver
     * @param feedbackIndex The feedback index
     * @param responseURI URI to response content
     * @param responseHash Keccak256 hash of response content
     */
    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external;
    
    // ============ Read Functions ============
    
    /**
     * @notice Get aggregated reputation summary
     * @param agentId The agent ID
     * @param clientAddresses Filter by these client addresses (required for Sybil resistance)
     * @param tag1 Filter by tag1 (optional, empty = no filter)
     * @param tag2 Filter by tag2 (optional, empty = no filter)
     * @return count Number of matching feedback signals
     * @return summaryValue Aggregated value
     * @return summaryValueDecimals Decimal precision of summary
     */
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
    
    /**
     * @notice Read a specific feedback entry
     * @param agentId The agent ID
     * @param clientAddress The feedback giver
     * @param feedbackIndex The feedback index (1-indexed)
     * @return value The feedback value
     * @return valueDecimals Value decimal precision
     * @return tag1 Primary tag
     * @return tag2 Secondary tag
     * @return isRevoked Whether feedback was revoked
     */
    function readFeedback(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex
    ) external view returns (
        int128 value,
        uint8 valueDecimals,
        string memory tag1,
        string memory tag2,
        bool isRevoked
    );
    
    /**
     * @notice Read all feedback matching filters
     * @param agentId The agent ID
     * @param clientAddresses Filter by clients (empty = all)
     * @param tag1 Filter by tag1 (empty = no filter)
     * @param tag2 Filter by tag2 (empty = no filter)
     * @param includeRevoked Whether to include revoked feedback
     */
    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2,
        bool includeRevoked
    ) external view returns (
        address[] memory clients,
        uint64[] memory feedbackIndexes,
        int128[] memory values,
        uint8[] memory valueDecimals,
        string[] memory tag1s,
        string[] memory tag2s,
        bool[] memory revokedStatuses
    );
    
    /**
     * @notice Get count of responses to feedback
     * @param agentId The agent ID
     * @param clientAddress The feedback giver
     * @param feedbackIndex The feedback index
     * @param responders Filter by responder addresses (empty = all)
     * @return count Number of responses
     */
    function getResponseCount(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        address[] calldata responders
    ) external view returns (uint64 count);
    
    /**
     * @notice Get all clients who have given feedback to an agent
     * @param agentId The agent ID
     * @return Array of client addresses
     */
    function getClients(uint256 agentId) external view returns (address[] memory);
    
    /**
     * @notice Get the last feedback index for a client-agent pair
     * @param agentId The agent ID
     * @param clientAddress The client address
     * @return The last feedback index (0 if none)
     */
    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);
    
    /**
     * @notice Get the Identity Registry address
     * @return The Identity Registry contract address
     */
    function getIdentityRegistry() external view returns (address);
}
