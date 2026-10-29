import { test, expect } from 'vitest';
import { createPasskeyCredential, restoreCredentialKeys, resolveAccountDeployment, computeCounterfactualAddress } from '../../src/passkeys';
import { computeCredentialId } from '../../src/passkeys/utils';
import { X, Y, RAW_ID, RP, ORIGIN, CRYPTO, registrationResponse } from './fixtures';
const ACCOUNT = `0x${'11'.repeat(20)}`, FACTORY = `0x${'22'.repeat(20)}`, OTHER = `0x${'33'.repeat(20)}`;
const credential = { credentialId: computeCredentialId(RAW_ID), rawCredentialId: RAW_ID, accountAddress: ACCOUNT, credentialChainId: 100, salt: '123' };
const keys = { publicKeyX: X, publicKeyY: Y };
function fixture() {
  const state = { chain: 100, active: true, accountCode: '0x1234', factoryCode: '0x1234', expected: ACCOUNT, reads: [] };
  const client = { async getChainId() { return state.chain; }, async getBytecode({ address }) { return address === ACCOUNT ? state.accountCode : state.factoryCode; }, async readContract(input) { state.reads.push(input); return input.functionName === 'getCredential' ? { ...keys, active: state.active } : state.expected; } };
  return { state, client };
}
test('missing keys restore only from active credential on observed source chain', async () => {
  const f = fixture(); const restored = await restoreCredentialKeys(credential, { clientForChain: chain => chain === 100 ? f.client : null });
  expect(restored).toMatchObject(keys); expect(f.state.reads[0]).toMatchObject({ address: ACCOUNT, functionName: 'getCredential', args: [credential.credentialId] });
  f.state.active = false; await expect(restoreCredentialKeys(credential, { clientForChain: () => f.client })).rejects.toThrow('verify');
  f.state.chain = 42161; await expect(restoreCredentialKeys(credential, { clientForChain: () => f.client })).rejects.toThrow('verify');
});
test('undeployed account requires code-bearing factory and exact predicted address before initCode', async () => {
  const f = fixture(); f.state.accountCode = '0x';
  const result = await resolveAccountDeployment({ credential: { ...credential, ...keys }, factoryAddress: FACTORY, publicClient: f.client, chainId: 100 });
  expect(result.status).toBe('deployable'); expect(result.initCode.startsWith(FACTORY)).toBe(true);
  expect(await computeCounterfactualAddress(f.client, FACTORY, { ...credential, ...keys })).toBe(ACCOUNT);
  f.state.expected = OTHER; await expect(resolveAccountDeployment({ credential: { ...credential, ...keys }, factoryAddress: FACTORY, publicClient: f.client, chainId: 100 })).rejects.toThrow('verify');
  f.state.expected = ACCOUNT; f.state.factoryCode = '0x'; await expect(resolveAccountDeployment({ credential: { ...credential, ...keys }, factoryAddress: FACTORY, publicClient: f.client, chainId: 100 })).rejects.toThrow('verify');
});
test('an observed empty viem bytecode result remains deployable only with a verified factory and predicted address', async () => {
  const f = fixture(); f.state.accountCode = undefined;
  const result = await resolveAccountDeployment({ credential: { ...credential, ...keys }, factoryAddress: FACTORY, publicClient: f.client, chainId: 100 });
  expect(result.status).toBe('deployable');
  expect(f.state.reads).toEqual([expect.objectContaining({ address: FACTORY, functionName: 'getAddress' })]);
  f.state.factoryCode = undefined;
  await expect(resolveAccountDeployment({ credential: { ...credential, ...keys }, factoryAddress: FACTORY, publicClient: f.client, chainId: 100 })).rejects.toThrow('verify');
});
test.each([null, '', '0x1', '0xzz'])('malformed bytecode %j never authorizes account deployment', async value => {
  const f = fixture(); f.state.accountCode = value;
  await expect(resolveAccountDeployment({ credential: { ...credential, ...keys }, factoryAddress: FACTORY, publicClient: f.client, chainId: 100 })).rejects.toThrow('verify');
  expect(f.state.reads).toHaveLength(0);
});
test('failed/unavailable reads and account switching do not mean absent or deployable', async () => {
  const f = fixture();
  const getBytecode = f.client.getBytecode;
  f.client.getBytecode = async () => { throw new Error('RPC_UNAVAILABLE'); };
  await expect(resolveAccountDeployment({ credential: { ...credential, ...keys }, factoryAddress: FACTORY, publicClient: f.client, chainId: 100 })).rejects.toThrow('RPC_UNAVAILABLE');
  expect(f.state.reads).toHaveLength(0);
  f.client.getBytecode = getBytecode;
  f.state.accountCode = '0x1234'; let current = true;
  f.client.getBytecode = async () => { current = false; return '0x1234'; };
  await expect(resolveAccountDeployment({ credential: { ...credential, ...keys }, factoryAddress: FACTORY, publicClient: f.client, chainId: 100, guard() { if (!current) throw new Error('SCOPE_CHANGED'); } })).rejects.toThrow('SCOPE_CHANGED');
});
test('fresh credential creation composes directly with factory prediction without a fabricated account address', async () => {
  const f = fixture(), created = await createPasskeyCredential('synthetic-user', { rpId: RP, origin: ORIGIN, crypto: CRYPTO,
    adapter: { async startRegistration({ optionsJSON }) { return registrationResponse(optionsJSON); } } });
  expect('accountAddress' in created).toBe(false);
  expect(await computeCounterfactualAddress(f.client, FACTORY, created)).toBe(ACCOUNT);
  expect(f.state.reads[0]).toMatchObject({ functionName: 'getAddress', args: [created.credentialId, X, Y, created.salt] });
});
