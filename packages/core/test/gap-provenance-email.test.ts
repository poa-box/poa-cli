import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { getAbi } from '../src/contracts';
import { ENTRY_POINT } from '../src/accounts/constants';
import { credentialIdDigest, derivePasskeySalt } from '../src/accounts/codecs';
import { hashUserOperationV07, packUserOperationV07 } from '../src/accounts/userop-v07';
import { USER_OPERATION_EVENTS } from '../src/execute/outcome';
import { migratePendingEmailCredential, pendingEmailRestartGuidance, readPendingEmailRecovery } from '../src/email/recovery';

const TARGET = '0x1111111111111111111111111111111111111111', REGISTRY = '0x2222222222222222222222222222222222222222';
const FACTORY = '0x3333333333333333333333333333333333333333', ACCOUNT = '0x4444444444444444444444444444444444444444';
const OTHER = '0x5555555555555555555555555555555555555555';
const TX = '0x' + 'a1'.repeat(32), HASH = '0x' + 'b2'.repeat(32), OLD_HASH = '0x' + 'c3'.repeat(32), B32 = '0x' + 'd4'.repeat(32);
const raw = '0x1234567890', credentialId = credentialIdDigest(raw);
const legacy = { credentialId, publicKeyX: B32, publicKeyY: HASH, salt: BigInt(derivePasskeySalt(credentialId)).toString(), accountAddress: ACCOUNT, username: 'alice' };
const scope = { chainId: 100, orgId: 'org-id', contract: TARGET, account: ACCOUNT, contracts: { registry: REGISTRY, factory: FACTORY } };
const source = { ...scope, endpoint: 'mock://index', method: 'org-email-binding', indexed: true, snapshot: 'pinned' as const, block: { number: '100', hash: HASH }, observedAt: 1000 };
const rpcSource = { ...source, endpoint: 'mock://rpc', method: 'bounded-email-recovery', indexed: false };
const freshness = { now: 1000, maxAgeSeconds: 0 };
const email = new ethers.utils.Interface(getAbi('ZkEmailInvites'));
const registry = new ethers.utils.Interface(getAbi('UniversalAccountRegistry'));
const factory = new ethers.utils.Interface(getAbi('PasskeyAccountFactory'));
const account = new ethers.utils.Interface(getAbi('PasskeyAccount'));
const entryPoint = new ethers.utils.Interface(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)']);
/** Finite ABI fixture, not a cryptographic email proof or a live enrollment. */
function fixture({ success = true, version = 'domain' } = {}) {
  const auth = ['0x', '0x', 0, 0, B32, B32];
  const proof = [[1, 2], [[3, 4], [5, 6]], [7, 8], B32, B32, ...(version === 'email' ? [B32] : []), B32];
  const inner = email.encodeFunctionData(version === 'email' ? 'registerAndClaimByEmailWithPasskey' : 'registerAndClaimByDomainWithPasskey',
    [[credentialId, legacy.publicKeyX, legacy.publicKeyY, legacy.salt], legacy.username, 2000, 0, auth, proof, ['9007199254740993'], []]);
  const op = { sender: ACCOUNT, nonce: '9', callData: account.encodeFunctionData('execute', [TARGET, 0, inner]),
    callGasLimit: '100000', verificationGasLimit: '100000', preVerificationGas: '50000', maxFeePerGas: '2', maxPriorityFeePerGas: '1' };
  const opHash = hashUserOperationV07(op, ENTRY_POINT, 100);
  const packed = packUserOperationV07(op);
  const tx = { hash: TX, blockNumber: 50, blockHash: OLD_HASH, from: OTHER, to: ENTRY_POINT, value: ethers.BigNumber.from(0), chainId: 100,
    data: entryPoint.encodeFunctionData('handleOps', [[packed], OTHER]) };
  const event = USER_OPERATION_EVENTS.encodeEventLog(USER_OPERATION_EVENTS.getEvent('UserOperationEvent'), [opHash, ACCOUNT, ethers.constants.AddressZero, 9, success, 1, 1]);
  const receipt = { status: 1, transactionHash: TX, blockNumber: 50, blockHash: OLD_HASH,
    logs: [{ ...event, address: ENTRY_POINT, transactionHash: TX, blockNumber: 50, blockHash: OLD_HASH, removed: false }] };
  const state = { registry: REGISTRY, historicalRegistry: REGISTRY, factory: FACTORY, derived: ACCOUNT, code: '0x6000', credentialActive: true,
    publicKeyX: B32, username: success ? 'alice' : '', owner: success ? ACCOUNT : ethers.constants.AddressZero, org: scope.orgId, target: TARGET };
  const provider = {
    getNetwork: vi.fn(async () => ({ chainId: 100 })), getTransaction: vi.fn(async () => tx), getTransactionReceipt: vi.fn(async () => receipt),
    getBlock: vi.fn(async (tag: string) => ({ number: tag === '0x32' ? 50 : 100, hash: tag === '0x32' ? OLD_HASH : HASH })),
    getCode: vi.fn(async () => state.code),
    call: vi.fn(async (request: { to: string; data: string }, tag: string) => {
      const iface = request.to === TARGET ? email : request.to === REGISTRY ? registry : request.to === FACTORY ? factory : request.to === ACCOUNT ? account : null;
      if (!iface) throw new Error('Unexpected contract read');
      const parsed = iface.parseTransaction({ data: request.data });
      const result = parsed.name === 'accountRegistry' ? [tag === '0x32' ? state.historicalRegistry : state.registry]
        : parsed.name === 'universalFactory' ? [state.factory] : parsed.name === 'getAddress' ? [state.derived]
          : parsed.name === 'getUsername' ? [state.username] : parsed.name === 'getAddressOfUsername' ? [state.owner]
            : parsed.name === 'getCredential' ? [[state.publicKeyX, legacy.publicKeyY, 1, 0, state.credentialActive]] : null;
      if (!result) throw new Error('Unexpected method');
      return iface.encodeFunctionResult(parsed.name, result);
    }),
  };
  const query = vi.fn(async (_document: string, _variables: unknown, at: typeof source) => ({
    _meta: { block: { number: Number(at.block.number), hash: at.block.hash } }, organization: { id: state.org, zkEmailInvites: { id: state.target } },
  }));
  const input = { scope, legacy, rawCredentialBytes: raw, originalTransactionHash: TX, source, rpcSource, query, provider: provider as any, freshness };
  return { input, provider, query, state, tx, receipt, op, packed, opHash, inner };
}
function ready<T>(result: { status: string; data?: T }): T { expect(result.status).toBe('ready'); return result.data!; }

describe('pending email credential provenance and safe migration', () => {
  it.each(['domain', 'email'])('recovers %s enrollment only from original exact call, current ownership and both bindings', async version => {
    const f = fixture({ version });
    const proof = ready(await readPendingEmailRecovery(f.input));
    expect(proof).toMatchObject({ originalStatus: 'succeeded', accountState: 'deployed', usernameState: 'registered', transactionHash: TX, userOpHash: f.opHash });
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls.map(call => call[2].block.number)).toEqual(['100', '50']);
    expect(f.provider.call).toHaveBeenCalledTimes(8);
    expect(new Set(f.provider.call.mock.calls.map(call => call[1]))).toEqual(new Set(['0x32', '0x64']));
    expect(Object.isFrozen(proof.source.block)).toBe(true);
  });
  it('migrates pointers idempotently, retains the original digest, and never activates or reconstructs an initiating session', async () => {
    const f = fixture(); const proof = ready(await readPendingEmailRecovery(f.input));
    const input = { scope, legacy, legacyRecordId: 'old-org-display-name', proof, freshness, hasUnresolvedSubmission: false };
    const first = ready(migratePendingEmailCredential(input));
    expect(first).toMatchObject({ alreadyMigrated: false, nextAction: 'reauthenticate-existing-account', record: { credentialChainId: 100,
      registryAddress: REGISTRY, factoryAddress: FACTORY, targetAddress: TARGET, orgId: scope.orgId, activationAllowed: false, authorization: 'recovery-only',
      audit: { legacyRecordId: 'old-org-display-name', originalTransactionHash: TX, originalUserOpHash: f.opHash } } });
    expect(first.record).not.toHaveProperty('initiator'); expect(first.record).not.toHaveProperty('confirmation');
    const second = ready(migratePendingEmailCredential({ ...input, existing: first.record }));
    expect(second.alreadyMigrated).toBe(true); expect(second.record).toBe(first.record);
    expect(legacy).not.toHaveProperty('credentialChainId');
    expect(migratePendingEmailCredential({ ...input, existing: { ...first.record, activationAllowed: true } as any }).status).toBe('blocked');
  });
  it('failed original enrollment supports authentication and a fresh existing-account claim', async () => {
    const f = fixture({ success: false }); const proof = ready(await readPendingEmailRecovery(f.input));
    expect(proof.originalStatus).toBe('failed');
    const migration = ready(migratePendingEmailCredential({ scope, legacy, legacyRecordId: 'old', proof, freshness, hasUnresolvedSubmission: false }));
    expect(migration.nextAction).toBe('reauthenticate-and-claim'); expect(migration.record.activationAllowed).toBe(false);
  });
  it.each([
    ['unknown original hash', (f: ReturnType<typeof fixture>) => f.input.originalTransactionHash = ''],
    ['wrong raw credential', f => f.input.rawCredentialBytes = '0xabcd'],
    ['wrong current org', f => f.state.org = 'another-org'],
    ['wrong module', f => f.state.target = OTHER],
    ['changed historical registry', f => f.state.historicalRegistry = OTHER],
    ['changed current registry', f => f.state.registry = OTHER],
    ['changed factory', f => f.state.factory = OTHER],
    ['counterfactual mismatch', f => f.state.derived = OTHER],
    ['credential revoked', f => f.state.credentialActive = false],
    ['credential keys replaced', f => f.state.publicKeyX = OLD_HASH],
    ['username replaced', f => f.state.username = 'bob'],
    ['username owned by another account', f => f.state.owner = OTHER],
    ['missing code after claimed success', f => f.state.code = '0x'],
    ['unknown code', f => f.state.code = 'unavailable'],
    ['failed outer receipt', f => f.receipt.status = 0],
    ['wrong chain', f => f.tx.chainId = 42161],
    ['receipt removed', f => f.receipt.logs[0].removed = true],
    ['missing operation event', f => f.receipt.logs = []],
    ['multiple operation events', f => f.receipt.logs.push(f.receipt.logs[0])],
    ['multiple operations', f => f.tx.data = entryPoint.encodeFunctionData('handleOps', [[f.packed, f.packed], OTHER])],
    ['different target call', f => {
      f.packed.callData = account.encodeFunctionData('execute', [OTHER, 0, f.inner]);
      f.tx.data = entryPoint.encodeFunctionData('handleOps', [[f.packed], OTHER]);
    }],
    ['reorg after reads', f => f.provider.getBlock.mockImplementation(async tag => ({ number: tag === '0x32' ? 50 : 100, hash: OLD_HASH }))],
  ] as const)('%s cannot migrate a legacy enrollment', async (_, mutate) => {
    const f = fixture(); mutate(f as any); expect((await readPendingEmailRecovery(f.input)).status).toBe('blocked');
  });
  it.each([
    { credentialChainId: 42161 }, { orgId: 'other' }, { targetAddress: OTHER }, { factoryAddress: OTHER }, { registryAddress: OTHER }, { flow: 'onboarding' },
    { credentialId: B32 }, { publicKeyX: OLD_HASH }, { salt: '3' }, { accountAddress: OTHER }, { username: 'mallory' },
  ])('refuses conflicting saved fields %j', async change => {
    const f = fixture(); expect((await readPendingEmailRecovery({ ...f.input, legacy: { ...legacy, ...change } })).status).toBe('blocked');
  });
  it('stale, cloned, cross-scope proofs and unresolved host submissions cannot activate or migrate', async () => {
    const f = fixture(); const proof = ready(await readPendingEmailRecovery(f.input));
    const input = { scope, legacy, legacyRecordId: 'old', proof, freshness, hasUnresolvedSubmission: false };
    for (const change of [{ freshness: { now: 1001, maxAgeSeconds: 0 } }, { hasUnresolvedSubmission: true }, { proof: { ...proof } },
      { scope: { ...scope, chainId: 42161 } }, { legacy: { ...legacy, username: 'replaced-after-observation' } }]) {
      expect(migratePendingEmailCredential({ ...input, ...change }).status).toBe('blocked');
    }
  });
  it('an unrecoverable legacy record has an existing-account restart route with no deletion, new credential or activation', () => {
    expect(pendingEmailRestartGuidance()).toEqual({ action: 'claim-with-existing-account', retainLegacy: true, activationAllowed: false, createCredentialAllowed: false,
      prerequisites: ['AUTHENTICATE_EXISTING_ACCOUNT', 'RECONCILE_ANY_ORIGINAL_SUBMISSION', 'READ_CURRENT_INVITE_STATE', 'GENERATE_FRESH_ACCOUNT_BOUND_EMAIL_PROOF'] });
  });
  it('the retired d244 record is just an unproven fixture, never deleted, activated or product-blacklisted', async () => {
    const old = { ...legacy, accountAddress: '0xd2441d12038B79CddE3765B1CCBA80368245389f' };
    const f = fixture(); const before = JSON.stringify(old);
    expect((await readPendingEmailRecovery({ ...f.input, legacy: old, scope: { ...scope, account: old.accountAddress } })).status).toBe('blocked');
    expect(JSON.stringify(old)).toBe(before);
  });
  it('an outage cannot become unregistered/undeployed evidence and does not scan history', async () => {
    const f = fixture(); f.provider.call.mockRejectedValue(new Error('offline'));
    expect((await readPendingEmailRecovery(f.input)).status).toBe('blocked');
    expect(f.provider.getTransaction).toHaveBeenCalledTimes(1); expect(f.provider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect('getLogs' in f.provider).toBe(false);
  });
});
