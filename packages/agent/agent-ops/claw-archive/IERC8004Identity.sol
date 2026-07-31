// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

/**
 * @title IERC8004Identity
 * @notice Interface for ERC-8004 Identity Registry
 * @dev Based on ERC-721 with URIStorage extension for agent registration
 * @custom:reference https://eips.ethereum.org/EIPS/eip-8004
 */
interface IERC8004Identity {
    
    // ============ Events ============
    
    /// @notice Emitted when a new agent is registered
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    
    /// @notice Emitted when an agent's URI is updated
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    
    /// @notice Emitted when metadata is set for an agent
    event MetadataSet(
        uint256 indexed agentId, 
        string indexed indexedMetadataKey, 
        string metadataKey, 
        bytes metadataValue
    );
    
    // ============ Structs ============
    
    /// @notice Metadata entry for batch registration
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }
    
    // ============ Registration ============
    
    /**
     * @notice Register a new agent with URI and metadata
     * @param agentURI URI pointing to the agent registration file
     * @param metadata Array of metadata entries to set
     * @return agentId The assigned agent ID (ERC-721 tokenId)
     */
    function register(string calldata agentURI, MetadataEntry[] calldata metadata) 
        external 
        returns (uint256 agentId);
    
    /**
     * @notice Register a new agent with URI only
     * @param agentURI URI pointing to the agent registration file
     * @return agentId The assigned agent ID
     */
    function register(string calldata agentURI) external returns (uint256 agentId);
    
    /**
     * @notice Register a new agent (URI added later)
     * @return agentId The assigned agent ID
     */
    function register() external returns (uint256 agentId);
    
    // ============ URI Management ============
    
    /**
     * @notice Update an agent's URI
     * @param agentId The agent ID to update
     * @param newURI The new URI
     */
    function setAgentURI(uint256 agentId, string calldata newURI) external;
    
    /**
     * @notice Get an agent's URI (ERC-721 tokenURI)
     * @param agentId The agent ID
     * @return The agent URI
     */
    function tokenURI(uint256 agentId) external view returns (string memory);
    
    // ============ Metadata ============
    
    /**
     * @notice Get metadata for an agent
     * @param agentId The agent ID
     * @param metadataKey The metadata key
     * @return The metadata value
     */
    function getMetadata(uint256 agentId, string memory metadataKey) 
        external 
        view 
        returns (bytes memory);
    
    /**
     * @notice Set metadata for an agent
     * @param agentId The agent ID
     * @param metadataKey The metadata key
     * @param metadataValue The metadata value
     */
    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) 
        external;
    
    // ============ Agent Wallet ============
    
    /**
     * @notice Set the agent's wallet address (requires signature proof)
     * @param agentId The agent ID
     * @param newWallet The new wallet address
     * @param deadline Signature deadline
     * @param signature EIP-712 or ERC-1271 signature
     */
    function setAgentWallet(
        uint256 agentId, 
        address newWallet, 
        uint256 deadline, 
        bytes calldata signature
    ) external;
    
    /**
     * @notice Get the agent's wallet address
     * @param agentId The agent ID
     * @return The wallet address (or owner if not set)
     */
    function getAgentWallet(uint256 agentId) external view returns (address);
    
    /**
     * @notice Unset the agent's wallet address
     * @param agentId The agent ID
     */
    function unsetAgentWallet(uint256 agentId) external;
    
    // ============ ERC-721 Standard ============
    
    function ownerOf(uint256 tokenId) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function approve(address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}
