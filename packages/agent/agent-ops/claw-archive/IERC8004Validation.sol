// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

/**
 * @title IERC8004Validation
 * @notice Interface for ERC-8004 Validation Registry
 * @dev Enables agents to request and receive independent validation of their work
 * @custom:reference https://eips.ethereum.org/EIPS/eip-8004
 */
interface IERC8004Validation {
    
    // ============ Events ============
    
    /// @notice Emitted when a validation is requested
    event ValidationRequest(
        address indexed validatorAddress,
        uint256 indexed agentId,
        string requestURI,
        bytes32 indexed requestHash
    );
    
    /// @notice Emitted when a validator responds
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );
    
    // ============ Core Functions ============
    
    /**
     * @notice Request validation from a validator
     * @dev Must be called by the owner or operator of the agentId
     * @param validatorAddress Address of the validator contract
     * @param agentId The agent requesting validation
     * @param requestURI URI pointing to validation request data (inputs/outputs)
     * @param requestHash Keccak256 commitment to the request data
     */
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external;
    
    /**
     * @notice Submit a validation response
     * @dev Must be called by the validatorAddress from the original request
     * @param requestHash The request being responded to
     * @param response Validation result (0-100, where 0=fail, 100=pass)
     * @param responseURI URI pointing to validation evidence (optional)
     * @param responseHash Keccak256 of response content (optional for IPFS)
     * @param tag Additional categorization (optional)
     */
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;
    
    /**
     * @notice Get the Identity Registry address
     * @return The Identity Registry contract address
     */
    function getIdentityRegistry() external view returns (address);
}
