import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ethers } from 'ethers';
const mocks = vi.hoisted(() => ({ evidence: vi.fn(), context: vi.fn(), getWriteContext: vi.fn(), confirmWrite: vi.fn(), executeTx: vi.fn(), json: vi.fn() }));
vi.mock('../../src/commands/role/evidence', () => ({ readRoleEvidence: mocks.evidence, rolePlanningContext: mocks.context }));
vi.mock('../../src/lib/command', () => ({ getWriteContext: mocks.getWriteContext, confirmWrite: mocks.confirmWrite, finishWrite: vi.fn() }));
vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.executeTx }));
vi.mock('../../src/lib/output', () => ({ isJsonMode: () => true, json: mocks.json }));
import { rolePlanHandler } from '../../src/commands/role/plan';
import { planRoleCreation } from '@poa-box/core/governance/role-planning';
import { knownFact } from '@poa-box/core/data/facts';
const AUTH = `0x${'11'.repeat(20)}`, HV = `0x${'22'.repeat(20)}`, EXEC = `0x${'33'.repeat(20)}`, ORG = `0x${'44'.repeat(32)}`;
const HASH = `0x${'55'.repeat(32)}`;
const scope = { chainId: 100, orgId: ORG, contract: AUTH, contracts: { membershipAuthority: AUTH, hybridVoting: HV, executor: EXEC } };
const source = { ...scope, indexed: false, snapshot: 'pinned' as const, endpoint: 'fixture://rpc', method: 'preflight',
  block: { number: '100', hash: HASH }, observedAt: 1000 };
const coverage = { status: 'complete' as const, receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
let directory: string, file: string;
function context() { return { source, coverage, data: { readiness: { membershipAuthority: { id: AUTH, isRouterBound: true, cutoverAt: '1' } },
  executorAuthorized: knownFact(true, source), subjects: [{ subjectId: '7', kind: 'Role' as const, metadataPointer: ethers.constants.HashZero, imageURI: '', maxMembers: '1', memberCount: '0' }], groupEdges: [], accounts: [] } }; }
function evidence() { return { scope, rpcSource: source, freshness: { now: 1000, maxAgeSeconds: 30, block: source.block }, snapshot: { source: { ...source, indexed: true }, data: {} } }; }
function write(request: unknown) { fs.writeFileSync(file, JSON.stringify(request)); }
beforeEach(() => {
  vi.clearAllMocks(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'role-planning-')); file = path.join(directory, 'request.json');
  mocks.evidence.mockImplementation(async () => evidence()); mocks.context.mockImplementation(async () => context());
  mocks.getWriteContext.mockResolvedValue({ orgId: ORG, chainId: 100, signer: ethers.Wallet.createRandom(), address: `0x${'66'.repeat(20)}` });
  mocks.executeTx.mockResolvedValue({ success: true, dryRun: true });
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
describe('role planning CLI adoption', () => {
  it('plans creation alone without inventing a subject ID, signing or sending', async () => {
    write({ kind: 'Role', name: 'New role' });
    await rolePlanHandler('Role').handler({ file });
    const result = mocks.json.mock.calls[0][0];
    expect(result.plan.status).toBe('ready'); expect(result.plan.data).not.toHaveProperty('subjectId');
    expect(result.plan.data.batch).toHaveLength(1);
    expect(mocks.getWriteContext).not.toHaveBeenCalled(); expect(mocks.executeTx).not.toHaveBeenCalled();
  });
  it('rejects file-supplied evidence and dependent configuration on creation', async () => {
    write({ kind: 'Role', name: 'Untrusted', context: { executorAuthorized: true } });
    await expect(rolePlanHandler('Role').handler({ file })).rejects.toThrow('evidence field context');
    expect(mocks.evidence).not.toHaveBeenCalled();
    write({ kind: 'Role', name: 'New role', defaultAllow: true });
    await rolePlanHandler('Role').handler({ file });
    expect(mocks.json.mock.calls[0][0].plan.codes).toContain('CREATION_HAS_DEPENDENT_CONFIGURATION');
  });
  it('keeps unavailable authority and incomplete context blocked, without requesting a signer', async () => {
    write({ kind: 'Role', name: 'New role' });
    mocks.context.mockResolvedValue({ ...context(), coverage: { ...coverage, status: 'incomplete', missingIds: ['subjects'] } });
    await rolePlanHandler('Role').handler({ file });
    expect(mocks.json.mock.calls[0][0].plan.status).toBe('blocked');
    expect(mocks.getWriteContext).not.toHaveBeenCalled();
  });
  it('rejects unreviewed or changed plans before broadcasting and requires destructive consent', async () => {
    const request = { kind: 'Role' as const, name: 'Reviewed role' }; write(request);
    const plan = planRoleCreation({ scope, freshness: evidence().freshness, context: context(), request });
    if (plan.status !== 'ready') throw new Error('fixture');
    await expect(rolePlanHandler('Role', true).handler({ file, expectedFingerprint: 'wrong', duration: 60 })).rejects.toThrow('STALE_ROLE_PLAN');
    expect(mocks.getWriteContext).not.toHaveBeenCalled();
    mocks.context.mockResolvedValueOnce(context()).mockResolvedValueOnce({ ...context(), data: { ...context().data, subjects: [] } });
    await expect(rolePlanHandler('Role', true).handler({ file, expectedFingerprint: plan.data.fingerprint, duration: 60 })).rejects.toThrow('STALE_ROLE_PLAN');
    expect(mocks.confirmWrite).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ destructive: true }));
    expect(mocks.executeTx).not.toHaveBeenCalled();
  });
  it('submits only after the reviewed fingerprint survives a second fresh observation', async () => {
    const request = { kind: 'Role' as const, name: 'Reviewed role' }; write(request);
    const plan = planRoleCreation({ scope, freshness: evidence().freshness, context: context(), request });
    if (plan.status !== 'ready') throw new Error('fixture');
    await rolePlanHandler('Role', true).handler({ file, expectedFingerprint: plan.data.fingerprint, duration: 60, dryRun: true });
    expect(mocks.evidence).toHaveBeenCalledTimes(2); expect(mocks.context).toHaveBeenCalledTimes(2);
    expect(mocks.executeTx).toHaveBeenCalledWith(expect.anything(), 'createProposal', expect.anything(), { dryRun: true });
  });
});
