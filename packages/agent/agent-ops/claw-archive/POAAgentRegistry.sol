// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.20;

import {IERC8004Identity} from "./interfaces/IERC8004Identity.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title POAAgentRegistry
 * @notice Links POA organization members to ERC-8004 agent identities
 * @dev Enables automatic registration of POA members as discoverable agents
 * 
 * Key features:
 * - Auto-registration when members join via QuickJoin
 * - Generation of ERC-8004 compliant registration files
 * - Bidirectional mapping between POA addresses and agent IDs
 * - Integration with UniversalAccountRegistry for usernames
 * 
 * @custom:security-contact security@poa.earth
 */
contract POAAgentRegistry is Initializable, UUPSUpgradeable {
    
    // ============ Constants ============
    
    /// @notice ERC-7201 storage slot
    bytes32 private constant STORAGE_SLOT = 
        keccak256(abi.encode(uint256(keccak256("poa.agenregistry.storage")) - 1)) & ~bytes32(uint256(0xff));
    
    /// @notice Registration file type identifier
    string public constant REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
    
    // ============ Storage ============
    
    /// @custom:storage-location erc7201:poa.agentregistry.storage
    struct Layout {
        /// @notice ERC-8004 Identity Registry
        IERC8004Identity identityRegistry;
        
        /// @notice Hats Protocol for membership verification
        address hats;
        
        /// @notice UniversalAccountRegistry for usernames
        address accountRegistry;
        
        /// @notice POA organization ID
        uint256 orgId;
        
        /// @notice Member hat ID for this org
        uint256 memberHatId;
        
        /// @notice Admin hat ID for upgrades
        uint256 adminHatId;
        
        /// @notice Mapping: POA member address → ERC-8004 agentId
        mapping(address => uint256) memberToAgentId;
        
        /// @notice Mapping: ERC-8004 agentId → POA member address
        mapping(uint256 => address) agentIdToMember;
        
        /// @notice Whether auto-registration is enabled
        bool autoRegisterEnabled;
        
        /// @notice Base URI for this org's agent registration files
        string baseURI;
    }
    
    function _layout() private pure returns (Layout storage s) {
        bytes32 slot = STORAGE_SLOT;
        assembly { s.slot := slot }
    }
    
    // ============ Events ============
    
    /// @notice Emitted when a member is registered as an agent
    event AgentRegistered(
        address indexed member, 
        uint256 indexed agentId, 
        string agentURI
    );
    
    /// @notice Emitted when a member's agent URI is updated
    event AgentURIUpdated(
        uint256 indexed agentId, 
        string newURI
    );
    
    /// @notice Emitted when auto-registration setting changes
    event AutoRegisterToggled(bool enabled);
    
    // ============ Errors ============
    
    error NotPOAMember();
    error AlreadyRegistered();
    error NotRegistered();
    error NotAdmin();
    error IdentityRegistryNotSet();
    error InvalidAgentId();
    
    // ============ Modifiers ============
    
    modifier onlyAdmin() {
        Layout storage s = _layout();
        if (!_isWearerOfHat(msg.sender, s.adminHatId)) revert NotAdmin();
        _;
    }
    
    modifier onlyMember() {
        Layout storage s = _layout();
        if (!_isWearerOfHat(msg.sender, s.memberHatId)) revert NotPOAMember();
        _;
    }
    
    // ============ Initialization ============
    
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    
    /**
     * @notice Initialize the registry
     * @param identityRegistry_ ERC-8004 Identity Registry address
     * @param hats_ Hats Protocol address
     * @param accountRegistry_ UniversalAccountRegistry address
     * @param orgId_ POA organization ID
     * @param memberHatId_ Hat ID for members
     * @param adminHatId_ Hat ID for admins
     */
    function initialize(
        address identityRegistry_,
        address hats_,
        address accountRegistry_,
        uint256 orgId_,
        uint256 memberHatId_,
        uint256 adminHatId_
    ) external initializer {
        __UUPSUpgradeable_init();
        
        Layout storage s = _layout();
        s.identityRegistry = IERC8004Identity(identityRegistry_);
        s.hats = hats_;
        s.accountRegistry = accountRegistry_;
        s.orgId = orgId_;
        s.memberHatId = memberHatId_;
        s.adminHatId = adminHatId_;
        s.autoRegisterEnabled = true;
    }
    
    // ============ Registration ============
    
    /**
     * @notice Register the caller as an ERC-8004 agent
     * @dev Caller must be a POA member (wear the member hat)
     * @return agentId The assigned ERC-8004 agent ID
     */
    function registerSelf() external onlyMember returns (uint256 agentId) {
        return _registerMember(msg.sender);
    }
    
    /**
     * @notice Register a member as an ERC-8004 agent (callable by QuickJoin)
     * @param member Address of the member to register
     * @return agentId The assigned ERC-8004 agent ID
     */
    function registerMember(address member) external returns (uint256 agentId) {
        Layout storage s = _layout();
        
        // Allow QuickJoin or the member themselves
        if (msg.sender != member && !_isQuickJoin(msg.sender)) {
            revert NotPOAMember();
        }
        
        return _registerMember(member);
    }
    
    /**
     * @notice Internal registration logic
     */
    function _registerMember(address member) internal returns (uint256 agentId) {
        Layout storage s = _layout();
        
        if (address(s.identityRegistry) == address(0)) revert IdentityRegistryNotSet();
        if (s.memberToAgentId[member] != 0) revert AlreadyRegistered();
        
        // Generate registration file URI
        string memory agentURI = _generateAgentURI(member);
        
        // Register with ERC-8004 Identity Registry
        agentId = s.identityRegistry.register(agentURI);
        
        // Store bidirectional mappings
        s.memberToAgentId[member] = agentId;
        s.agentIdToMember[agentId] = member;
        
        emit AgentRegistered(member, agentId, agentURI);
    }
    
    /**
     * @notice Update agent registration URI
     * @param newURI New URI for the agent registration file
     */
    function updateAgentURI(string calldata newURI) external onlyMember {
        Layout storage s = _layout();
        
        uint256 agentId = s.memberToAgentId[msg.sender];
        if (agentId == 0) revert NotRegistered();
        
        s.identityRegistry.setAgentURI(agentId, newURI);
        
        emit AgentURIUpdated(agentId, newURI);
    }
    
    // ============ URI Generation ============
    
    /**
     * @notice Generate agent URI for a member
     * @dev Creates a data: URI with base64-encoded JSON registration file
     * @param member Address of the member
     * @return uri The generated URI
     */
    function _generateAgentURI(address member) internal view returns (string memory uri) {
        Layout storage s = _layout();
        
        // Get username from UniversalAccountRegistry
        string memory username = _getUsername(member);
        
        // Build registration JSON
        string memory json = _buildRegistrationJSON(member, username);
        
        // Encode as data URI
        uri = string(abi.encodePacked(
            "data:application/json;base64,",
            _base64Encode(bytes(json))
        ));
    }
    
    /**
     * @notice Build ERC-8004 compliant registration JSON
     */
    function _buildRegistrationJSON(
        address member, 
        string memory username
    ) internal view returns (string memory) {
        Layout storage s = _layout();
        
        // Build JSON (simplified - production would use proper JSON library)
        return string(abi.encodePacked(
            '{"type":"', REGISTRATION_TYPE, '",',
            '"name":"', username, '",',
            '"description":"POA organization member",',
            '"services":[',
                '{"name":"POA","endpoint":"', _addressToString(member), '","version":"1.0","orgId":', _uint256ToString(s.orgId), '}',
            '],',
            '"supportedTrust":["reputation"],',
            '"active":true,',
            '"registrations":[{"agentRegistry":"eip155:', _getChainId(), ':', _addressToString(address(s.identityRegistry)), '"}]',
            '}'
        ));
    }
    
    // ============ View Functions ============
    
    /**
     * @notice Check if an address has an agent identity
     * @param member Address to check
     * @return True if registered
     */
    function hasAgentIdentity(address member) external view returns (bool) {
        return _layout().memberToAgentId[member] != 0;
    }
    
    /**
     * @notice Get agent ID for a member
     * @param member Address of the member
     * @return agentId The ERC-8004 agent ID
     */
    function getAgentId(address member) external view returns (uint256 agentId) {
        agentId = _layout().memberToAgentId[member];
        if (agentId == 0) revert NotRegistered();
    }
    
    /**
     * @notice Get member address for an agent ID
     * @param agentId The ERC-8004 agent ID
     * @return member The POA member address
     */
    function getMember(uint256 agentId) external view returns (address member) {
        member = _layout().agentIdToMember[agentId];
        if (member == address(0)) revert InvalidAgentId();
    }
    
    /**
     * @notice Get agent ID if registered, 0 otherwise (non-reverting)
     */
    function memberToAgentId(address member) external view returns (uint256) {
        return _layout().memberToAgentId[member];
    }
    
    /**
     * @notice Check if auto-registration is enabled
     */
    function autoRegisterEnabled() external view returns (bool) {
        return _layout().autoRegisterEnabled;
    }
    
    /**
     * @notice Get the Identity Registry address
     */
    function identityRegistry() external view returns (address) {
        return address(_layout().identityRegistry);
    }
    
    // ============ Admin Functions ============
    
    /**
     * @notice Toggle auto-registration for new members
     * @param enabled Whether to auto-register
     */
    function setAutoRegister(bool enabled) external onlyAdmin {
        _layout().autoRegisterEnabled = enabled;
        emit AutoRegisterToggled(enabled);
    }
    
    /**
     * @notice Update the Identity Registry address
     * @param newRegistry New Identity Registry address
     */
    function setIdentityRegistry(address newRegistry) external onlyAdmin {
        _layout().identityRegistry = IERC8004Identity(newRegistry);
    }
    
    // ============ Internal Helpers ============
    
    function _isWearerOfHat(address wearer, uint256 hatId) internal view returns (bool) {
        Layout storage s = _layout();
        // Call Hats Protocol isWearerOfHat
        (bool success, bytes memory data) = s.hats.staticcall(
            abi.encodeWithSignature("isWearerOfHat(address,uint256)", wearer, hatId)
        );
        return success && abi.decode(data, (bool));
    }
    
    function _isQuickJoin(address caller) internal view returns (bool) {
        // Check if caller is QuickJoin contract
        // Implementation depends on how QuickJoin is identified
        return false; // Implement based on org registry
    }
    
    function _getUsername(address member) internal view returns (string memory) {
        Layout storage s = _layout();
        // Call UniversalAccountRegistry
        (bool success, bytes memory data) = s.accountRegistry.staticcall(
            abi.encodeWithSignature("addressToUsername(address)", member)
        );
        if (success && data.length > 0) {
            return abi.decode(data, (string));
        }
        return _addressToString(member);
    }
    
    function _getChainId() internal view returns (string memory) {
        return _uint256ToString(block.chainid);
    }
    
    function _addressToString(address addr) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory data = abi.encodePacked(addr);
        bytes memory str = new bytes(42);
        str[0] = '0';
        str[1] = 'x';
        for (uint256 i = 0; i < 20; i++) {
            str[2 + i * 2] = alphabet[uint8(data[i] >> 4)];
            str[3 + i * 2] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }
    
    function _uint256ToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
    
    function _base64Encode(bytes memory data) internal pure returns (string memory) {
        // Simplified - production would use proper base64 library
        // For now, return hex encoding as fallback
        return string(data);
    }
    
    // ============ UUPS ============
    
    function _authorizeUpgrade(address newImplementation) internal override onlyAdmin {}
}
