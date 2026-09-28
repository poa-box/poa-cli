import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
const mocks = vi.hoisted(() => ({ context: vi.fn(), confirm: vi.fn(), finish: vi.fn(), execute: vi.fn(), modules: vi.fn(), query: vi.fn(), json: vi.fn() }));
vi.mock('../../src/lib/command', () => ({ getWriteContext: mocks.context, confirmWrite: mocks.confirm, finishWrite: mocks.finish }));
vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.execute }));
vi.mock('../../src/lib/resolve', () => ({ resolveOrgModules: mocks.modules, requireModule: (m: any, k: string) => { if (!m[k]) throw new Error(`Missing ${k}`); return m[k]; } }));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('../../src/lib/output', () => ({ isJsonMode: () => true, json: mocks.json, table: vi.fn() }));
import { permsSetHandler, permsProposeGlobalHandler, permsClearHandler, permsShowHandler } from '../../src/commands/task/perms';
import { AUTHORITY_KEYS, permissionWord, projectContext } from '../../packages/core/src/tx/authority';
const authority = `0x${'11'.repeat(20)}`;
const voting = `0x${'22'.repeat(20)}`;
const taskManager = `0x${'33'.repeat(20)}`;
const orgId = `0x${'ab'.repeat(32)}`;
const modules = { orgId, membershipAuthorityAddress: authority, hybridVotingAddress: voting, taskManagerAddress: taskManager };
const iface = new ethers.utils.Interface(['function setPerm(uint256,bytes32,bytes32,uint256)', 'function clearPerm(uint256,bytes32,bytes32)']);
const argv = { org: 'org', subject: '123', project: ethers.constants.HashZero, perms: 'create,claim', duration: 60, dryRun: true } as any;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({ modules, orgId, signer: new ethers.VoidSigner(authority) });
  mocks.modules.mockResolvedValue(modules); mocks.confirm.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue({ success: true, dryRun: true, logs: [] });
});
function callData() {
  const [contract, method, args, options] = mocks.execute.mock.calls[0];
  expect(contract.address).toBe(voting); expect(method).toBe('createProposal');
  expect(options).toEqual({ dryRun: true });
  expect(args[4][0][0][0]).toBe(authority); expect(args[4][1]).toEqual([]);
  return args[4][0][0][2];
}
describe('task authority permission governance', () => {
  it('project zero is encoded with context one and an existing-row mask', async () => {
    await permsSetHandler.handler(argv);
    const decoded = iface.decodeFunctionData('setPerm', callData());
    expect(decoded[0].toString()).toBe('123'); expect(decoded[1]).toBe(AUTHORITY_KEYS.TM_PERMS);
    expect(decoded[2]).toBe(projectContext(0)); expect(decoded[3].eq(permissionWord(3))).toBe(true);
  });
  it('none writes an explicit zero override and does not remove the row', async () => {
    await permsSetHandler.handler({ ...argv, perms: 'none' });
    expect(iface.decodeFunctionData('setPerm', callData())[3].eq(permissionWord(0))).toBe(true);
  });
  it('clear removes the row and restores inheritance', async () => {
    await permsClearHandler.handler(argv);
    expect(iface.decodeFunctionData('clearPerm', callData())[2]).toBe(projectContext(0));
  });
  it('global grants use context zero', async () => {
    await permsProposeGlobalHandler.handler(argv);
    expect(iface.decodeFunctionData('setPerm', callData())[2]).toBe(ethers.constants.HashZero);
  });
  it('invalid permission names cannot create a proposal', async () => {
    await expect(permsSetHandler.handler({ ...argv, perms: 'admin-everything' })).rejects.toThrow();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('missing governance module fails before any transaction', async () => {
    mocks.context.mockResolvedValue({ modules: { ...modules, hybridVotingAddress: null }, signer: new ethers.VoidSigner(authority) });
    await expect(permsProposeGlobalHandler.handler(argv)).rejects.toThrow('hybridVotingAddress');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('shows only existing current authority permission rows', async () => {
    mocks.query.mockResolvedValue({ permRows: [
      { id: 'a', subject: { subjectId: '123' }, permKey: AUTHORITY_KEYS.TM_PERMS, ctx: ethers.constants.HashZero, exists: true, value: '3', inheritGlobal: false },
      { id: 'b', subject: { subjectId: '456' }, permKey: AUTHORITY_KEYS.TM_PERMS, ctx: ethers.constants.HashZero, exists: false, value: '7' },
    ] });
    await permsShowHandler.handler(argv);
    const data = mocks.json.mock.calls[0][0];
    expect(data.global).toHaveLength(1); expect(data.global[0]).toMatchObject({ hatId: '123', mask: 3 });
    expect(data._source).toBe('membership-authority');
  });
});

it('an adopted uint256 subject keeps the governance title inside 256 bytes without shortening calldata', async () => {
  const subject = ethers.constants.MaxUint256.toString();
  await permsSetHandler.handler({ ...argv, subject, perms: 'create,claim,review,assign,self-review,budget,edit-meta,edit-full' });
  const args = mocks.execute.mock.calls[0][2];
  expect(ethers.utils.arrayify(args[0]).length).toBeLessThanOrEqual(256);
  expect(iface.decodeFunctionData('setPerm', callData())[0].toString()).toBe(subject);
  expect(mocks.confirm.mock.calls[0][1].args).toContain(subject);
});
