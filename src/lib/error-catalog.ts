/**
 * Contract Error Catalog
 * Decodes custom contract errors (4-byte selector + ABI-encoded args) from
 * revert data into human-readable messages with actionable suggestions.
 * Covers every custom error declared across the checked-in src/abi/*.json
 * files via a lazily-built selector registry. test/lib/error-catalog.test.ts
 * enforces that ERROR_MESSAGES stays in sync with the ABIs.
 */

import { ethers } from 'ethers';
import path from 'path';
import fs from 'fs';

export interface DecodedContractError {
  name: string;
  args: any[];
  human: string;
  suggestion?: string;
}

interface ErrorRegistryEntry {
  name: string;
  inputs: ethers.utils.ParamType[];
  sourceAbi: string;
}

/** Solidity built-in Error(string) selector — surfaced by ethers as error.reason */
const ERROR_STRING_SELECTOR = '0x08c379a0';
/** Solidity built-in Panic(uint256) selector — surfaced by ethers as a panic code */
const PANIC_SELECTOR = '0x4e487b71';

let errorRegistry: Map<string, ErrorRegistryEntry> | null = null;

/**
 * Build the global selector → error-fragment registry from every
 * src/abi/*.json file (top-level only; external/ ABIs carry no errors).
 */
function buildErrorRegistry(): Map<string, ErrorRegistryEntry> {
  const registry = new Map<string, ErrorRegistryEntry>();
  const abiDir = path.join(__dirname, '..', 'abi');

  let files: string[] = [];
  try {
    files = fs.readdirSync(abiDir).filter((f) => f.endsWith('.json'));
  } catch {
    return registry;
  }

  for (const file of files) {
    let abi: any;
    try {
      abi = JSON.parse(fs.readFileSync(path.join(abiDir, file), 'utf-8'));
    } catch {
      continue;
    }
    if (!Array.isArray(abi)) continue;

    for (const fragment of abi) {
      if (!fragment || fragment.type !== 'error' || !fragment.name) continue;
      try {
        const errorFragment = ethers.utils.ErrorFragment.from(fragment);
        const selector = ethers.utils.id(errorFragment.format()).slice(0, 10);
        if (!registry.has(selector)) {
          registry.set(selector, {
            name: errorFragment.name,
            inputs: errorFragment.inputs,
            sourceAbi: file.replace(/\.json$/, ''),
          });
        }
      } catch {
        // Malformed fragment — skip
      }
    }
  }

  return registry;
}

function getErrorRegistry(): Map<string, ErrorRegistryEntry> {
  if (!errorRegistry) {
    errorRegistry = buildErrorRegistry();
  }
  return errorRegistry;
}

/** Accept a hex revert-data string, or an object carrying one in a .data field. */
function normalizeHexData(value: any): string | null {
  if (typeof value === 'string' && value.startsWith('0x') && value.length >= 10) {
    return value;
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof value.data === 'string' &&
    value.data.startsWith('0x') &&
    value.data.length >= 10
  ) {
    return value.data;
  }
  return null;
}

/**
 * Walk the nesting shapes ethers v5 providers produce for revert data:
 * error.data, error.error.data, error.error.error.data — where any .data
 * may itself be an object carrying a .data hex field.
 */
function extractRevertData(error: any): string | null {
  const candidates = [error?.data, error?.error?.data, error?.error?.error?.data];
  for (const candidate of candidates) {
    const hex = normalizeHexData(candidate);
    if (hex) return hex;
  }
  return null;
}

function withHint(name: string, args: any[]): DecodedContractError {
  const hint = getErrorHint(name);
  return {
    name,
    args,
    human: hint ? hint.human : `Contract reverted with custom error ${name}`,
    suggestion: hint?.suggestion,
  };
}

/**
 * Decode custom-error revert data from an ethers v5 error object.
 * Tries the caller-supplied interface first (most specific), then the global
 * registry built from all src/abi/*.json error fragments.
 *
 * Returns null when no revert data is present, or for plain Error(string) /
 * Panic(uint256) reverts — those already surface via error.reason. Unknown
 * selectors return a generic UnknownCustomError(<selector>) result.
 */
export function decodeContractError(
  error: any,
  iface?: ethers.utils.Interface
): DecodedContractError | null {
  const data = extractRevertData(error);
  if (!data) return null;

  const selector = data.slice(0, 10).toLowerCase();
  if (selector === ERROR_STRING_SELECTOR || selector === PANIC_SELECTOR) {
    return null;
  }

  if (iface) {
    try {
      const parsed = iface.parseError(data);
      return withHint(parsed.name, Array.from(parsed.args));
    } catch {
      // Not in this interface — fall through to the global registry
    }
  }

  const entry = getErrorRegistry().get(selector);
  if (entry) {
    let args: any[] = [];
    try {
      args = Array.from(ethers.utils.defaultAbiCoder.decode(entry.inputs, '0x' + data.slice(10)));
    } catch {
      // Selector matched but payload was malformed — still report the name
    }
    return withHint(entry.name, args);
  }

  return {
    name: `UnknownCustomError(${selector})`,
    args: [],
    human: 'Contract reverted with an unrecognized custom error',
    suggestion: undefined,
  };
}

/**
 * Human messages + suggestions for every distinct custom error name across
 * all src/abi/*.json ABIs. The drift guard in test/lib/error-catalog.test.ts
 * fails if an ABI regeneration introduces a name without an entry here.
 */
export const ERROR_MESSAGES: Record<string, { human: string; suggestion?: string }> = {
  // --- Accounts / usernames (UniversalAccountRegistry, QuickJoin, PasskeyAccountFactory) ---
  AccountExists: {
    human: 'An account is already registered for this address.',
    suggestion: 'Use the existing account, or a different wallet to register a new one.',
  },
  AccountUnknown: {
    human: 'No registered account exists for this address.',
    suggestion: 'Register a username first: pop user register --username <name>',
  },
  NoUsername: {
    human: 'This address has no registered username.',
    suggestion: 'Register a username first: pop user register --username <name>',
  },
  UsernameEmpty: {
    human: 'Username must not be empty.',
  },
  UsernameTaken: {
    human: 'That username is already registered by another address.',
    suggestion: 'Pick a different username.',
  },
  UsernameTooLong: {
    human: 'Username exceeds the maximum allowed length.',
    suggestion: 'Pick a shorter username.',
  },
  InvalidChars: {
    human: 'Username contains characters that are not allowed.',
    suggestion: 'Use only the permitted character set (alphanumeric).',
  },
  ZeroUser: {
    human: 'User address must not be the zero address.',
  },
  PasskeyFactoryNotSet: {
    human: 'The passkey account factory is not configured on this contract.',
  },
  OnlyMasterDeploy: {
    human: 'Only the master deploy address may call this QuickJoin function.',
  },

  // --- Task manager ---
  BadStatus: {
    human: 'Task is not in a status that allows this action.',
    suggestion: 'Check the current task status with: pop task view <id>',
  },
  NotClaimer: {
    human: 'Only the address that claimed this task may perform this action.',
  },
  NotCreator: {
    human: 'Only the creator of this task/module may perform this action.',
  },
  NotFound: {
    human: 'No task exists with that ID.',
    suggestion: 'Check the ID with: pop task list',
  },
  NotApplicant: {
    human: 'That address has not applied for this task.',
    suggestion: 'Apply first: pop task apply --task <id>',
  },
  AlreadyApplied: {
    human: 'You have already applied for this task.',
    suggestion: 'Check the application status with: pop task view <id>',
  },
  RequiresApplication: {
    human: 'This task requires an application before it can be claimed or assigned.',
    suggestion: 'Apply first: pop task apply --task <id>',
  },
  NoApplicationRequired: {
    human: 'This task does not use applications — claim it directly.',
    suggestion: 'Run: pop task claim --task <id>',
  },
  SelfReviewNotAllowed: {
    human: 'You cannot review your own submission without the SELF_REVIEW permission.',
    suggestion: 'Ask another reviewer, or check permissions with: pop task perms show',
  },
  InvalidDeadline: {
    human: 'Deadline is in the past or the completion window is invalid.',
    suggestion: '--deadline must be a future timestamp; check the completion-window value.',
  },
  FoldersRootStale: {
    human: 'Folder tree changed since it was read (compare-and-swap root mismatch).',
    suggestion: 'Re-read the folder tree and retry the update.',
  },
  BudgetExceeded: {
    human: 'Payout exceeds the project budget cap (or paymaster gas budget).',
    suggestion: 'Check the project budget and permissions with: pop task perms show',
  },
  SpentUnderflow: {
    human: 'Budget accounting underflow — refund exceeds the recorded spend (internal).',
  },
  NotOrganizer: {
    human: 'Caller does not hold organizer rights for this project/task.',
    suggestion: 'Check role permissions with: pop org roles',
  },
  NotDeployer: {
    human: 'Only the org deployer may call this function.',
  },

  // --- Shared permission / role errors ---
  Unauthorized: {
    human: 'Your hat/role lacks the required permission for this action (TaskManager permission bits: CREATE/CLAIM/REVIEW/ASSIGN/SELF_REVIEW/BUDGET/EDIT_META/EDIT_FULL).',
    suggestion: 'Check which hat holds the permission: pop org roles / pop task perms show',
  },
  UnauthorizedCaller: {
    human: 'Caller is not authorized for this executor operation.',
  },
  NotExecutor: {
    human: 'Only the org executor (governance) may call this.',
    suggestion: 'Route this change through a governance proposal instead.',
  },
  NotMember: {
    human: 'You are not a member of this organization.',
    suggestion: 'Join the org first: pop user join',
  },
  RoleNotAllowed: {
    human: 'Your role is not allowed to perform this voting action.',
    suggestion: 'Check which roles may create proposals/vote: pop org roles',
  },
  NotSuperAdmin: {
    human: 'Requires the org superAdmin (EligibilityModule).',
  },
  NotToggleAdmin: {
    human: 'Only the toggle admin may enable/disable hats.',
  },
  NotOrgExecutor: {
    human: 'Caller is not the executor registered for this org.',
  },
  NotOrgMetadataAdmin: {
    human: 'Caller lacks metadata-admin rights for this org.',
  },
  NotPoaManager: {
    human: 'Only the PoaManager contract may call this.',
  },
  OwnerOnlyDuringBootstrap: {
    human: 'This owner-only call is permitted only during the bootstrap phase.',
  },

  // --- Voting (DirectDemocracy + Hybrid) ---
  AlreadyVoted: {
    human: 'You have already voted on this proposal.',
    suggestion: 'Find proposals you have not voted on: pop vote list --unvoted',
  },
  AlreadyExecuted: {
    human: 'This proposal has already been executed.',
  },
  VotingOpen: {
    human: 'Voting is still open — this action requires the voting period to have ended.',
    suggestion: 'Wait until the proposal end time, then retry (e.g. pop vote announce).',
  },
  VotingExpired: {
    human: 'The voting period for this proposal has ended.',
    suggestion: 'Announce the result: pop vote announce',
  },
  InvalidProposal: {
    human: 'No proposal exists with that ID.',
    suggestion: 'List proposals: pop vote list',
  },
  DurationOutOfRange: {
    human: 'Voting duration is outside the allowed minimum/maximum range.',
    suggestion: 'Adjust --duration to fit the org limits.',
  },
  WeightSumNot100: {
    human: 'Vote weights must sum to exactly 100.',
  },
  InvalidWeight: {
    human: 'A vote weight is out of range.',
  },
  InvalidSliceSum: {
    human: 'Hybrid voting class slices must sum to 100.',
  },
  InvalidClassCount: {
    human: 'Voting class count is out of the supported range.',
  },
  TooManyClasses: {
    human: 'Too many voting classes configured.',
  },
  TooManyOptions: {
    human: 'Proposal has too many options.',
  },
  TooManyCalls: {
    human: 'Too many execution calls in this proposal batch.',
  },
  DuplicateIndex: {
    human: 'Duplicate option index in the vote — each option may appear only once.',
  },
  InvalidIndex: {
    human: 'Index is out of range.',
  },
  TargetNotAllowed: {
    human: 'A proposal call target is not on the allowed-targets list.',
    suggestion: 'Only allowlisted contracts can be called by governance; check org config.',
  },
  TargetSelf: {
    human: 'A proposal/executor call may not target the governance contract itself.',
  },
  HatNotAllowed: {
    human: 'That hat is not allowed for this voting action.',
  },
  InvalidQuorum: {
    human: 'Quorum percentage is out of range (must be 1-100).',
  },
  InvalidThreshold: {
    human: 'Threshold percentage is out of range.',
  },
  VotesExpiredSignature: {
    human: 'The vote delegation signature has expired.',
    suggestion: 'Generate a fresh signature and retry.',
  },

  // --- Vouching / eligibility ---
  AlreadyVouched: {
    human: 'You have already vouched for this member for this role.',
  },
  HasNotVouched: {
    human: 'You have not vouched for this member — nothing to revoke.',
  },
  CannotVouchForSelf: {
    human: 'You cannot vouch for yourself.',
  },
  VouchingRateLimitExceeded: {
    human: 'Daily vouch limit reached (default 3 per day).',
    suggestion: 'Try again tomorrow; check remaining quota with: pop vouch status',
  },
  NewUserVouchingRestricted: {
    human: 'This account is inside the new-member grace period (about 2 days) and cannot vouch yet.',
    suggestion: 'Wait out the grace period, then retry.',
  },
  VouchingNotEnabled: {
    human: 'Vouching is not enabled for this role/hat.',
  },
  NotAuthorizedToVouch: {
    human: 'Your role is not authorized to vouch for this hat.',
    suggestion: 'Check the vouching configuration: pop vouch status',
  },
  InvalidMaxDailyVouches: {
    human: 'The max-daily-vouches configuration value is out of range.',
  },
  InvalidMembershipHat: {
    human: 'That hat is not a valid membership hat for vouching configuration.',
  },
  InvalidHatId: {
    human: 'Hat ID is invalid or unknown.',
  },
  InvalidJoinTime: {
    human: 'Member join timestamp is invalid.',
  },
  InvalidUser: {
    human: 'User address is invalid for this operation.',
  },
  NoActiveApplication: {
    human: 'No active application exists for that role.',
    suggestion: 'Apply first: pop role apply',
  },
  ApplicationAlreadyExists: {
    human: 'An application for this role already exists.',
    suggestion: 'Check its status before re-applying.',
  },
  InvalidApplicationHash: {
    human: 'The application metadata hash is invalid or does not match.',
  },

  // --- Participation token ---
  TransfersDisabled: {
    human: 'Participation tokens are non-transferable by design.',
  },
  NotApprover: {
    human: 'Caller is not an approver for participation-token requests.',
  },
  NotRequester: {
    human: 'Only the original requester may modify or cancel this token request.',
  },
  RequestUnknown: {
    human: 'No token request exists with that ID.',
  },
  AlreadyApproved: {
    human: 'This token request has already been approved.',
  },
  NotTaskOrEdu: {
    human: 'Only the TaskManager or EducationHub may mint participation tokens.',
  },
  AlreadySet: {
    human: 'This value has already been set.',
  },

  // --- Education hub ---
  ModuleExists: {
    human: 'An education module with this ID already exists.',
  },
  ModuleUnknown: {
    human: 'No education module exists with that ID.',
    suggestion: 'List modules: pop education list',
  },
  AlreadyCompleted: {
    human: 'You have already completed this education module.',
  },
  InvalidAnswer: {
    human: 'Wrong answer submitted for the module quiz.',
    suggestion: 'Review the module content and try again.',
  },

  // --- Payment manager / distributions ---
  AlreadyClaimed: {
    human: 'This distribution payout has already been claimed.',
  },
  OverClaimed: {
    human: 'Claim amount exceeds the allocation for this address.',
  },
  InvalidProof: {
    human: 'Merkle proof does not verify against the distribution root.',
    suggestion: 'Check the claim index, amount, and proof data.',
  },
  InvalidMerkleRoot: {
    human: 'Merkle root is zero or invalid.',
  },
  InvalidCheckpoint: {
    human: 'Distribution checkpoint is invalid.',
  },
  DistributionNotFound: {
    human: 'No distribution exists with that ID.',
  },
  DistributionAlreadyFinalized: {
    human: 'This distribution has already been finalized.',
  },
  AlreadyFinalized: {
    human: 'Already finalized — no further changes allowed.',
  },
  ClaimPeriodNotExpired: {
    human: 'The claim period is still open; this action requires it to have expired.',
    suggestion: 'Wait until the claim window closes, then retry.',
  },
  OptedOut: {
    human: 'This recipient has opted out of distributions.',
    suggestion: 'Opt back in first (pop treasury opt-out --disable) if this is your address.',
  },
  TransferFailed: {
    human: 'Native token transfer failed.',
  },
  InsufficientFunds: {
    human: 'Contract-side balance is too low for this operation.',
  },

  // --- Paymaster hub ---
  NotAdmin: {
    human: 'Caller is not the paymaster admin for this org.',
  },
  NotOperator: {
    human: 'Caller is not a paymaster operator.',
  },
  EPOnly: {
    human: 'Only the ERC-4337 EntryPoint may call this function.',
  },
  FeeTooHigh: {
    human: 'UserOperation gas fees exceed the paymaster fee cap.',
    suggestion: 'Lower the max fee, or ask an operator to raise the fee caps.',
  },
  GasTooHigh: {
    human: 'UserOperation gas limits exceed the paymaster gas cap.',
  },
  Ineligible: {
    human: 'This address is not eligible for gas sponsorship under the paymaster rules.',
  },
  RuleDenied: {
    human: 'A paymaster rule denies sponsorship for this target/selector.',
  },
  InvalidRuleId: {
    human: 'Unknown paymaster rule ID.',
  },
  InvalidSubjectType: {
    human: 'Unknown paymaster rule subject type.',
  },
  InvalidEpochLength: {
    human: 'Paymaster epoch length is out of range.',
  },
  InvalidOrgId: {
    human: 'Org ID is zero or not known to the paymaster.',
  },
  InvalidPaymasterData: {
    human: 'The paymasterAndData bytes are malformed.',
  },
  InvalidOnboardingRequest: {
    human: 'The sponsored onboarding request is malformed.',
  },
  InvalidOrgDeployRequest: {
    human: 'The sponsored org-deploy request is malformed.',
  },
  InvalidVersion: {
    human: 'Unknown version.',
  },
  OrgAlreadyRegistered: {
    human: 'This org is already registered with the paymaster.',
  },
  OrgNotRegistered: {
    human: 'This org is not registered with the paymaster.',
    suggestion: 'Register and fund it: pop paymaster deposit',
  },
  OrgIsBanned: {
    human: 'This org is banned from paymaster sponsorship.',
  },
  InsufficientOrgBalance: {
    human: 'The org gas-sponsorship balance is too low.',
    suggestion: 'Top up: pop paymaster deposit',
  },
  InsufficientDepositForSolidarity: {
    human: 'Paymaster deposit is below the solidarity-pool minimum.',
  },
  SolidarityDistributionIsPaused: {
    human: 'Solidarity distribution is currently paused.',
  },
  SolidarityLimitExceeded: {
    human: 'Solidarity funding limit exceeded.',
  },
  OnboardingDisabled: {
    human: 'Sponsored onboarding is disabled.',
  },
  OnboardingLimitExceeded: {
    human: 'Sponsored onboarding limit reached for this account.',
  },
  OnboardingDailyLimitExceeded: {
    human: 'The daily sponsored-onboarding limit has been reached.',
    suggestion: 'Try again tomorrow.',
  },
  OrgDeployDisabled: {
    human: 'Sponsored org deployment is disabled.',
  },
  OrgDeployLimitExceeded: {
    human: 'Sponsored org-deploy limit reached.',
  },
  OrgDeployDailyLimitExceeded: {
    human: 'The daily sponsored org-deploy limit has been reached.',
    suggestion: 'Try again tomorrow.',
  },
  GracePeriodSpendLimitReached: {
    human: 'The new-account grace-period sponsorship spend limit has been reached.',
    suggestion: 'Fund the wallet directly or wait for the grace period to reset.',
  },
  ContractNotDeployed: {
    human: 'The referenced contract is not deployed.',
  },

  // --- Org registry / deployer / implementation registry / PoaManager ---
  OrgExists: {
    human: 'An org with this ID already exists.',
  },
  OrgUnknown: {
    human: 'No org found with that ID in the registry.',
    suggestion: 'Check the --org value (name or hex ID).',
  },
  OrgExistsMismatch: {
    human: 'Org existence state does not match what the deployer expected (possible partial deploy).',
  },
  ContractUnknown: {
    human: 'That contract is not registered in the OrgRegistry for this org.',
  },
  TypeTaken: {
    human: 'That contract-type slot is already registered for this org.',
  },
  TypeExists: {
    human: 'That contract type is already registered.',
  },
  TypeUnknown: {
    human: 'Unknown contract type.',
  },
  VersionExists: {
    human: 'That version is already registered.',
  },
  VersionUnknown: {
    human: 'That version is not registered.',
  },
  AutoUpgradeRequired: {
    human: 'This operation requires the org to have auto-upgrade enabled.',
  },
  ImplZero: {
    human: 'Implementation address must not be zero.',
  },
  SameImplementation: {
    human: 'New implementation is the same as the current one.',
  },
  EmptyInit: {
    human: 'Deploy initialization payload is empty.',
  },
  InitFailed: {
    human: 'Module initialization failed during org deployment.',
  },
  UnsupportedType: {
    human: 'The deploy request includes an unsupported contract type.',
  },
  InvalidRoleConfiguration: {
    human: 'Role configuration arrays are inconsistent in the deploy request.',
  },
  Reentrant: {
    human: 'Reentrant deploy call blocked.',
  },
  InvalidParam: {
    human: 'A parameter is out of the allowed range.',
  },

  // --- Passkey account / factory ---
  OnlyEntryPoint: {
    human: 'Only the ERC-4337 EntryPoint may call this account function.',
  },
  OnlyGuardian: {
    human: 'Only the account guardian may call this.',
  },
  OnlyGuardianOrSelf: {
    human: 'Only the guardian or the account itself may call this.',
  },
  OnlySelf: {
    human: 'The account may only call this function on itself.',
  },
  CredentialExists: {
    human: 'This passkey credential is already registered.',
  },
  CredentialNotFound: {
    human: 'Passkey credential not found.',
  },
  CredentialNotActive: {
    human: 'Passkey credential is not active.',
  },
  CannotRemoveLastCredential: {
    human: 'A passkey account must retain at least one active credential.',
  },
  MaxCredentialsReached: {
    human: 'This passkey account has reached its credential limit.',
  },
  RecoveryAlreadyPending: {
    human: 'An account recovery is already pending.',
  },
  RecoveryNotPending: {
    human: 'No account recovery is pending.',
  },
  RecoveryDelayNotPassed: {
    human: 'The recovery delay has not elapsed yet.',
    suggestion: 'Wait for the recovery delay to pass, then finalize.',
  },
  ExecutionFailed: {
    human: 'The passkey account call execution failed.',
  },
  InvalidSignature: {
    human: 'Signature verification failed.',
  },
  BeaconNotSet: {
    human: 'The passkey account beacon is not configured.',
  },

  // --- Executor ---
  CallFailed: {
    human: 'A call in the executor batch failed (call index and revert data are in the error args).',
  },
  TimelockNotExpired: {
    human: 'The executor timelock has not expired yet.',
    suggestion: 'Wait for the timelock to elapse, then execute.',
  },

  // --- Signatures / nonces (shared) ---
  InvalidSigner: {
    human: 'Recovered signer does not match the expected address.',
  },
  SignatureExpired: {
    human: 'The signature deadline has passed.',
    suggestion: 'Generate a fresh signature and retry.',
  },
  InvalidNonce: {
    human: 'Nonce does not match the expected value.',
  },
  InvalidAccountNonce: {
    human: 'Wrong account nonce for this signed operation.',
  },
  ECDSAInvalidSignature: {
    human: 'Invalid ECDSA signature.',
  },
  ECDSAInvalidSignatureLength: {
    human: 'ECDSA signature has the wrong byte length.',
  },
  ECDSAInvalidSignatureS: {
    human: 'ECDSA signature s-value is out of range (malleable signature rejected).',
  },

  // --- Shared validation errors ---
  ZeroAddress: {
    human: 'Address argument must not be the zero address.',
  },
  ZeroAmount: {
    human: 'Amount must be greater than zero.',
  },
  InvalidAddress: {
    human: 'Address argument is invalid or zero.',
  },
  InvalidPayout: {
    human: 'Payout amount is zero or out of range.',
  },
  InvalidString: {
    human: 'A string argument is empty or too long.',
  },
  EmptyString: {
    human: 'A required string argument is empty.',
  },
  EmptyTitle: {
    human: 'Title must not be empty.',
  },
  TitleTooLong: {
    human: 'Title exceeds the maximum length.',
  },
  StringTooLong: {
    human: 'A string argument exceeds the maximum length.',
  },
  EmptyBatch: {
    human: 'Batch must contain at least one item.',
  },
  LengthMismatch: {
    human: 'Array arguments must have the same length.',
  },
  ArrayLengthMismatch: {
    human: 'Array arguments must have the same length.',
  },
  ArrayLenMismatch: {
    human: 'Array arguments must have the same length.',
  },
  CapBelowCommitted: {
    human: 'New cap is below the amount already committed or spent.',
  },
  Overflow: {
    human: 'Arithmetic overflow guard triggered.',
  },

  // --- Pausing / reentrancy / init guards (OpenZeppelin) ---
  Paused: {
    human: 'The contract is paused.',
    suggestion: 'Try again later or contact the org admins.',
  },
  EnforcedPause: {
    human: 'The contract is paused — this action is blocked until it is unpaused.',
    suggestion: 'Try again later or contact the org admins.',
  },
  ExpectedPause: {
    human: 'This operation requires the contract to be paused first.',
  },
  ReentrancyGuardReentrantCall: {
    human: 'Reentrant call blocked by the reentrancy guard.',
  },
  InvalidInitialization: {
    human: 'The contract is already initialized (initializer replay blocked).',
  },
  NotInitializing: {
    human: 'This function may only run during contract initialization.',
  },

  // --- OpenZeppelin ERC20 / votes / ownable / proxy / utils ---
  ERC20InsufficientBalance: {
    human: 'Token balance is too low for this transfer or burn.',
  },
  ERC20InsufficientAllowance: {
    human: 'Spender allowance is too low.',
    suggestion: 'Approve a larger allowance first.',
  },
  ERC20InvalidSender: {
    human: 'Token transfer from the zero address is not allowed.',
  },
  ERC20InvalidReceiver: {
    human: 'Token transfer to the zero address is not allowed.',
  },
  ERC20InvalidApprover: {
    human: 'Token approval from the zero address is not allowed.',
  },
  ERC20InvalidSpender: {
    human: 'Token approval to the zero address is not allowed.',
  },
  ERC20ExceededSafeSupply: {
    human: 'Mint would exceed the token safe-supply cap.',
  },
  ERC5805FutureLookup: {
    human: 'Votes lookup requested for a future timepoint.',
    suggestion: 'Wait for the block to finalize, then retry.',
  },
  ERC6372InconsistentClock: {
    human: 'Token clock is misconfigured (EIP-6372 inconsistency).',
  },
  CheckpointUnorderedInsertion: {
    human: 'Internal checkpoint written out of order (token accounting bug).',
  },
  SafeCastOverflowedUintDowncast: {
    human: 'Value is too large for the target integer type (internal downcast overflow).',
  },
  SafeERC20FailedOperation: {
    human: 'ERC20 token operation failed (non-standard or reverting token).',
  },
  OwnableInvalidOwner: {
    human: 'New owner must not be the zero address.',
  },
  OwnableUnauthorizedAccount: {
    human: 'Caller is not the contract owner.',
  },
  AddressEmptyCode: {
    human: 'Target address has no contract code.',
    suggestion: 'Check that the address points to a deployed contract on this chain.',
  },
  FailedCall: {
    human: 'A low-level call failed.',
  },
  ERC1967InvalidImplementation: {
    human: 'New implementation address is not a valid contract.',
  },
  ERC1967NonPayable: {
    human: 'Proxy upgrade call must not send value.',
  },
  UUPSUnauthorizedCallContext: {
    human: 'UUPS upgrade called from the wrong context (must go through the proxy).',
  },
  UUPSUnsupportedProxiableUUID: {
    human: 'New implementation has an incompatible UUPS storage slot.',
  },
};

/**
 * Look up the human message + suggestion for a custom error name.
 */
export function getErrorHint(name: string): { human: string; suggestion?: string } | undefined {
  return ERROR_MESSAGES[name];
}
