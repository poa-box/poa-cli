import { ethers } from 'ethers';
import { requireRawUint } from '../amounts';
import { credentialIdDigest } from '../accounts/codecs';
import { getAbi } from '../contracts';
import { assertPlanScope, assertSourceBlock, PlanResult, PlanScope, requireCompleteSnapshot, SourceRef } from '../data/facts';
import { ProtocolQuery, readIndexedSingletonFacts } from '../reads/protocol';
import { decodeCanonicalCall, exactTransactionCall, ProvenanceFreshness, ProvenanceProvider, readCanonicalTransaction, requireProvenanceFreshness } from '../reads/provenance';

export interface LegacyPendingEmailCredential {
  credentialId: string; publicKeyX: string; publicKeyY: string; salt: string; accountAddress: string; username: string;
  credentialChainId?: number; registryAddress?: string; factoryAddress?: string; targetAddress?: string; orgId?: string; flow?: string;
}
export interface EmailRecoveryScope extends PlanScope {
  orgId: string; account: string; contract: string; contracts: { registry: string; factory: string };
}
export interface VerifiedPendingEmailRecovery {
  readonly legacyDigest: string; readonly source: SourceRef; readonly transactionHash: string; readonly userOpHash?: string;
  readonly originalStatus: 'succeeded' | 'failed'; readonly accountState: 'deployed' | 'undeployed';
  readonly usernameState: 'registered' | 'available'; readonly recoveryId: string;
}
export interface MigratedPendingEmailRecord {
  schemaVersion: 1; flow: 'zkemail'; credentialId: string; publicKeyX: string; publicKeyY: string; salt: string;
  accountAddress: string; username: string; credentialChainId: number; registryAddress: string; factoryAddress: string; targetAddress: string; orgId: string;
  sourceProvenance: 'verified-migration';
  /** No session initiator or local success marker is reconstructed from a receipt. */
  authorization: 'recovery-only'; activationAllowed: false;
  audit: { legacyRecordId: string; legacyDigest: string; recoveryId: string; originalTransactionHash: string; originalUserOpHash?: string };
}
const proofs = new WeakSet<object>();
const emailBinding = `query RecoverPendingEmailBinding($orgId: ID!, $block: Block_height) {
  _meta(block: $block) { block { number hash } }
  organization(id: $orgId, block: $block) { id zkEmailInvites { id } }
}`;
function address(value: string): string {
  if (!ethers.utils.isAddress(value) || BigInt(value) === 0n) throw new Error('INVALID_EMAIL_RECOVERY_ADDRESS');
  return value.toLowerCase();
}
function bytes32(value: string): string {
  if (!/^0x[\da-f]{64}$/i.test(value)) throw new Error('INVALID_EMAIL_RECOVERY_CREDENTIAL');
  return value.toLowerCase();
}
function digest(legacy: LegacyPendingEmailCredential): string {
  if (!legacy || typeof legacy.username !== 'string' || !legacy.username) throw new Error('INVALID_EMAIL_RECOVERY_CREDENTIAL');
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(JSON.stringify([
    bytes32(legacy.credentialId), bytes32(legacy.publicKeyX), bytes32(legacy.publicKeyY), requireRawUint(legacy.salt), address(legacy.accountAddress), legacy.username,
    legacy.credentialChainId ?? null, legacy.registryAddress?.toLowerCase() ?? null, legacy.factoryAddress?.toLowerCase() ?? null,
    legacy.targetAddress?.toLowerCase() ?? null, legacy.orgId?.toLowerCase() ?? null, legacy.flow ?? null,
  ])));
}
function blocked<T>(error: unknown): PlanResult<T> {
  const message = error instanceof Error ? error.message : '';
  const code = /^[A-Z][A-Z_0-9]+$/.test(message) ? message : 'EMAIL_RECOVERY_PROOF_UNAVAILABLE';
  return { status: 'blocked', codes: [code], prerequisites: [{ code }], consequences: [] };
}
function validateLegacyScope(legacy: LegacyPendingEmailCredential, scope: EmailRecoveryScope): void {
  if (address(legacy.accountAddress) !== address(scope.account)) throw new Error('EMAIL_RECOVERY_ACCOUNT_MISMATCH');
  for (const [value, expected] of [[legacy.registryAddress, scope.contracts.registry], [legacy.factoryAddress, scope.contracts.factory],
    [legacy.targetAddress, scope.contract]] as const) if (value !== undefined && address(value) !== address(expected)) throw new Error('EMAIL_RECOVERY_SOURCE_MISMATCH');
  if ((legacy.credentialChainId !== undefined && legacy.credentialChainId !== scope.chainId)
    || (legacy.orgId !== undefined && legacy.orgId.toLowerCase() !== scope.orgId.toLowerCase())
    || (legacy.flow !== undefined && legacy.flow !== 'zkemail')) throw new Error('EMAIL_RECOVERY_SOURCE_MISMATCH');
}

/** Exact original hash is mandatory: a counterfactual address/current wiring alone
 * cannot establish the organization, target or flow that started an enrollment.
 * Reads existing schema and ABI methods at explicit canonical block numbers only.
 * No proof/sign/create/send/activation callbacks exist in this API.
 */
export async function readPendingEmailRecovery(input: {
  scope: EmailRecoveryScope; legacy: LegacyPendingEmailCredential; rawCredentialBytes: string | Uint8Array;
  originalTransactionHash: string; source: SourceRef; rpcSource: SourceRef; query: ProtocolQuery;
  provider: ProvenanceProvider & Pick<ethers.providers.Provider, 'call' | 'getCode'>; freshness: ProvenanceFreshness;
}): Promise<PlanResult<VerifiedPendingEmailRecovery>> {
  try {
    const { scope, legacy, provider, source, rpcSource } = input;
    const legacyDigest = digest(legacy);
    for (const value of [scope.contract, scope.contracts.registry, scope.contracts.factory, scope.account]) address(value);
    validateLegacyScope(legacy, scope);
    if (credentialIdDigest(input.rawCredentialBytes).toLowerCase() !== bytes32(legacy.credentialId)) throw new Error('EMAIL_RECOVERY_CREDENTIAL_MISMATCH');
    assertPlanScope(source, scope); assertPlanScope(rpcSource, scope);
    requireProvenanceFreshness(source, input.freshness); requireProvenanceFreshness(rpcSource, input.freshness);
    assertSourceBlock(rpcSource.block, source.block!);
    const binding = async (at: SourceRef) => {
      const observed = await readIndexedSingletonFacts(at, input.query, emailBinding, { orgId: scope.orgId }, []);
      const data = requireCompleteSnapshot(observed, { scope, indexed: true, snapshot: 'pinned', block: at.block });
      const org = data.organization as { id?: string; zkEmailInvites?: { id?: string } } | null;
      if (org?.id?.toLowerCase() !== scope.orgId.toLowerCase() || org?.zkEmailInvites?.id?.toLowerCase() !== scope.contract.toLowerCase()) throw new Error('EMAIL_RECOVERY_ORG_BINDING_UNPROVEN');
    };
    await binding(source); // Indexed reader remains primary; failure never falls back to a scan.
    const tx = (await readCanonicalTransaction({ source: rpcSource, provider, transactionHash: input.originalTransactionHash, freshness: input.freshness })).data;
    await binding({ ...source, block: tx.inclusion });
    const call = exactTransactionCall(tx, scope.chainId);
    if (address(call.target) !== address(scope.contract) || address(call.caller) !== address(scope.account)) throw new Error('EMAIL_RECOVERY_ORIGINAL_TARGET_MISMATCH');
    const email = new ethers.utils.Interface(getAbi('ZkEmailInvites'));
    const original = decodeCanonicalCall(email, call.data);
    if (!['registerAndClaimByDomainWithPasskey', 'registerAndClaimByEmailWithPasskey'].includes(original.name)) throw new Error('EMAIL_ENROLLMENT_CALL_REQUIRED');
    const passkey = original.args.passkey;
    if (bytes32(passkey.credentialId) !== bytes32(legacy.credentialId) || bytes32(passkey.publicKeyX) !== bytes32(legacy.publicKeyX)
      || bytes32(passkey.publicKeyY) !== bytes32(legacy.publicKeyY) || passkey.salt.toString() !== requireRawUint(legacy.salt)
      || original.args.username !== legacy.username) throw new Error('EMAIL_RECOVERY_ORIGINAL_CREDENTIAL_MISMATCH');
    const read = async (abi: ethers.utils.Interface, target: string, method: string, args: unknown[], blockNumber: string) => {
      const result = await provider.call({ to: target, data: abi.encodeFunctionData(method, args) }, ethers.BigNumber.from(blockNumber).toHexString());
      const values = abi.decodeFunctionResult(method, result);
      if (abi.encodeFunctionResult(method, values).toLowerCase() !== result.toLowerCase()) throw new Error('MALFORMED_EMAIL_RECOVERY_READ');
      return values;
    };
    const currentBlock = source.block!.number;
    const historicalWiring = await Promise.all(['accountRegistry', 'universalFactory'].map(method => read(email, scope.contract, method, [], tx.inclusion.number)));
    const currentWiring = await Promise.all(['accountRegistry', 'universalFactory'].map(method => read(email, scope.contract, method, [], currentBlock)));
    for (const wiring of [historicalWiring, currentWiring]) if (address(wiring[0][0]) !== address(scope.contracts.registry)
      || address(wiring[1][0]) !== address(scope.contracts.factory)) throw new Error('EMAIL_RECOVERY_WIRING_CHANGED');
    const factory = new ethers.utils.Interface(getAbi('PasskeyAccountFactory'));
    const registry = new ethers.utils.Interface(getAbi('UniversalAccountRegistry'));
    const [derived, code, username, owner] = await Promise.all([
      read(factory, scope.contracts.factory, 'getAddress', [legacy.credentialId, legacy.publicKeyX, legacy.publicKeyY, legacy.salt], currentBlock),
      provider.getCode(scope.account, ethers.BigNumber.from(currentBlock).toHexString()),
      read(registry, scope.contracts.registry, 'getUsername', [scope.account], currentBlock),
      read(registry, scope.contracts.registry, 'getAddressOfUsername', [legacy.username], currentBlock),
    ]);
    if (address(derived[0]) !== address(scope.account)) throw new Error('EMAIL_RECOVERY_FACTORY_ACCOUNT_MISMATCH');
    if (!/^0x(?:[\da-f]{2})*$/i.test(code)) throw new Error('EMAIL_RECOVERY_CODE_UNAVAILABLE');
    const deployed = code !== '0x';
    if (deployed) {
      const [credential] = await read(new ethers.utils.Interface(getAbi('PasskeyAccount')), scope.account, 'getCredential', [legacy.credentialId], currentBlock);
      if (credential.active !== true || bytes32(credential.publicKeyX) !== bytes32(legacy.publicKeyX)
        || bytes32(credential.publicKeyY) !== bytes32(legacy.publicKeyY)) throw new Error('EMAIL_RECOVERY_CREDENTIAL_REPLACED');
    }
    const registered = username[0] === legacy.username && owner[0].toLowerCase() === scope.account.toLowerCase();
    if (!registered && (username[0] !== '' || owner[0].toLowerCase() !== ethers.constants.AddressZero)) throw new Error('EMAIL_RECOVERY_USERNAME_REPLACED');
    if (call.operationStatus === 'succeeded' && (!deployed || !registered)) throw new Error('EMAIL_RECOVERY_SUCCESS_POSTSTATE_MISMATCH');
    const [after, originalAfter] = await Promise.all([
      provider.getBlock(ethers.BigNumber.from(currentBlock).toHexString()), provider.getBlock(ethers.BigNumber.from(tx.inclusion.number).toHexString()),
    ]);
    assertSourceBlock(after ? { number: String(after.number), hash: after.hash } : undefined, source.block!);
    assertSourceBlock(originalAfter ? { number: String(originalAfter.number), hash: originalAfter.hash } : undefined, tx.inclusion);
    const recoveryId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(JSON.stringify([legacyDigest, scope.chainId, scope.orgId.toLowerCase(),
      scope.contract.toLowerCase(), scope.contracts.registry.toLowerCase(), scope.contracts.factory.toLowerCase(), tx.transactionHash])));
    const proof: VerifiedPendingEmailRecovery = Object.freeze({ legacyDigest, source: Object.freeze({ ...rpcSource, block: Object.freeze({ ...rpcSource.block! }), contracts: Object.freeze({ ...scope.contracts }) }),
      transactionHash: tx.transactionHash, ...(call.userOpHash ? { userOpHash: call.userOpHash } : {}), originalStatus: call.operationStatus,
      accountState: deployed ? 'deployed' : 'undeployed', usernameState: registered ? 'registered' : 'available', recoveryId });
    proofs.add(proof);
    return { status: 'ready', data: proof, consequences: [{ code: 'REAUTHENTICATION_REQUIRED' }, { code: 'LEGACY_RECORD_RETAINED' }] };
  } catch (error) { return blocked(error); }
}

/** Idempotent public-pointer migration only. It never activates, deletes or resumes
 * a submission. A fresh host session must authenticate the proven credential and
 * reconcile its original operation before using existing-account claim APIs.
 */
export function migratePendingEmailCredential(input: {
  scope: EmailRecoveryScope; legacy: LegacyPendingEmailCredential; legacyRecordId: string; proof: VerifiedPendingEmailRecovery;
  freshness: ProvenanceFreshness; hasUnresolvedSubmission: boolean; existing?: MigratedPendingEmailRecord;
}): PlanResult<{ record: MigratedPendingEmailRecord; alreadyMigrated: boolean; nextAction: 'reauthenticate-existing-account' | 'reauthenticate-and-claim' | 'recheck-original-setup' }> {
  try {
    const { scope, legacy, proof } = input;
    if (!proofs.has(proof) || proof.legacyDigest !== digest(legacy)) throw new Error('EMAIL_RECOVERY_PROOF_REQUIRED');
    assertPlanScope(proof.source, scope); requireProvenanceFreshness(proof.source, input.freshness);
    validateLegacyScope(legacy, scope);
    if (input.hasUnresolvedSubmission !== false) throw new Error('EMAIL_RECOVERY_SUBMISSION_UNRESOLVED');
    if (typeof input.legacyRecordId !== 'string' || !input.legacyRecordId.trim()) throw new Error('EMAIL_RECOVERY_LEGACY_ID_REQUIRED');
    const record: MigratedPendingEmailRecord = { schemaVersion: 1, flow: 'zkemail', credentialId: bytes32(legacy.credentialId),
      publicKeyX: bytes32(legacy.publicKeyX), publicKeyY: bytes32(legacy.publicKeyY), salt: requireRawUint(legacy.salt), accountAddress: address(scope.account),
      username: legacy.username, credentialChainId: scope.chainId, registryAddress: address(scope.contracts.registry), factoryAddress: address(scope.contracts.factory),
      targetAddress: address(scope.contract), orgId: scope.orgId, sourceProvenance: 'verified-migration', authorization: 'recovery-only', activationAllowed: false,
      audit: { legacyRecordId: input.legacyRecordId, legacyDigest: proof.legacyDigest, recoveryId: proof.recoveryId, originalTransactionHash: proof.transactionHash,
        ...(proof.userOpHash ? { originalUserOpHash: proof.userOpHash } : {}) } };
    if (input.existing && JSON.stringify(input.existing) !== JSON.stringify(record)) throw new Error('EMAIL_RECOVERY_MIGRATION_CONFLICT');
    return { status: 'ready', data: { record: input.existing ?? record, alreadyMigrated: !!input.existing,
      nextAction: proof.accountState === 'undeployed' ? 'recheck-original-setup' : proof.usernameState === 'registered' ? 'reauthenticate-existing-account' : 'reauthenticate-and-claim' },
      consequences: [{ code: 'LEGACY_RECORD_RETAINED' }, { code: 'REAUTHENTICATION_REQUIRED' }] };
  } catch (error) { return blocked(error); }
}

/** Safe escape from an unprovable old setup: keep it for audit, sign in with a
 * separately verified existing account and request a fresh proof for that account.
 * Unknown original sends cannot authorize a second credential or guessed activation.
 */
export function pendingEmailRestartGuidance(): {
  action: 'claim-with-existing-account'; retainLegacy: true; activationAllowed: false; createCredentialAllowed: false;
  prerequisites: readonly string[];
} {
  return { action: 'claim-with-existing-account', retainLegacy: true, activationAllowed: false, createCredentialAllowed: false,
    prerequisites: ['AUTHENTICATE_EXISTING_ACCOUNT', 'RECONCILE_ANY_ORIGINAL_SUBMISSION', 'READ_CURRENT_INVITE_STATE', 'GENERATE_FRESH_ACCOUNT_BOUND_EMAIL_PROOF'] };
}
