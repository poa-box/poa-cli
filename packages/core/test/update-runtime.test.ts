import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { buildSchema, parse, visit, validate } from 'graphql';
import { encodeSponsorshipPayload, parseSponsorshipPayload, paymasterSubjectKey, subjectIdBytes32, SUBJECT_TYPE, ZERO_SUBJECT } from '../src/sponsorship/codec';
import { requiredPrefundV07, remainingBudget } from '../src/sponsorship/budget';
import { packUserOperationV07, hashUserOperationV07, UserOperationV07 } from '../src/accounts/userop-v07';
import { REGISTER_ACCOUNT_TYPES, REGISTER_PASSKEY_ACCOUNT_TYPES, registrationDomain, registrationChallenge, credentialIdDigest, derivePasskeySalt, packPasskeySignature, unpackPasskeySignature } from '../src/accounts/codecs';
import { USER_OPERATION_EVENTS, decodeUserOperationOutcome } from '../src/execute/outcome';
import { detectUserOpFailure, executeContractTx, classifyError } from '../src/execute/ethers';
import { SponsoredSubmissionError, SponsoredSubmission } from '../src/sponsorship-config';
import { encodePaymasterData, getUserOpHash, sendSponsored, reconcileSponsoredSubmission } from '../src/execute/sponsored';
import { hatSubjectKey } from '../src/reads/paymaster';
import { buildRegisterCalldata, DEPLOY_CONFIG_TUPLE } from '../src/tx/paymaster';
import { encodeIntent, intentToContractCall, intentToExecutionRequest, executeIntentWithHost, TxIntent } from '../src/tx/intent';
import { decodeContractError, getErrorHint } from '../src/error-catalog';
import { extractRevertEvidence, decodeRevertTree } from '../src/errors/envelope';
import { HISTORICAL_EXTERNAL_ERROR_NAMES, historicalExternalErrorInterface } from '../src/errors/compat';
import { FETCH_ACCOUNT_FACTS, FETCH_CREDENTIAL_PAGE, FETCH_CREDENTIAL_PAGE_LEGACY, FETCH_FACTORY_FACTS, FETCH_SOLIDARITY_STATE } from '../src/graph/documents/accounts';
import { FETCH_PROTOCOL_OVERVIEW, FETCH_PROTOCOL_ORGS_PAGE, FETCH_BEACON_EVENTS_PAGE, FETCH_SOLIDARITY_EVENTS_PAGE } from '../src/graph/documents/protocol';
import { FETCH_PAYMASTER_DEPOSITS_PAGE, FETCH_PAYMASTER_USAGE_PAGE } from '../src/graph/documents/paymaster';
import { readAccountFacts, readCredentialFacts, readFactoryFacts, readSolidarityFacts, readPaymasterHistoryFacts, readIndexedPageFacts, readProtocolOverviewFacts, readProtocolOrgFacts, readProtocolEventFacts, projectCredentialFacts, projectProtocolFacts, sumIndexedOrgGasFacts, IndexedRow } from '../src/reads/protocol';
import { knownFact, SourceRef, SourceSnapshot } from '../src/data/facts';

// Entire optional execution stack is mocked. No real signing, network, uploads or provider.
const transport = vi.hoisted(() => ({ mode: 'ok', sendCount: 0, waitCount: 0, operation: undefined as any, signCount: 0 }));
vi.mock('viem', async importOriginal => ({ ...await importOriginal<typeof import('viem')>(),
  createPublicClient: () => ({ getCode: async () => '0xef0100', readContract: async () => 9n }),
  createWalletClient: () => ({ signAuthorization: async () => ({}), signMessage: async () => { transport.signCount++; return '0x' + '11'.repeat(65); } }),
}));
vi.mock('viem/accounts', () => ({ privateKeyToAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }) }));
vi.mock('permissionless/clients/pimlico', () => ({ createPimlicoClient: () => ({
  getUserOperationGasPrice: async () => ({ fast: { maxFeePerGas: 17n, maxPriorityFeePerGas: 3n } }),
  estimateUserOperationGas: async () => ({ callGasLimit: 123456n, preVerificationGas: 45000n, verificationGasLimit: 500000n, paymasterVerificationGasLimit: 20000n, paymasterPostOpGasLimit: 10000n }),
  sendUserOperation: async (op: any) => {
    transport.sendCount++; transport.operation = op;
    if (transport.mode === 'lost') throw new Error('Response lost after dispatch');
    if (transport.mode === 'ambiguous') return undefined;
    if (transport.mode === 'mismatch') return H2;
    return hashUserOperationV07(op, EP, 100);
  },
  waitForUserOperationReceipt: async () => { transport.waitCount++; if (transport.mode === 'timeout') throw new Error('Timeout'); return { receipt: { transactionHash: TX } }; },
}) }));
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const H1 = ('0x' + '11'.repeat(32)) as `0x${string}`, H2 = ('0x' + '22'.repeat(32)) as `0x${string}`, TX = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const ORG = '0x' + 'a1'.repeat(32), LARGE = (1n << 224n) + 19n;
const uint32 = (1n << 32n) - 1n, uint64 = (1n << 64n) - 1n;
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures/core-update/runtime', name), 'utf8'));
const op: UserOperationV07 = { sender: A, nonce: '9', callData: '0x1234', verificationGasLimit: '500000', callGasLimit: '123456', preVerificationGas: '45000', maxFeePerGas: '17', maxPriorityFeePerGas: '3', paymaster: B, paymasterVerificationGasLimit: '20000', paymasterPostOpGasLimit: '10000', paymasterData: encodeSponsorshipPayload({ orgId: ORG, subjectType: 1, subjectId: LARGE }) };
function event(hash: string, success: boolean, address = EP, nonce = 9, sender = A) {
  return { address, ...USER_OPERATION_EVENTS.encodeEventLog(USER_OPERATION_EVENTS.getEvent('UserOperationEvent'), [hash, sender, B, nonce, success, 17, 3]) };
}
function reason(hash: string, data: string, address = EP, nonce = 9, sender = A) {
  return { address, ...USER_OPERATION_EVENTS.encodeEventLog(USER_OPERATION_EVENTS.getEvent('UserOperationRevertReason'), [hash, sender, nonce, data]) };
}
const receipt = (logs: any[], status = 1): any => ({ status, logs, transactionHash: TX, blockNumber: 3, gasUsed: ethers.BigNumber.from(10) });
const stringRevert = (message: string) => '0x08c379a0' + ethers.utils.defaultAbiCoder.encode(['string'], [message]).slice(2);
const custom = new ethers.utils.Interface(['error CallFailed(uint256 index, bytes reason)', 'error NotCreator()']);
const source = (overrides: Partial<SourceRef> = {}): SourceRef => ({ chainId: 100, endpoint: 'fixture://gnosis', method: 'ProtocolOverview', indexed: true, snapshot: 'latest', contract: B, contracts: { manager: A, registry: C, accountRegistry: C, hub: B }, ...overrides });
const snapshot = <T>(data: T, src = source()): SourceSnapshot<T> => ({ source: src, data, coverage: { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] } });
beforeEach(() => { transport.mode = 'ok'; transport.sendCount = 0; transport.waitCount = 0; transport.signCount = 0; transport.operation = undefined; });

describe('EXEC-OP-IDENTITY operation-specific evidence', () => {
  for (const success of [true, false]) for (const reversed of [false, true]) {
    it(`mixed bundle target=${success} reversed=${reversed}`, () => {
      let logs = [event(H1, !success), event(H2, success)]; if (reversed) logs.reverse();
      expect(decodeUserOperationOutcome(receipt(logs), { userOpHash: H2, entryPoint: EP }).status).toBe(success ? 'succeeded' : 'failed');
      const result = detectUserOpFailure(receipt(logs), TX, 100, undefined, { userOpHash: H2, entryPoint: EP });
      expect(result === null).toBe(success);
    });
  }
  it('ignores unrelated hashes, emitters, sender and nonce in reasons', () => {
    const logs = [event(H2, false), reason(H1, stringRevert('wrong hash')), reason(H2, stringRevert('wrong emitter'), C), reason(H2, stringRevert('wrong sender'), EP, 9, C), reason(H2, stringRevert('wrong nonce'), EP, 10), reason(H2, stringRevert('target'))];
    expect(decodeUserOperationOutcome(receipt(logs), { userOpHash: H2, entryPoint: EP }).revertReason).toBe(stringRevert('target'));
    expect(detectUserOpFailure(receipt(logs), TX, 100, undefined, { userOpHash: H2, entryPoint: EP })?.error).toContain('target');
  });
  for (const [name, logs] of [['missing', []], ['wrong emitter', [event(H2, true, C)]], ['malformed', [{ ...event(H2, true), data: '0x' }]], ['conflict', [event(H2, true), event(H2, false)]]] as const) {
    it(`${name} target remains unknown`, () => expect(decodeUserOperationOutcome(receipt([...logs]), { userOpHash: H2, entryPoint: EP }).status).toBe('unknown'));
  }
  it('checks supplied sender/nonce and does not trust noncanonical bool or surplus bytes', () => {
    expect(decodeUserOperationOutcome(receipt([event(H2, true)]), { userOpHash: H2, entryPoint: EP, nonce: '10' }).status).toBe('unknown');
    expect(decodeUserOperationOutcome(receipt([event(H2, true)]), { userOpHash: H2, entryPoint: EP, sender: C }).status).toBe('unknown');
    const e = event(H2, true); const bytes = ethers.utils.arrayify(e.data); bytes[63] = 2;
    expect(decodeUserOperationOutcome(receipt([{ ...e, data: ethers.utils.hexlify(bytes) }]), { userOpHash: H2, entryPoint: EP }).status).toBe('unknown');
    expect(decodeUserOperationOutcome(receipt([{ ...e, data: e.data + '00' }]), { userOpHash: H2, entryPoint: EP }).status).toBe('unknown');
  });
  it('null receipt unknown; outer revert failed; old detector signature retained', () => {
    expect(decodeUserOperationOutcome(null, { userOpHash: H2, entryPoint: EP }).status).toBe('unknown');
    expect(decodeUserOperationOutcome(receipt([], 0), { userOpHash: H2, entryPoint: EP }).status).toBe('failed');
    expect(detectUserOpFailure(receipt([event(H2, false)]), TX, 100)?.errorCode).toBe('TX_REVERTED');
  });
});

describe('ROOT-RUNTIME-RECEIPT-STATUS outer evidence cannot manufacture inner success', () => {
  for (const status of [0, 0n, '0', '00', '0x0', '0x00', '0X00']) it(`outer zero ${typeof status}:${status} overrides a matching success event`, () => {
    expect(decodeUserOperationOutcome({ status, logs: [event(H2, true)] }, { userOpHash: H2, entryPoint: EP })).toMatchObject({ status: 'failed', code: 'OUTER_REVERTED' });
  });
  for (const status of [1, 1n, '1', '01', '0x1', '0x01', '0X01']) it(`outer one ${typeof status}:${status} still requires the target event`, () => {
    expect(decodeUserOperationOutcome({ status, logs: [event(H2, true)] }, { userOpHash: H2, entryPoint: EP }).status).toBe('succeeded');
    expect(decodeUserOperationOutcome({ status, logs: [event(H2, false)] }, { userOpHash: H2, entryPoint: EP }).status).toBe('failed');
    expect(decodeUserOperationOutcome({ status, logs: [event(H1, true)] }, { userOpHash: H2, entryPoint: EP }).status).toBe('unknown');
  });
  for (const status of ['garbage', '2', '0x2', '', '0x', '-0', '-1', '+1', ' 1', '1 ', '1.0', '1e0', 2, -1, 1.5, NaN, Infinity, 2n, null, true]) it(`invalid status ${typeof status}:${status} remains unknown despite success logs`, () => {
    expect(decodeUserOperationOutcome({ status, logs: [event(H2, true)] } as any, { userOpHash: H2, entryPoint: EP })).toMatchObject({ status: 'unknown', code: 'INVALID_RECEIPT_STATUS' });
  });
  it('absent status preserves logs-only semantics without proving outer success', () => {
    expect(decodeUserOperationOutcome({ logs: [event(H2, true)] }, { userOpHash: H2, entryPoint: EP }).status).toBe('succeeded');
    expect(decodeUserOperationOutcome({ logs: [] }, { userOpHash: H2, entryPoint: EP }).status).toBe('unknown');
  });
  for (const status of ['0', 'garbage', '2']) it(`sponsored executor status ${status} cannot fall back or report success`, async () => {
    const { contract, direct } = mockContract(async () => ({ ...receipt([event(H2, true, EP, 9, new ethers.Wallet(H1).address)]), status }));
    const send = vi.fn(async () => ({ txHash: TX, userOpHash: H2 }));
    const result = await executeContractTx(contract, 'action', [], { sponsored: config, sponsoredAdapter: adapter(send) });
    expect(result.success).toBe(false); expect(result.outcome?.status).toBe(status === '0' ? 'failed' : 'unknown');
    expect(send).toHaveBeenCalledTimes(1); expect(direct).not.toHaveBeenCalled();
  });
});

function mockContract(readReceipt: () => Promise<any> = async () => receipt([event(H2, true, EP, 9, new ethers.Wallet(H1).address)])) {
  const direct = vi.fn(async () => ({ wait: async () => receipt([]) }));
  return { contract: { address: A, interface: new ethers.utils.Interface(['function action()']), signer: { getAddress: async () => new ethers.Wallet(H1).address }, provider: { getNetwork: async () => ({ chainId: 100 }), getTransactionReceipt: readReceipt }, estimateGas: { action: async () => ethers.BigNumber.from(100) }, action: direct } as unknown as ethers.Contract, direct };
}
const config = { privateKey: H1 as `0x${string}`, orgId: ORG as `0x${string}`, hatId: 1n };
function adapter(send: (options?: any) => Promise<any>, delegated = true) {
  return { entryPoint: EP as `0x${string}`, isDelegated: async () => delegated, sendSponsored: async (_key: any, _to: any, _data: any, _org: any, _hat: any, options?: any) => send(options) };
}
describe('EXEC-UNCERTAIN-RETRY zero duplicate sends', () => {
  for (const mode of ['timeout', 'lost', 'ambiguous']) it(`real optional orchestration ${mode} retains identity and does not repeat submit`, async () => {
    transport.mode = mode; const observed: SponsoredSubmission[] = [];
    let failure: any;
    try { await sendSponsored(H1 as any, A, '0x1234', ORG as any, 1n, { bundlerUrl: 'https://fixture.invalid', onSubmitted: s => { observed.push(s); } }); } catch (e) { failure = e; }
    expect(failure).toBeInstanceOf(SponsoredSubmissionError);
    expect(failure.submission.computedHash).toMatch(/^0x[\da-f]{64}$/i);
    expect(failure.submission.phase).toBe(mode === 'timeout' ? 'receipt' : 'submitting');
    expect(transport.sendCount).toBe(1); expect(transport.waitCount).toBe(mode === 'timeout' ? 1 : 0);
    expect(observed.length).toBe(mode === 'timeout' ? 1 : 0);
  });
  it('callback failure after acceptance never waits or falls back', async () => {
    const { contract, direct } = mockContract();
    const result = await executeContractTx(contract, 'action', [], { sponsored: config, sponsoredSend: { onSubmitted: () => { throw new Error('storage failed'); } }, sponsoredAdapter: adapter(async opts => {
      await opts.onSubmitted({ phase: 'submitted', userOpHash: H2, computedHash: H2, entryPoint: EP, chainId: 100 }); return { txHash: TX, userOpHash: H2 };
    }) });
    expect(direct).not.toHaveBeenCalled(); expect(result.outcome?.status).toBe('unknown'); expect(result.userOpHash).toBe(H2);
  });
  it('actual send callback failure is submitted evidence and sends only once', async () => {
    await expect(sendSponsored(H1 as any, A, '0x', ORG as any, 1n, { bundlerUrl: 'https://fixture.invalid', onSubmitted: () => { throw new Error('storage'); } })).rejects.toMatchObject({ submission: { phase: 'submitted' } });
    expect(transport.sendCount).toBe(1); expect(transport.waitCount).toBe(0);
  });
  for (const mode of ['accepted-timeout', 'lost-response', 'ambiguous-response', 'receipt-rpc-failure', 'mined-failure', 'missing-event', 'missing-receipt']) it(`${mode} causes zero direct sends`, async () => {
    const { contract, direct } = mockContract(async () => {
      if (mode === 'receipt-rpc-failure') throw new Error('receipt RPC');
      if (mode === 'missing-receipt') return null;
      return receipt(mode === 'missing-event' ? [] : [event(H2, mode !== 'mined-failure', EP, 9, new ethers.Wallet(H1).address)]);
    });
    const send = vi.fn(async () => {
      if (mode === 'accepted-timeout') throw new SponsoredSubmissionError('timeout', { phase: 'receipt', userOpHash: H2 as any, entryPoint: EP, chainId: 100 });
      if (mode === 'lost-response') throw new Error('lost after dispatch');
      if (mode === 'ambiguous-response') return {};
      return { txHash: TX, userOpHash: H2 };
    });
    const result = await executeContractTx(contract, 'action', [], { sponsored: config, sponsoredAdapter: adapter(send) });
    expect(send).toHaveBeenCalledTimes(1); expect(direct).not.toHaveBeenCalled(); expect(result.success).toBe(false);
    expect(result.outcome?.status).toBe(mode === 'mined-failure' ? 'failed' : 'unknown');
  });
  for (const mode of ['not-delegated', 'established-pre-submit']) it(`${mode} permits exactly one direct fallback`, async () => {
    const { contract, direct } = mockContract(); const send = vi.fn(async () => { throw new SponsoredSubmissionError('unavailable', { phase: 'pre-submit', entryPoint: EP, chainId: 100 }); });
    const result = await executeContractTx(contract, 'action', [], { sponsored: config, sponsoredAdapter: adapter(send, mode !== 'not-delegated') });
    expect(direct).toHaveBeenCalledTimes(1); expect(result.success).toBe(true); expect(send.mock.calls.length).toBe(mode === 'not-delegated' ? 0 : 1);
  });
  it('mined success preserves raw receipt and one operation identity', async () => {
    const r = receipt([event(H1, false, EP, 9, new ethers.Wallet(H1).address), event(H2, true, EP, 9, new ethers.Wallet(H1).address)]); const { contract, direct } = mockContract(async () => r);
    const result = await executeContractTx(contract, 'action', [], { sponsored: config, sponsoredAdapter: adapter(async () => ({ txHash: TX, userOpHash: H2 })) });
    expect(result.success).toBe(true); expect(result.outerReceipt).toBe(r); expect(result.receipt?.logs).toEqual([]); expect(result.logScope).toBe('unknown'); expect(result.userOpHash).toBe(H2); expect(direct).not.toHaveBeenCalled();
  });
  it('recovery uses computed hash, later succeeds and never sends', async () => {
    const submission: SponsoredSubmission = { phase: 'submitting', computedHash: H2, entryPoint: EP, chainId: 100 };
    const pending = await reconcileSponsoredSubmission(submission, { getUserOperationReceipt: async () => null, getTransactionReceipt: async () => { throw new Error('not expected'); } });
    expect(pending.outcome.status).toBe('unknown');
    const success = await reconcileSponsoredSubmission(submission, { getUserOperationReceipt: async h => { expect(h).toBe(H2); return { transactionHash: TX }; }, getTransactionReceipt: async () => receipt([event(H2, true)]) });
    expect(success.outcome.status).toBe('succeeded'); expect(success.submission.txHash).toBe(TX); expect(transport.sendCount).toBe(0);
    const failed = await reconcileSponsoredSubmission(submission, { getUserOperationReceipt: async () => { throw new Error('RPC'); }, getTransactionReceipt: async () => null });
    expect(failed.outcome.code).toBe('RECEIPT_READ_FAILED');
  });
});

describe('ROOT-RUNTIME-HASH-MISMATCH canonical intended identity survives recovery', () => {
  it('mismatched submitted hash and unrelated successful receipt cannot settle computed operation', async () => {
    transport.mode = 'mismatch';
    const journal: SponsoredSubmission[] = [];
    let failure: SponsoredSubmissionError | undefined;
    try { await sendSponsored(H1, A, '0x1234', ORG as any, 1n, { bundlerUrl: 'https://fixture.invalid', onSubmitted: s => { journal.push(s); } }); }
    catch (e) { failure = e as SponsoredSubmissionError; }
    expect(failure).toBeInstanceOf(SponsoredSubmissionError);
    const submission = failure!.submission;
    const computed = hashUserOperationV07(transport.operation, EP, 100);
    expect(submission).toMatchObject({ phase: 'submitted', computedHash: computed, userOpHash: H2 });
    expect(computed).not.toBe(H2); expect(journal).toEqual([submission]);
    expect(transport.sendCount).toBe(1); expect(transport.waitCount).toBe(0);
    const queries: string[] = [];
    const recovery = await reconcileSponsoredSubmission(submission, {
      getUserOperationReceipt: async h => { queries.push(h); return { transactionHash: TX }; },
      getTransactionReceipt: async () => receipt([event(H2, true)]),
    });
    expect(queries).toEqual([computed]);
    expect(recovery.outcome).toMatchObject({ status: 'unknown', userOpHash: computed, code: 'MISSING_TARGET_EVENT' });
    expect(recovery.submission).toMatchObject({ computedHash: computed, userOpHash: H2, txHash: TX });
    expect(transport.sendCount).toBe(1); expect(transport.waitCount).toBe(0);
  });
  it('computed hash settles from its own event while retaining conflicting bundler hash diagnostically', async () => {
    const submission: SponsoredSubmission = { phase: 'submitted', computedHash: H1, userOpHash: H2, entryPoint: EP, chainId: 100 };
    const input = { ...submission };
    const result = await reconcileSponsoredSubmission(submission, {
      getUserOperationReceipt: async h => { expect(h).toBe(H1); return { transactionHash: TX }; },
      getTransactionReceipt: async () => receipt([event(H2, false), event(H1, true)]),
    });
    expect(result.outcome).toMatchObject({ status: 'succeeded', userOpHash: H1 });
    expect(result.submission.userOpHash).toBe(H2); expect(submission).toEqual(input);
    expect(transport.signCount).toBe(0); expect(transport.sendCount).toBe(0);
  });
  it('a cached unrelated transaction cannot replace the computed event expectation', async () => {
    const getOp = vi.fn(async () => null);
    const result = await reconcileSponsoredSubmission({ phase: 'receipt', computedHash: H1, userOpHash: H2, txHash: TX, entryPoint: EP, chainId: 100 }, {
      getUserOperationReceipt: getOp, getTransactionReceipt: async () => receipt([event(H2, true)]),
    });
    expect(result.outcome).toMatchObject({ status: 'unknown', userOpHash: H1 }); expect(getOp).not.toHaveBeenCalled();
    expect(transport.sendCount).toBe(0); expect(transport.signCount).toBe(0);
  });
  it('returned-hash-only legacy journals remain recoverable', async () => {
    const result = await reconcileSponsoredSubmission({ phase: 'submitted', userOpHash: H2, entryPoint: EP, chainId: 100 }, {
      getUserOperationReceipt: async h => { expect(h).toBe(H2); return { transactionHash: TX }; }, getTransactionReceipt: async () => receipt([event(H2, true)]),
    });
    expect(result.outcome).toMatchObject({ status: 'succeeded', userOpHash: H2 }); expect(transport.sendCount).toBe(0);
  });
  for (const reader of ['operation', 'transaction'] as const) it(`${reader} recovery exception stays uncertain with zero sends`, async () => {
    const result = await reconcileSponsoredSubmission({ phase: 'submitted', computedHash: H1, userOpHash: H2, entryPoint: EP, chainId: 100 }, {
      getUserOperationReceipt: async () => { if (reader === 'operation') throw new Error('offline'); return { transactionHash: TX }; },
      getTransactionReceipt: async () => { throw new SponsoredSubmissionError('reader failure', { phase: 'pre-submit', entryPoint: EP, chainId: 100 }); },
    });
    expect(result.outcome).toMatchObject({ status: 'unknown', code: 'RECEIPT_READ_FAILED', userOpHash: H1 });
    expect(result.submission.phase).toBe('submitted'); expect(transport.sendCount).toBe(0); expect(transport.signCount).toBe(0);
  });
  it('executor rejects a mismatched adapter response without reading unrelated success or direct fallback', async () => {
    const readReceipt = vi.fn(async () => receipt([event(H2, true, EP, 9, new ethers.Wallet(H1).address)])); const { contract, direct } = mockContract(readReceipt);
    const send = vi.fn(async opts => { await opts.onSubmitted({ phase: 'submitted', computedHash: H1, userOpHash: H2, entryPoint: EP, chainId: 100 }); return { txHash: TX, userOpHash: H2 }; });
    const result = await executeContractTx(contract, 'action', [], { sponsored: config, sponsoredAdapter: adapter(send) });
    expect(result.success).toBe(false); expect(result.outcome).toMatchObject({ status: 'unknown', userOpHash: H1 });
    expect(result.submission).toMatchObject({ computedHash: H1, userOpHash: H2 }); expect(result.userOpHash).toBe(H1);
    expect(send).toHaveBeenCalledTimes(1); expect(direct).not.toHaveBeenCalled(); expect(readReceipt).not.toHaveBeenCalled();
  });
});

describe('ROOT-RUNTIME-BIGNUMBERISH and ROOT-RUNTIME-INTENT-BIGNUMBERISH full input parity', () => {
  for (const value of [Uint8Array.of(1), [1]]) it(`ROOT-RUNTIME-INTENT-BIGNUMBERISH ${value.constructor.name} matches existing encodeIntent independently of key normalization`, () => {
    const intent: TxIntent = { to: A, abi: ['function action() payable'], method: 'action', args: [], value, meta: { domain: 'org', action: 'action' } };
    expect(encodeIntent(intent).value).toBe('1');
    expect(intentToExecutionRequest(intent).value).toBe('1');
  });
  // Same exact integers in every ethers v5 representation, including high bytes/leading zeros.
  for (const raw of [0n, 1n, 9007199254740993n, LARGE, (1n << 256n) - 1n]) {
    const bn = ethers.BigNumber.from(raw); const bytes = ethers.utils.arrayify(bn.toHexString());
    const forms: [string, ethers.BigNumberish][] = [['decimal', raw.toString()], ['hex', bn.toHexString()], ['bigint', raw], ['BigNumber', bn], ['Uint8Array', bytes], ['byte array', Array.from(bytes)], ['leading-zero bytes', Uint8Array.from([0, ...bytes])], ['array-like bytes', { ...bytes, length: bytes.length }]];
    if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) forms.push(['Number', Number(raw)]);
    for (const [form, value] of forms) it(`${form} preserves exact ${raw} in typed key and host native value`, () => {
      const key = ethers.utils.solidityKeccak256(['uint8', 'bytes32'], [1, ethers.utils.hexZeroPad(bn.toHexString(), 32)]);
      expect(hatSubjectKey(value)).toBe(key);
      const intent: TxIntent = { to: A, abi: ['function action(uint256) payable'], method: 'action', args: [LARGE.toString()], value, meta: { domain: 'org', action: 'action' } };
      expect(encodeIntent(intent).value).toBe(raw.toString());
      expect(intentToExecutionRequest(intent)).toMatchObject({ to: A, value: raw.toString(), method: 'action' });
      expect(intentToExecutionRequest(intent).args).toBe(intent.args);
    });
  }
  it('maximum safe Number is accepted without an intermediate ethers Number overflow', () => {
    expect(hatSubjectKey(Number.MAX_SAFE_INTEGER)).toBe(hatSubjectKey(String(Number.MAX_SAFE_INTEGER)));
    expect(intentToExecutionRequest({ to: A, abi: [], method: 'action', args: [], value: Number.MAX_SAFE_INTEGER, meta: { domain: 'org', action: 'action' } }).value).toBe('9007199254740991');
  });
  for (const value of [-1, -0, '-1', '-0x01', Number.MAX_SAFE_INTEGER + 1, 1.5, NaN, Infinity, 1n << 256n, '0x' + '01' + '00'.repeat(32), Uint8Array.from([1, ...new Array(32).fill(0)]), [256], [-1], [], '0xzz']) it(`unsafe/invalid ${typeof value}:${String(value)} refuses before host execution`, async () => {
    expect(() => hatSubjectKey(value)).toThrow();
    const execute = vi.fn(async () => 'sent');
    await expect(executeIntentWithHost({ to: A, abi: [], method: 'action', args: [], value, meta: { domain: 'org', action: 'action' } }, {}, { isCurrent: () => true, execute })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('PM-KEY / SPONSOR-CODEC exact typed payload', () => {
  it('ROOT-RUNTIME-LEGACY-PAYMASTER-PADDING frozen original wrapper vectors, strict generic codec unchanged', () => {
    const oracle = fixture('legacy-paymaster-padding.json');
    expect(oracle.provenance.commit).toBe('29f76287743d0cac43533f3683992d1c8ecc48e8');
    for (const vector of oracle.vectors) {
      expect(encodePaymasterData(vector.orgId, BigInt(vector.hatId))).toBe(vector.payload);
      expect(ethers.utils.arrayify(vector.payload)).toHaveLength(78);
      expect(parseSponsorshipPayload(vector.payload).orgId).toBe(vector.paddedOrgId);
      if (vector.orgId.length !== 66) expect(() => encodeSponsorshipPayload({ orgId: vector.orgId, subjectType: 1, subjectId: vector.hatId })).toThrow('orgId must be bytes32');
    }
    for (const orgId of ['0x' + '01'.repeat(33), '0xzz', '01']) expect(() => encodePaymasterData(orgId as any, 1n)).toThrow();
    for (const hatId of [-1n, 1n << 256n]) expect(() => encodePaymasterData('0x01', hatId)).toThrow();
  });
  for (const type of [0, 1, 5]) for (const id of [0n, 1n, 9007199254740993n, LARGE, (1n << 256n) - 1n]) it(`key type=${type} id=${id}`, () => {
    const expected = ethers.utils.keccak256(ethers.utils.concat([Uint8Array.of(type), ethers.utils.arrayify(ethers.utils.hexZeroPad(ethers.BigNumber.from(id).toHexString(), 32))]));
    expect(paymasterSubjectKey(type, id)).toBe(expected); expect(paymasterSubjectKey(type, '0x' + id.toString(16))).toBe(expected);
    if (type === 1) expect(hatSubjectKey(ethers.BigNumber.from(id))).toBe(expected);
  });
  it('ACCOUNT/CLAIM address key parity; HAT registration and explicit key preserved', () => {
    for (const type of [0, 5]) expect(paymasterSubjectKey(type, A)).toBe(ethers.utils.solidityKeccak256(['uint8', 'bytes32'], [type, ethers.utils.hexZeroPad(A, 32)]));
    const iface = new ethers.utils.Interface([`function registerAndConfigureOrg(bytes32 orgId,uint256 adminHatId,${DEPLOY_CONFIG_TUPLE} config) payable`, 'function registerOrg(bytes32,uint256,uint256)']);
    const admin = ethers.BigNumber.from(LARGE);
    expect(iface.decodeFunctionData('registerOrg', buildRegisterCalldata(ORG, admin, admin).data)[1].toString()).toBe(LARGE.toString());
    const encoded = buildRegisterCalldata(ORG, admin, admin, { budgets: [{ hatId: LARGE.toString(), capPerEpoch: '0.1', epochLen: 100 }, { subjectKey: H1, capPerEpoch: '0.2', epochLen: 100 }] });
    const decoded = iface.decodeFunctionData('registerAndConfigureOrg', encoded.data)[2];
    expect(decoded.budgetSubjectKeys).toEqual([paymasterSubjectKey(1, LARGE), H1]);
    expect(decoded.budgetCapsPerEpoch.map((n: any) => n.toString())).toEqual(['100000000000000000', '200000000000000000']);
  });
  for (const type of [0, 1, 3, 4, 5] as const) it(`mode ${type} independent solidityPack parity and 78 bytes`, () => {
    const orgId = type === 3 || type === 4 ? ZERO_SUBJECT : ORG;
    const subjectId = type === 3 || type === 4 ? 0n : type === 1 ? LARGE : A;
    const ruleId = type === 3 || type === 4 ? 0n : uint32;
    const data = encodeSponsorshipPayload({ orgId, subjectType: type, subjectId, ruleId, mailboxCommit: uint64 });
    expect(ethers.utils.arrayify(data)).toHaveLength(78);
    expect(data).toBe(ethers.utils.solidityPack(['uint8', 'bytes32', 'uint8', 'bytes32', 'uint32', 'uint64'], [1, orgId, type, subjectIdBytes32(subjectId), ruleId, uint64]));
    expect(parseSponsorshipPayload(data)).toEqual({ version: 1, orgId, subjectType: type, subjectId: subjectIdBytes32(subjectId), ruleId: ruleId.toString(), mailboxCommit: uint64.toString() });
  });
  it('refuses invalid mode/width/address/org, solidarity nonzero and budget-ineligible modes', () => {
    for (const id of [-1, '9007199254740993e0', Number.MAX_SAFE_INTEGER + 1, (1n << 256n), '0xzz']) expect(() => paymasterSubjectKey(1, id)).toThrow();
    for (const type of [2, 3, 4, 256]) expect(() => paymasterSubjectKey(type, 1)).toThrow();
    const p = { orgId: ORG, subjectType: 1 as const, subjectId: LARGE };
    for (const override of [{ ruleId: 1n << 32n }, { mailboxCommit: 1n << 64n }, { orgId: A }, { subjectType: 2 }, { subjectType: 3 }, { subjectType: 4 }, { subjectType: 0, subjectId: 1n << 160n }, { subjectType: 5, subjectId: '0x123' }]) expect(() => encodeSponsorshipPayload({ ...p, ...override } as any)).toThrow();
    for (const type of [3, 4] as const) expect(() => encodeSponsorshipPayload({ orgId: ZERO_SUBJECT, subjectType: type, subjectId: 0, ruleId: 1 })).toThrow();
    for (const data of ['0x', encodeSponsorshipPayload(p).replace(/^0x01/, '0x02')]) expect(() => parseSponsorshipPayload(data)).toThrow();
  });
  it('HAT compatibility bytes unchanged; supplied CLAIM-before-HAT candidates remain ordered', () => {
    expect(encodePaymasterData(ORG as any, LARGE)).toBe(encodeSponsorshipPayload({ orgId: ORG, subjectType: 1, subjectId: LARGE }));
    const candidates = [{ orgId: ORG, subjectType: SUBJECT_TYPE.CLAIM, subjectId: A }, { orgId: ORG, subjectType: SUBJECT_TYPE.HAT, subjectId: LARGE }];
    expect(candidates.map(encodeSponsorshipPayload).map(parseSponsorshipPayload).map(p => p.subjectType)).toEqual([5, 1]);
  });
});

describe('SPONSOR-BUDGET-MATH contract arithmetic', () => {
  it('all five FINAL gas fields multiply maxFee: literal independent prefund', () => {
    expect(requiredPrefundV07(op as any)).toBe('11873752');
    expect(requiredPrefundV07({ ...op, callGasLimit: '123457' } as any)).toBe('11873769');
    expect(requiredPrefundV07({ ...op, maxFeePerGas: '0' } as any)).toBe('0');
    expect(() => requiredPrefundV07({ ...op, paymasterPostOpGasLimit: undefined } as any)).toThrow();
    expect(() => requiredPrefundV07({ ...op, callGasLimit: 1n << 128n } as any)).toThrow();
  });
  const budget = { capPerEpoch: '10', usedInEpoch: '7', epochStart: '100', epochLen: '100' };
  for (const [time, expected] of [[199, '3'], [200, '10'], [401, '10']] as const) it(`lazy roll time=${time}`, () => expect(remainingBudget(budget, time)).toBe(expected));
  it('epochStart zero rolls at len, zero len never rolls; unset and overused saturate', () => {
    expect(remainingBudget({ ...budget, epochStart: '0' }, 99)).toBe('3');
    expect(remainingBudget({ ...budget, epochStart: '0' }, 100)).toBe('10');
    expect(remainingBudget({ ...budget, epochLen: '0' }, 999)).toBe('3');
    expect(remainingBudget({ ...budget, usedInEpoch: '11' }, 199)).toBe('0');
    expect(remainingBudget({ capPerEpoch: 0, usedInEpoch: 0, epochStart: 0, epochLen: 0 }, 100)).toBe('0');
    // No frontend grace: 1 second before reset remains constrained.
    expect(remainingBudget(budget, 199)).toBe('3');
  });
  it('strict fields and Solidity uint32 epoch overflow refuse', () => {
    for (const override of [{ epochLen: 1n << 32n }, { capPerEpoch: 1n << 128n }, { usedInEpoch: -1 }, { epochStart: uint32, epochLen: 1 }]) expect(() => remainingBudget({ ...budget, ...override }, 100)).toThrow();
    expect(() => remainingBudget(budget, Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});

function independentHash(operation: UserOperationV07, ep = EP, chain = 100) {
  const pair = (h: any, l: any) => ethers.utils.solidityPack(['uint128', 'uint128'], [h, l]);
  const init = operation.factory ? ethers.utils.hexConcat([operation.factory, operation.factoryData!]) : '0x';
  const pm = operation.paymaster ? ethers.utils.solidityPack(['address', 'uint128', 'uint128', 'bytes'], [operation.paymaster, operation.paymasterVerificationGasLimit, operation.paymasterPostOpGasLimit, operation.paymasterData ?? '0x']) : '0x';
  const hash = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address','uint256','bytes32','bytes32','bytes32','uint256','bytes32','bytes32'], [operation.sender, operation.nonce, ethers.utils.keccak256(init), ethers.utils.keccak256(operation.callData), pair(operation.verificationGasLimit, operation.callGasLimit), operation.preVerificationGas, pair(operation.maxPriorityFeePerGas, operation.maxFeePerGas), ethers.utils.keccak256(pm)]));
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes32','address','uint256'], [hash, ep, chain]));
}
describe('AA-HASH-SCOPE general v0.7 parity', () => {
  it('deployed/factory hash oracle, factory bytes change hash and bind EP/chain', () => {
    const deploying = { ...op, factory: B, factoryData: '0x123456' };
    expect(hashUserOperationV07(op, EP, 100)).toBe(independentHash(op));
    expect(getUserOpHash(op, EP, 100)).toBe(independentHash(op));
    expect(hashUserOperationV07(deploying, EP, 100)).toBe(independentHash(deploying));
    expect(packUserOperationV07(deploying).initCode).toBe(B + '123456');
    expect(hashUserOperationV07(deploying, EP, 100)).not.toBe(hashUserOperationV07(op, EP, 100));
    expect(hashUserOperationV07({ ...deploying, factoryData: '0xabcdef' }, EP, 100)).not.toBe(hashUserOperationV07(deploying, EP, 100));
    expect(hashUserOperationV07(op, C, 100)).not.toBe(hashUserOperationV07(op, EP, 100));
    expect(hashUserOperationV07(op, EP, 42161)).not.toBe(hashUserOperationV07(op, EP, 100));
    expect(hashUserOperationV07({ ...op, signature: '0xabcd' }, EP, 100)).toBe(hashUserOperationV07(op, EP, 100));
  });
  it('saved audited hash golden matches independent counterexample inputs', () => {
    const saved = fixture('userop-golden.json');
    const deployed = { ...saved.operation };
    expect(hashUserOperationV07(deployed, saved.entryPoint, saved.chainId)).toBe(saved.deployedHash);
    expect(hashUserOperationV07({ ...deployed, factory: saved.factory, factoryData: '0x123456' }, saved.entryPoint, saved.chainId)).toBe('0x32e0886ce17afdd0fb9ac4ee8fa6a0c67262d3744ad08519ab19a8385efe717f');
  });
  it('half factory, malformed gas/paymaster/chain/EP refuse', () => {
    for (const override of [{ factory: B }, { factoryData: '0x' }, { factory: '0x1234', factoryData: '0x12' }, { callGasLimit: 1n << 128n }, { maxFeePerGas: 1n << 128n }, { nonce: Number.MAX_SAFE_INTEGER + 1 }, { paymasterVerificationGasLimit: undefined }, { callData: '0x1' }, { sender: ethers.constants.AddressZero }]) expect(() => packUserOperationV07({ ...op, ...override } as any)).toThrow();
    for (const chain of [0, -1, Number.MAX_SAFE_INTEGER + 1]) expect(() => hashUserOperationV07(op, EP, chain)).toThrow();
    expect(() => hashUserOperationV07(op, '0x1234', 100)).toThrow();
    expect(() => packUserOperationV07({ ...op, paymaster: undefined })).toThrow();
  });
});

describe('PASSKEY-CODEC registry/salt/signature parity', () => {
  const input = { user: A, username: 'FixtureMiXeD', nonce: '9007199254740993', deadline: '2000000000', chainId: 100, registryAddress: B };
  it('distinct EOA/passkey primary type digests bind nonce/chain/registry', () => {
    const domain = { name: 'UniversalAccountRegistry', version: '1', chainId: 100, verifyingContract: B };
    const data = { user: A, username: input.username, nonce: input.nonce, deadline: input.deadline };
    for (const [kind, types] of [['eoa', REGISTER_ACCOUNT_TYPES], ['passkey', REGISTER_PASSKEY_ACCOUNT_TYPES]] as const) {
      expect(registrationChallenge(input, kind)).toBe(ethers.utils._TypedDataEncoder.hash(domain, types, data));
      for (const override of [{ chainId: 42161 }, { registryAddress: C }, { nonce: '9007199254740992' }]) expect(registrationChallenge({ ...input, ...override }, kind)).not.toBe(registrationChallenge(input, kind));
    }
    expect(registrationChallenge(input, 'eoa')).not.toBe(registrationChallenge(input, 'passkey'));
    expect(registrationDomain(100, B).verifyingContract).toBe(B);
    expect(() => registrationChallenge({ ...input, nonce: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
  it('synthetic credential digest and poa-salt-v1 golden', () => {
    const raw = Uint8Array.from({ length: 32 }, (_, i) => i);
    expect(credentialIdDigest(raw)).toBe('0x8ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd2d');
    expect(derivePasskeySalt(credentialIdDigest(raw))).toBe(ethers.utils.keccak256(ethers.utils.concat([raw.length ? ethers.utils.arrayify(credentialIdDigest(raw)) : raw, ethers.utils.toUtf8Bytes('poa-salt-v1')])));
    expect(() => credentialIdDigest('0x')).toThrow();
  });
  it('raw32 credential prefix plus dynamic WebAuthn tuple roundtrip', () => {
    const auth = { authenticatorData: '0x010203', clientDataJSON: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('{"type":"webauthn.get","challenge":"fixture"}')), challengeIndex: '9007199254740993', typeIndex: '9', r: H1, s: H2 };
    const sig = packPasskeySignature(H1, auth);
    const tuple = ethers.utils.defaultAbiCoder.encode(['tuple(bytes,bytes,uint256,uint256,bytes32,bytes32)'], [[auth.authenticatorData, auth.clientDataJSON, auth.challengeIndex, auth.typeIndex, auth.r, auth.s]]);
    expect(sig).toBe(H1 + tuple.slice(2)); expect(unpackPasskeySignature(sig)).toEqual({ credentialId: H1, auth });
    expect(() => unpackPasskeySignature(sig + '00')).toThrow();
    expect(() => packPasskeySignature('0x12', auth)).toThrow();
    expect(() => packPasskeySignature(H1, { ...auth, challengeIndex: -1 })).toThrow();
  });
});

describe('ERROR-ADAPTER / ERROR-CREATOR-HINT / ERROR-COMPAT diagnostics', () => {
  it('trusted cause/originalError/error.data/RPC body supported; request and message hex ignored', () => {
    const data = custom.encodeErrorResult('NotCreator');
    for (const error of [{ cause: { data } }, { originalError: { error: { data: { data } } } }, { body: JSON.stringify({ error: { data } }) }]) {
      expect(extractRevertEvidence(error).data).toBe(data); expect(decodeContractError(error)?.name).toBe('NotCreator');
    }
    for (const error of [{ request: { data } }, { transaction: { data } }, { message: `reverted: ${data}` }, { body: JSON.stringify({ result: data }) }]) expect(extractRevertEvidence(error).data).toBeNull();
  });
  it('cyclic/deep/huge envelopes bounded, sibling diagnostic still found', () => {
    const cycle: any = {}; cycle.cause = cycle;
    expect(extractRevertEvidence(cycle).code).toBe('ENVELOPE_BOUNDED');
    cycle.error = { data: '0xdeadbeef' }; expect(extractRevertEvidence(cycle).data).toBe('0xdeadbeef');
    const deep = { cause: { cause: { data: '0xdeadbeef' } } }; expect(extractRevertEvidence(deep, { maxDepth: 1 }).code).toBe('ENVELOPE_BOUNDED');
    expect(extractRevertEvidence({ body: 'x'.repeat(50) }, { maxBodyBytes: 10 }).code).toBe('ENVELOPE_BOUNDED');
  });
  for (const [name, data, kind] of [['custom', custom.encodeErrorResult('NotCreator'), 'custom'], ['string', stringRevert('fixture'), 'string'], ['panic', '0x4e487b71' + ethers.utils.defaultAbiCoder.encode(['uint256'], [17]).slice(2), 'panic'], ['empty', '0x', 'empty'], ['unknown', '0xdeadbeef', 'unknown']] as const) it(`nested CallFailed preserves index and ${name} leaf`, () => {
    const tree = decodeRevertTree(custom.encodeErrorResult('CallFailed', [2, data]));
    expect(tree.name).toBe('CallFailed'); expect(tree.callIndex).toBe('2'); expect(tree.inner?.kind).toBe(kind);
    if (name === 'panic') expect(tree.inner?.args).toEqual(['17']);
    if (name === 'string') expect(tree.inner?.args).toEqual(['fixture']);
    if (name === 'custom') expect(tree.inner?.name).toBe('NotCreator');
  });
  it('wrapper recursion bounded; malformed data does not invent args', () => {
    let data = custom.encodeErrorResult('NotCreator'); for (let i = 0; i < 10; i++) data = custom.encodeErrorResult('CallFailed', [i, data]);
    expect(decodeRevertTree(data, { maxDepth: 1 }).inner?.kind).toBe('bounded');
    expect(decodeRevertTree('0x08c379a0').kind).toBe('malformed'); expect(decodeRevertTree('not hex').kind).toBe('malformed');
  });
  it('creator permission hint and stable CLI code/name/args/raw message survive', () => {
    const error = { code: 'UNPREDICTABLE_GAS_LIMIT', message: 'cannot estimate gas', data: custom.encodeErrorResult('NotCreator') };
    const result = classifyError(error);
    expect(result).toMatchObject({ code: 'GAS_ESTIMATION_FAILED', errorName: 'NotCreator', errorArgs: [] });
    expect(result.message).toMatch(/permission/); expect(result.message).not.toMatch(/Only the creator|original.*creator/);
    expect(result.rawMessage).toBe('Transaction would revert: cannot estimate gas');
    expect(getErrorHint('NotCreator', { domain: 'education', action: 'createModule' })?.human).toContain('EDU_CREATE');
    const localized = { NotCreator: 'local member copy' }[result.errorName as 'NotCreator']; expect(localized).toBe('local member copy');
  });
  it('all 30 frozen historical/third-party signatures retain diagnostic identity only on explicit opt-in', () => {
    const rows = fixture('historical-selectors.json'); expect(rows).toHaveLength(30);
    const iface = historicalExternalErrorInterface();
    for (const row of rows) {
      expect(ethers.utils.id(row.signature).slice(0, 10)).toBe(row.selector);
      const fragment = ethers.utils.ErrorFragment.from(row.signature);
      const args = fragment.inputs.map(p => p.type === 'address' ? A : '1');
      const data = iface.encodeErrorResult(fragment, args);
      expect(decodeRevertTree(data).kind).toBe('unknown');
      const tree = decodeRevertTree(data, { compatibilityInterfaces: [iface], compatibilityNames: HISTORICAL_EXTERNAL_ERROR_NAMES });
      expect(tree.name).toBe(row.name); expect(tree.compatibility).toBe(true);
    }
  });
  it('current generated selector wins compatibility conflict; unknown remains unknown', () => {
    const fake = { parseError: () => ({ name: 'FakeHistorical', args: [] }) } as any;
    const tree = decodeRevertTree(custom.encodeErrorResult('NotCreator'), { compatibilityInterfaces: [fake] });
    expect(tree.name).toBe('NotCreator'); expect(tree.compatibility).toBeUndefined();
    expect(decodeRevertTree('0xdeadbeef', { compatibilityInterfaces: [historicalExternalErrorInterface()] }).kind).toBe('unknown');
  });
});

describe('INTENT-HOST value/options/result/scope boundary', () => {
  const intent: TxIntent = { to: A, abi: ['function action(uint256 id) payable'], method: 'action', args: [LARGE.toString()], value: '1', meta: { domain: 'runtime', action: 'action', summary: { gasLimit: 1, sponsored: false } } };
  it('signerless contract and exact native value/large args; no metadata policy', () => {
    const request = intentToExecutionRequest(intent); expect(request).toEqual({ to: A, abi: intent.abi, method: 'action', args: intent.args, value: '1' });
    const triple = intentToContractCall(intent, undefined as any);
    expect(triple.contract.interface.encodeFunctionData(triple.method, triple.args)).toBe(encodeIntent(intent).data);
    expect(triple.contract.signer).toBeNull();
    expect(() => intentToExecutionRequest({ ...intent, value: -1 })).toThrow(); expect(() => intentToExecutionRequest({ ...intent, value: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(intentToExecutionRequest({ ...intent, value: undefined }).value).toBe('0');
  });
  for (const status of ['success', 'failed', 'unknown']) it(`${status} result/raw receipt and options retained`, async () => {
    const result = { status, receipt: receipt([event(H2, status === 'success')]), error: status === 'success' ? undefined : { code: 'fixture' } };
    const options = { gasLimit: 100000, sponsored: true, deleteAfter: true, refresh: vi.fn() };
    const execute = vi.fn(async (req, opts) => { expect(req.value).toBe('1'); expect(req.args).toBe(intent.args); expect(opts).toBe(options); return result; });
    const handled = await executeIntentWithHost(intent, options, { isCurrent: () => true, execute, onResult: options.refresh });
    expect(handled).toEqual({ status: 'current', result }); expect(options.refresh).toHaveBeenCalledWith(result);
  });
  it('changed account/org/generation discards stale callback; stale initial scope sends nothing', async () => {
    let current = true; const refresh = vi.fn();
    const result = await executeIntentWithHost(intent, {}, { isCurrent: () => current, execute: async () => { current = false; return {}; }, onResult: refresh });
    expect(result.status).toBe('stale'); expect(refresh).not.toHaveBeenCalled();
    const execute = vi.fn(); expect((await executeIntentWithHost(intent, {}, { isCurrent: () => false, execute })).status).toBe('stale'); expect(execute).not.toHaveBeenCalled();
  });
  it('value-incapable batch host rejects before send; supported single host preserves value', async () => {
    const send = vi.fn();
    await expect(executeIntentWithHost(intent, { batch: true }, { isCurrent: () => true, execute: async (req, opts) => {
      if (opts.batch && BigInt(req.value) > 0n) throw new Error('Batch host does not support native value'); send(req);
    } })).rejects.toThrow('native value'); expect(send).not.toHaveBeenCalled();
  });
});

function documentPaths(document: string): string[] {
  const paths: string[] = [];
  function walk(selections: readonly any[], parent: string) { for (const selection of selections) if (selection.kind === 'Field') {
    const path = parent ? `${parent}.${selection.name.value}` : selection.name.value; paths.push(path);
    if (selection.selectionSet) walk(selection.selectionSet.selections, path);
  } }
  const ast = parse(document); for (const def of ast.definitions) if (def.kind === 'OperationDefinition') walk(def.selectionSet.selections, ''); return paths;
}
describe('ACCOUNT-DOCS / GAS-HISTORY-DOC / PROTOCOL-DOC source facts', () => {
  it('account documents preserve factory/beacon/revocation/keys, fallback explicitly omits unavailable keys', () => {
    expect(documentPaths(FETCH_CREDENTIAL_PAGE)).toEqual(expect.arrayContaining(['passkeyCredentials.publicKeyX', 'passkeyCredentials.publicKeyY', 'passkeyCredentials.active', 'passkeyCredentials.removedAt', 'passkeyCredentials.account.factory.id']));
    expect(documentPaths(FETCH_CREDENTIAL_PAGE_LEGACY)).not.toContain('passkeyCredentials.publicKeyX');
    expect(documentPaths(FETCH_ACCOUNT_FACTS)).toContain('passkeyAccounts.factory.accountBeacon');
    expect(documentPaths(FETCH_FACTORY_FACTS)).toContain('universalAccountRegistries.passkeyFactory');
    expect(documentPaths(FETCH_SOLIDARITY_STATE)).toContain('onboardingConfigs.enabled');
  });
  it('all saved protocol missing-field paths covered by canonical overview/page documents', () => {
    const docs = [FETCH_PROTOCOL_OVERVIEW, FETCH_PROTOCOL_ORGS_PAGE, FETCH_BEACON_EVENTS_PAGE, FETCH_SOLIDARITY_EVENTS_PAGE];
    const paths = new Set(docs.flatMap(documentPaths));
    for (const path of fixture('protocol-missing-paths.json')) expect(paths.has(path), path).toBe(true);
    for (const doc of [FETCH_CREDENTIAL_PAGE, ...docs.slice(1), FETCH_PAYMASTER_DEPOSITS_PAGE, FETCH_PAYMASTER_USAGE_PAGE]) {
      const args: string[] = []; visit(parse(doc), { Argument: n => { args.push(n.name.value); } });
      expect(args).toContain('first'); expect(args).toContain('orderBy'); expect(doc).toContain('id_gt: $cursor');
    }
  });
  it('source-specific no-match is complete; transport/missing collections unavailable; no default home', async () => {
    const s = source({ chainId: 42161, endpoint: 'fixture://arbitrum', account: A, contracts: { registry: B } });
    const query = vi.fn(async (_doc, variables, src) => { expect(src).toBe(s); expect(variables).toMatchObject({ account: A, registry: B }); return { passkeyAccounts: [], accounts: [] }; });
    const noMatch = await readAccountFacts(s, query, B); expect(noMatch.coverage.status).toBe('complete'); expect(noMatch.data.passkeyAccounts).toEqual([]);
    expect((await readAccountFacts(s, async () => { throw new Error('offline'); }, B)).coverage.status).toBe('unavailable');
    expect((await readAccountFacts(s, async () => ({ passkeyAccounts: [] }), B)).coverage.status).toBe('incomplete');
    expect((await readAccountFacts(s, async () => ({ passkeyAccounts: [{ id: C }], accounts: [] }), B)).coverage.issues).toContainEqual({ code: 'SINGLETON_SCOPE_MISMATCH', id: 'passkeyAccounts' });
    expect(() => readAccountFacts(s, query, C)).toThrow('SCOPE_MISMATCH');
  });
  it('zero/multiple/mismatched factories remain evidence, registry selection explicit', async () => {
    const s = source({ contract: A, contracts: { registry: B } });
    expect((await readFactoryFacts(s, async () => ({ passkeyAccountFactories: [], universalAccountRegistries: [] }), B)).coverage.status).toBe('complete');
    expect((await readFactoryFacts(s, async () => ({ passkeyAccountFactories: [{ id: A }, { id: B }], universalAccountRegistries: [{ id: B }] }), B)).coverage.status).toBe('incomplete');
    expect((await readFactoryFacts(s, async () => ({ passkeyAccountFactories: [{ id: C }], universalAccountRegistries: [] }), B)).coverage.status).toBe('incomplete');
  });
  it('public keys/revocation are facts; missing keys unknown and discovered source retained', () => {
    const s = source({ account: A, chainId: 42161, endpoint: 'fixture://discovered' });
    const row = { id: 'credential-1', account: { id: A }, credentialId: H1, active: false, publicKeyX: H1, publicKeyY: H2, createdAt: '1000', removedAt: '1001' };
    const facts = projectCredentialFacts(row, s); expect(facts.active).toEqual(knownFact(false, s)); expect(facts.publicKeyX).toEqual(knownFact(H1, s)); expect(facts.removedAt).toEqual(knownFact('1001', s));
    expect(projectCredentialFacts({ ...row, publicKeyX: undefined }, s).publicKeyX.state).toBe('unknown');
    expect(() => projectCredentialFacts({ ...row, account: { id: C } }, s)).toThrow();
  });
  it('1001 deposit records sharing timestamps page by ID with exact actor/raw amount/tx/block', async () => {
    const s = source({ orgId: ORG, method: 'PaymasterDepositsPage' });
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: '0x' + (i + 1).toString(16).padStart(8, '0'), paymasterHub: { id: B }, orgConfig: { id: 'orgcfg', orgId: ORG }, from: i % 2 ? A : C, to: B, eventType: 'ORG_DEPOSIT', amount: i === 1000 ? '9007199254740993' : '1', eventAt: '1000', eventAtBlock: '1001', transactionHash: TX }));
    const cursors: string[] = [];
    const result = await readPaymasterHistoryFacts({ source: s, kind: 'deposits', orgConfig: 'orgcfg', query: async (_doc, vars) => { cursors.push(vars.cursor as string); return { paymasterDepositEvents: rows.filter(r => r.id > String(vars.cursor)).slice(0, Number(vars.first)) }; } });
    expect(result.coverage.status).toBe('complete'); expect(result.data).toEqual(rows); expect(cursors).toEqual(['0x', rows[999].id]);
    expect(result.data[1000].amount).toBe('9007199254740993'); expect(result.source).toBe(s);
  });
  it('failed/capped second page retains partial history; first failure unavailable; missing collection never []', async () => {
    const s = source({ method: 'ProtocolOrgsPage' });
    const opts = { source: s, document: FETCH_PROTOCOL_ORGS_PAGE, collection: 'paymasterOrgConfigs', variables: { hub: B }, initialCursor: '', pageSize: 1, maxPages: 2 };
    const partial = await readIndexedPageFacts({ ...opts, query: async (_doc, vars) => { if (vars.cursor) throw new Error('page2 failed'); return { paymasterOrgConfigs: [{ id: '1' }] }; } });
    expect(partial.coverage.status).toBe('incomplete'); expect(partial.data).toHaveLength(1); expect(partial.coverage.failedIds).toEqual(['page:2']);
    const missing = await readIndexedPageFacts({ ...opts, query: async () => ({}) }); expect(missing.coverage.status).toBe('unavailable');
    const capped = await readIndexedPageFacts({ ...opts, maxPages: 1, query: async () => ({ paymasterOrgConfigs: [{ id: '1' }] }) }); expect(capped.coverage.status).toBe('incomplete');
    expect(sumIndexedOrgGasFacts(partial).totalSpent.state).toBe('unknown');
  });
  it('usage signed delta/subject/block preserved and mismatched source blocked', async () => {
    const s = source({ orgId: ORG, method: 'PaymasterUsagePage' });
    const row = { id: '0x01', orgConfig: { id: 'cfg', orgId: ORG, paymasterHub: { id: B } }, delta: '-9007199254740993', subjectKey: H1, eventAt: '1000', eventAtBlock: '1001', transactionHash: TX };
    const result = await readPaymasterHistoryFacts({ source: s, orgConfig: 'cfg', kind: 'usage', query: async () => ({ usageEvents: [row] }) }); expect(result.coverage.status).toBe('complete'); expect(result.data[0]).toBe(row);
    const wrong = await readPaymasterHistoryFacts({ source: s, orgConfig: 'cfg', kind: 'usage', query: async () => ({ usageEvents: [{ ...row, orgConfig: { ...row.orgConfig, paymasterHub: { id: C } } }] }) }); expect(wrong.coverage.status).toBe('incomplete');
  });
  it('pinned read forwards exact block; graph errors never complete empty', async () => {
    const s = source({ snapshot: 'pinned', block: { number: '123' } });
    const result = await readSolidarityFacts(s, async (_doc, variables) => { expect(variables.block).toEqual({ number: 123 }); return { paymasterHubContracts: [], onboardingConfigs: [], _meta: { block: { number: 123, hash: null } } }; });
    expect(result.coverage.status).toBe('complete'); expect(result.source.block).toEqual({ number: '123' });
    expect((await readSolidarityFacts(s, async () => ({ paymasterHubContracts: [], onboardingConfigs: [] }))).coverage.status).toBe('unavailable');
    expect((await readSolidarityFacts(s, async () => ({ errors: [{ message: 'failed' }] }))).coverage.status).toBe('unavailable');
  });
  for (const chainId of [100, 42161]) it(`chain ${chainId}: no guessed mutable config; zero/false exact with fresh getter source`, () => {
    const s = source({ chainId });
    const snap = snapshot({ poaManagerContracts: [{ id: A, beaconCount: '9007199254740993', passkeyAccountFactoryProxy: C, createdAt: '1000' }], orgRegistryContracts: [{ id: C, totalOrgs: '0', totalContracts: '0' }], universalAccountRegistries: [{ id: C, totalAccounts: '0' }], paymasterHubContracts: [{ id: B, solidarityBalance: '9007199254740993', solidarityDistributionPaused: false }], onboardingConfigs: [], orgDeployConfigs: [] }, s);
    const facts = projectProtocolFacts(snap); expect(facts.current['getOnboardingConfig.enabled'].state).toBe('unknown'); expect(facts.current['getSolidarityFund.feePercentageBps'].state).toBe('unknown');
    expect(facts.indexed['poaManagerContracts.beaconCount']).toEqual(knownFact('9007199254740993', s)); expect(facts.indexed['orgRegistryContracts.totalOrgs']).toEqual(knownFact('0', s));
    const liveSource = source({ chainId, method: 'getOnboardingConfig', indexed: false, endpoint: 'fixture://rpc' });
    const fresh = projectProtocolFacts(snap, { getOnboardingConfig: snapshot({ enabled: false, maxGasPerCreation: '0', dailyCreationLimit: '0' }, liveSource) });
    expect(fresh.current['getOnboardingConfig.enabled']).toEqual(knownFact(false, liveSource)); expect(fresh.current['getOnboardingConfig.maxGasPerCreation']).toEqual(knownFact('0', liveSource));
    const mismatch = projectProtocolFacts(snap, { getOnboardingConfig: snapshot({ enabled: true }, { ...liveSource, chainId: chainId === 100 ? 42161 : 100 }) }); expect(mismatch.current['getOnboardingConfig.enabled'].state).toBe('unknown');
  });
  it('missing/malformed/stale-scope/incomplete indexed fields unknown; complete totals exact', () => {
    const rows: IndexedRow[] = [{ id: '1', paymasterHub: { id: B }, totalSpent: '9007199254740993', totalSolidarityReceived: '0', depositBalance: '1', totalDeposited: '2', stats: { totalUserOps: '1', totalGasSponsored: '2' } }, { id: '2', paymasterHub: { id: B }, totalSpent: '1', totalSolidarityReceived: '0', depositBalance: '1', totalDeposited: '2', stats: { totalUserOps: '1', totalGasSponsored: '2' } }];
    const complete = snapshot(rows); complete.coverage.receivedKeys = ['1', '2'];
    expect(sumIndexedOrgGasFacts(complete).totalSpent).toEqual(knownFact('9007199254740994', source()));
    expect(sumIndexedOrgGasFacts(snapshot([])).totalSpent).toEqual(knownFact('0', source()));
    expect(sumIndexedOrgGasFacts(snapshot([{}])).totalSpent.state).toBe('unknown');
    const wrong = projectProtocolFacts(snapshot({ paymasterHubContracts: [{ id: C, solidarityBalance: '1' }] })); expect(wrong.indexed['paymasterHubContracts.solidarityBalance'].state).toBe('unknown');
    const partial = snapshot({ paymasterHubContracts: [{ id: B, solidarityBalance: '1' }] }); partial.coverage.status = 'incomplete'; expect(projectProtocolFacts(partial).indexed['paymasterHubContracts.solidarityBalance'].state).toBe('unknown');
  });
});


describe('runtime integration boundaries', () => {
  it('immutable serving schema accepts every legacy credential selection and rejects unavailable modern key selections', () => {
    const schema = buildSchema(readFileSync(join(__dirname, 'fixtures/core-update/runtime/credential-serving-schema.graphql'), 'utf8'));
    // Validate the actual document selections against the independent field oracle. Selector
    // variable portability is owned by repair-queries and is outside this runtime assertion.
    const selections = (document: string) => visit(parse(document), {
      OperationDefinition: node => ({ ...node, variableDefinitions: [] }),
      // This immutable minimal fixture tests credential selection capability;
      // full same-block metadata selection is independently schema-checked in
      // update-serving-queries/update-indexed-provenance instead.
      Field: node => node.name.value === '_meta' ? null : node.name.value === 'passkeyCredentials' ? { ...node, arguments: [] } : undefined,
    });
    expect(validate(schema, selections(FETCH_CREDENTIAL_PAGE_LEGACY))).toEqual([]);
    const errors = validate(schema, selections(FETCH_CREDENTIAL_PAGE));
    expect(errors.map(e => e.message)).toEqual([
      'Cannot query field "publicKeyX" on type "PasskeyCredential".',
      'Cannot query field "publicKeyY" on type "PasskeyCredential".',
    ]);
  });
  it('missing optional stack is established pre-submit and allows one fallback', async () => {
    const { contract, direct } = mockContract();
    const loader = vi.fn(async () => { throw Object.assign(new Error('Cannot find module viem'), { code: 'MODULE_NOT_FOUND' }); });
    expect((await executeContractTx(contract, 'action', [], { sponsored: config, sponsoredAdapterLoader: loader })).success).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1); expect(direct).toHaveBeenCalledTimes(1); expect(transport.sendCount).toBe(0);
  });
  it('actual optional wrapper carries native value into execute and persists hash before wait', async () => {
    const observed: SponsoredSubmission[] = [];
    await sendSponsored(H1, A, '0x1234', ORG as any, 1n, { bundlerUrl: 'https://fixture.invalid', value: 9007199254740993n, onSubmitted: s => { expect(transport.waitCount).toBe(0); observed.push(s); } });
    const execute = new ethers.utils.Interface(['function execute(address,uint256,bytes)']);
    expect(execute.decodeFunctionData('execute', transport.operation.callData)[1].toString()).toBe('9007199254740993');
    expect(observed[0].userOpHash).toBe(hashUserOperationV07(transport.operation, EP, 100)); expect(transport.sendCount).toBe(1); expect(transport.waitCount).toBe(1);
  });
  it('credential reader explicit schema tier fallback retains revoked rows with unknown keys', async () => {
    const s = source({ account: A, method: 'CredentialPage' });
    const row = { id: '1', account: { id: A, factory: { id: C } }, credentialId: H1, active: false, createdAt: '1000', removedAt: '1001' };
    const queries: string[] = [];
    const result = await readCredentialFacts({ source: s, query: async doc => { queries.push(doc); if (doc.includes('publicKeyX')) throw new Error('Cannot query field "publicKeyX" on type "PasskeyCredential".'); return { passkeyCredentials: [row] }; } });
    expect(queries).toEqual([FETCH_CREDENTIAL_PAGE, FETCH_CREDENTIAL_PAGE_LEGACY]); expect(result.coverage.status).toBe('complete'); expect(result.data[0].active).toBe(false);
    expect(projectCredentialFacts(result.data[0], s).publicKeyX.state).toBe('unknown');
    const failure = await readCredentialFacts({ source: s, query: async () => { throw new Error('NETWORK_ERROR'); } }); expect(failure.coverage.status).toBe('unavailable');
  });
  it('credential discovery retains discovered chain/account rather than current prediction or HOME', async () => {
    const s = source({ chainId: 42161, method: 'CredentialDiscoveryPage', endpoint: 'fixture://arbitrum' });
    const row = { id: '1', credentialId: H1, account: { id: C, factory: { id: B } }, active: true, publicKeyX: H1, publicKeyY: H2 };
    const result = await readCredentialFacts({ source: s, credentialId: H1, query: async (_doc, vars, actual) => { expect(actual.chainId).toBe(42161); expect(vars.credentialId).toBe(H1); return { passkeyCredentials: [row] }; } });
    expect(result.data[0].account).toEqual({ id: C, factory: { id: B } }); expect(result.source.chainId).toBe(42161);
    expect(projectCredentialFacts(row, { ...s, account: C }).publicKeyY).toEqual(knownFact(H2, { ...s, account: C }));
  });
});


describe('source-scope invariants and callback error identity', () => {
  it('an accepted callback cannot fabricate a pre-submit fallback', async () => {
    const { contract, direct } = mockContract();
    const result = await executeContractTx(contract, 'action', [], { sponsored: config,
      sponsoredSend: { onSubmitted: () => { throw new SponsoredSubmissionError('callback error', { phase: 'pre-submit', chainId: 100, entryPoint: EP }); } },
      sponsoredAdapter: adapter(async opts => { await opts.onSubmitted({ phase: 'submitted', chainId: 100, entryPoint: EP, userOpHash: H2 }); return { userOpHash: H2, txHash: TX }; }) });
    expect(result.outcome?.status).toBe('unknown'); expect(result.submission?.phase).toBe('submitted'); expect(direct).not.toHaveBeenCalled();
  });
  it('protocol overview and org enumeration bind all instance addresses and retain scopes', async () => {
    const s = source();
    const result = await readProtocolOverviewFacts(s, async (_doc, vars) => { expect(vars).toMatchObject({ manager: A, registry: C, accountRegistry: C, hub: B }); return { poaManagerContracts: [{ id: A }], orgRegistryContracts: [{ id: C }], universalAccountRegistries: [{ id: C }], paymasterHubContracts: [{ id: B }], onboardingConfigs: [], orgDeployConfigs: [] }; });
    expect(result.coverage.status).toBe('complete');
    expect(() => readProtocolOverviewFacts(source({ contracts: {} }), async () => ({}))).toThrow();
    const scoped = await readProtocolOrgFacts({ source: s, query: async () => ({ paymasterOrgConfigs: [{ id: '1', paymasterHub: { id: C } }] }) }); expect(scoped.coverage.status).toBe('incomplete');
    const unscoped = snapshot([{ id: '1', paymasterHub: { id: C }, totalSpent: '1' }]); unscoped.coverage.receivedKeys = ['1']; expect(sumIndexedOrgGasFacts(unscoped).totalSpent.state).toBe('unknown');
  });
  for (const kind of ['beacon', 'solidarity'] as const) it(`${kind} event page retains exact seconds/block/tx with scoped failures`, async () => {
    const s = source({ contract: B });
    const row = kind === 'beacon' ? { id: '0x01', poaManager: { id: B }, upgradedAt: '1000', upgradedAtBlock: '1001', transactionHash: TX, version: 'v1', newImplementation: A } : { id: '0x01', paymasterHub: { id: B }, from: A, amount: '9007199254740993', eventAt: '1000', eventAtBlock: '1001', transactionHash: TX };
    const collection = kind === 'beacon' ? 'beaconUpgradeEvents' : 'solidarityEvents';
    const result = await readProtocolEventFacts({ source: s, kind, query: async () => ({ [collection]: [row] }) }); expect(result.coverage.status).toBe('complete'); expect(result.data[0]).toBe(row);
    const failed = await readProtocolEventFacts({ source: s, kind, query: async () => { throw new Error('failed'); } }); expect(failed.coverage.status).toBe('unavailable');
  });
});


it('pure account/sponsorship/error/protocol/intent leaves have no optional executor dependency closure', () => {
  const seen = new Set<string>();
  function scan(file: string) {
    if (seen.has(file)) return; seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from\s+|require\()\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1]; expect(specifier, file).not.toMatch(/^(viem|permissionless)(\/|$)/);
      if (specifier.startsWith('.')) {
        const base = resolve(dirname(file), specifier); const target = existsSync(base + '.ts') ? base + '.ts' : join(base, 'index.ts');
        expect(target).not.toContain('/execute/sponsored'); scan(target);
      }
    }
  }
  for (const leaf of ['accounts/codecs', 'accounts/userop-v07', 'sponsorship/codec', 'sponsorship/budget', 'errors/envelope', 'errors/compat', 'execute/outcome', 'reads/protocol', 'tx/intent']) scan(resolve(__dirname, '../src', leaf + '.ts'));
  expect(seen.size).toBeGreaterThan(9);
});


describe('durable operation pre-dispatch hook', () => {
  it('persists the exact computed operation hash and nonce before bundler dispatch', async () => {
    const prepared: SponsoredSubmission[] = [];
    await sendSponsored(H1, A, '0x1234', ORG as any, 1n, { bundlerUrl: 'https://fixture.invalid',
      onPrepared: submission => {
        expect(transport.sendCount).toBe(0); expect(submission.nonce).toBe('9');
        expect(submission.phase).toBe('submitting'); expect(submission.computedHash).toMatch(/^0x[0-9a-f]{64}$/);
        prepared.push(submission);
      } });
    expect(prepared).toHaveLength(1);
    expect(prepared[0].computedHash).toBe(hashUserOperationV07(transport.operation, EP, 100));
  });
  it('a failed persistence callback prevents send and remains non-fallback', async () => {
    await expect(sendSponsored(H1, A, '0x1234', ORG as any, 1n, { bundlerUrl: 'https://fixture.invalid',
      onPrepared: () => { throw new Error('journal persistence failed'); } }))
      .rejects.toMatchObject({ submission: { phase: 'submitting', nonce: '9' } });
    expect(transport.sendCount).toBe(0); expect(transport.waitCount).toBe(0);
  });
});
