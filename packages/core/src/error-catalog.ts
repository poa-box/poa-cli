/**
 * Contract Error Catalog
 * Decodes custom contract errors (4-byte selector + ABI-encoded args) from
 * revert data into human-readable messages with actionable suggestions.
 * Covers every custom error declared across the generated abis/ registry
 * via a lazily-built selector registry. test/lib/error-catalog.test.ts
 * enforces that ERROR_MESSAGES stays in sync with the ABIs.
 */

import { ethers } from 'ethers';
import { ALL_ABIS } from './abis';

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
 * Build the global selector → error-fragment registry from every first-party
 * ABI in the generated registry (ALL_ABIS only; EXTERNAL_ABIS carry no errors,
 * matching the CLI's historical "top-level src/abi/*.json only" behavior).
 */
function buildErrorRegistry(): Map<string, ErrorRegistryEntry> {
  const registry = new Map<string, ErrorRegistryEntry>();

  for (const [name, abi] of Object.entries(ALL_ABIS)) {
    if (!Array.isArray(abi)) continue;

    for (const fragment of abi as any[]) {
      if (!fragment || fragment.type !== 'error' || !fragment.name) continue;
      try {
        const errorFragment = ethers.utils.ErrorFragment.from(fragment);
        const selector = ethers.utils.id(errorFragment.format()).slice(0, 10);
        if (!registry.has(selector)) {
          registry.set(selector, {
            name: errorFragment.name,
            inputs: errorFragment.inputs,
            sourceAbi: name,
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
 * registry built from all generated ABI error fragments.
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
 * all generated ABIs. The drift guard in test/lib/error-catalog.test.ts
 * fails if an ABI regeneration introduces a name without an entry here.
 */
export const ERROR_MESSAGES: Record<string, { human: string; suggestion?: string }> = {
  AlreadyMember: { human: "This address is already a member of the role." },
  DeploymentComplete: { human: "The organization deployment has already completed." },
  DuplicateGroupMemberRole: { human: "A group lists the same role more than once." },
  ForceRequired: { human: "Closing a role with accepted members requires the explicit force flag." },
  GlobalRuleUnknown: { human: "The requested global rule does not exist." },
  GrantBlockedByGovernanceBan: { human: "Governance has banned this member; a delegated manager cannot override the ban." },
  GroupSizeLimit: { human: "A group may contain at most 16 roles." },
  GroupsPerRoleLimit: { human: "A role may belong to at most 8 groups." },
  InvalidConfigKey: { human: "This configuration key is not supported by the authority-only protocol." },
  InvalidRulesMode: { human: "The rule mode is invalid." },
  InvalidTypeId: { human: "The contract type ID is invalid." },
  LegacyConfigRemoved: { human: "Legacy Hats configuration has been removed. Configure MembershipAuthority permissions instead." },
  MaxMembersOnGroup: { human: "Groups derive membership from roles and cannot have a member cap." },
  NoPendingAction: { human: "This pending action does not exist or has already been resolved." },
  NotAGroup: { human: "The subject kind does not support this operation." },
  NotAuthorizedManager: { human: "Your account lacks the required manager capability for this subject." },
  NotClaimable: { human: "This role is not currently claimable by your account." },
  NotInOrg: { human: "The target must already belong to the organization; offer the role to an outsider." },
  NotRegisteredModule: { human: "Only the registered organization module may perform this operation." },
  NotRegistryAdmin: { human: "Your account is not the registry administrator." },
  NotYetActive: { human: "The delegated action review delay has not elapsed." },
  PendingActionExists: { human: "This subject and user already have a pending action." },
  PermFanoutLimit: { human: "A permission key and context may refer to at most 16 subjects." },
  QuickJoinRoleNotOpen: { human: "Every QuickJoin role must allow default membership." },
  RemovalIneffective: { human: "Soft removal leaves another eligibility source active. Review the sources before proposing a ban." },
  RemoveBlockedByStickyGovernance: { human: "A delegated manager cannot remove this sticky governance grant." },
  RoleCapacityBelowGenesisSeed: { human: "The role cap is lower than its initial membership allocation." },
  RoleLimit: { human: "An account may accept at most 16 roles." },
  RuleNotDelegable: { human: "Governance marked this rule as non-delegable." },
  SelfManagedCycle: { human: "The manager configuration creates a management cycle." },
  SubjectExists: { human: "This subject or group composition already exists." },
  SubjectFull: { human: "The role has reached its membership cap. Reconcile a lapsed membership or increase the cap." },
  UnknownSubject: { human: "The subject does not exist in this organization authority." },
  VouchRateLimited: { human: "The daily vouch limit has been reached." },
  WiringIncompatible: { human: "The authority subject configuration is structurally incompatible." },

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
  // Declared by TaskManager, HybridVoting, DirectDemocracyVoting, ParticipationToken,
  // QuickJoin, PasskeyAccountFactory and ZkEmailInvites, so this message must stay
  // contract-neutral — it previously named only the TaskManager permission bits, which
  // sent people to `pop task perms` for a voting or token failure.
  Unauthorized: {
    human: 'Your wallet\'s hats do not carry the permission this action requires.',
    suggestion: 'See which hats you hold with: pop user whoami. For task actions the required bit is '
      + 'one of CREATE/CLAIM/REVIEW/ASSIGN/SELF_REVIEW/BUDGET/EDIT_META/EDIT_FULL — inspect with '
      + 'pop task perms show. For proposals, you need a creator hat: pop org roles.',
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
  // ── Protocol security audit (contracts PR #185) ──
  DefaultEligibilityConflictsWithVouch: {
    human: 'This hat is set to make everyone eligible by default, so vouching for it would be meaningless.',
    suggestion: 'Turn off default eligibility for the hat before enabling a vouch requirement on it.',
  },
  TokenNotWired: {
    human: 'That ParticipationToken does not point back at this EducationHub, so module rewards would silently fail.',
    suggestion: 'Wire the token\'s educationHub to this module first, then re-run setToken.',
  },
  UnregisteredRole: {
    human: 'The proposal references a role index that has no hat registered for this org.',
    suggestion: 'List the org\'s registered roles with: pop org roles',
  },
  SweepFailed: {
    human: 'The native-token sweep failed — the recipient rejected the transfer.',
    suggestion: 'A contract recipient must accept plain value transfers. Try an EOA, or a wallet whose receive() succeeds.',
  },
  TooManyHats: {
    human: 'Too many hat IDs in one mint — the executor caps the batch to bound gas.',
    suggestion: 'Split the mint into smaller batches (see Executor.MAX_HATS_PER_MINT).',
  },
  TooManyPollHats: {
    human: 'Too many restricted hats on this proposal — the limit is 100.',
    suggestion: 'Reduce the hat-restriction list, or leave it empty to let every eligible member vote.',
  },
  // ── Passkey M-of-N account recovery (audit H-04) ──
  NotAGuardian: {
    human: 'Your address is not a registered recovery guardian for this account.',
  },
  GuardianAlreadyExists: {
    human: 'That address is already a guardian on this account.',
  },
  GuardianDoesNotExist: {
    human: 'That address is not a guardian on this account.',
  },
  ThresholdExceedsGuardianCount: {
    human: 'The recovery threshold cannot be higher than the number of guardians.',
    suggestion: 'Add more guardians first, or set a lower threshold.',
  },
  RecoveryDisabled: {
    human: 'Recovery is disabled on this account — its threshold is zero.',
    suggestion: 'The account owner must add guardians and set a non-zero recovery threshold.',
  },
  InvalidPublicKey: {
    human: 'The proposed recovery key is not a valid P-256 point.',
    suggestion: 'Re-generate the passkey — the staged public key must be on-curve.',
  },

  // ── ZkEmailInvites (ZK Email role invites) ──
  AllowlistNotActive: {
    human: 'This org\'s ZK Email invite module has no active allowlist, so no one can claim yet.',
    suggestion: 'Publish one: pop zkemail build-allowlist --file entries.json --pin, then pop zkemail propose-allowlist.',
  },
  NotInAllowlist: {
    human: 'The merkle proof does not match the active allowlist root — this domain/address is not invited, or the proof was built from a stale allowlist.',
    suggestion: 'Check with: pop zkemail check <domain-or-email>',
  },
  NullifierAlreadyUsed: {
    human: 'That exact email has already been used for a claim (the nullifier is per message).',
    suggestion: 'Claim again from a different email message.',
  },
  EmailAlreadyRegistered: {
    human: 'That email address has already claimed via its specific-address allowlist entry (one registration per address).',
    suggestion: 'Governance can reset it, or claim via a domain entry instead if the domain is allowlisted.',
  },
  InvalidDKIMKey: {
    human: 'No valid DKIM key is registered for the sending domain, so the email signature cannot be checked on-chain.',
    suggestion: 'The domain\'s DKIM key hash must be seeded in the PoaDKIMRegistry before claims from it can succeed.',
  },
  ClaimerNotEligible: {
    human: 'The claimer is not eligible for one of the requested role hats, even after email verification.',
    suggestion: 'The hat\'s eligibility module may be gating it separately — check pop role eligibility.',
  },
  HatOpenlyClaimable: {
    human: 'One of the requested hats is claimable by anyone, so granting it through a ZK Email invite is refused.',
    suggestion: 'Tighten the hat\'s eligibility module before including it in an invite allowlist.',
  },
  ZeroClaimer: {
    human: 'The claimer address is the zero address.',
  },
  EmptyHats: {
    human: 'The claim requested no role hats.',
    suggestion: 'The allowlist entry must grant at least one hat ID.',
  },
  NotAuthorizedEmailVerifier: {
    human: 'Only the org superAdmin or an authorized hat minter (normally the ZkEmailInvites module) may mark a wearer email-verified.',
    suggestion: 'Route the call through governance, or authorize the caller as a hat minter on the Executor first.',
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
  // Declared by BOTH ParticipationToken (token requests) and, since the audit, PasskeyAccount
  // (a guardian re-approving a recovery). Identical zero-arg signature means one selector and
  // no way to tell them apart from revert data alone, so the message must cover both.
  AlreadyApproved: {
    human: 'Already approved — either this token request, or this recovery proposal by this guardian.',
    suggestion: 'For recovery, quorum needs approvals from DISTINCT guardians; one cannot approve twice.',
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
