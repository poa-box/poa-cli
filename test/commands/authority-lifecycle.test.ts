import { beforeEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs/yargs';
import { ethers } from 'ethers';
const mocks = vi.hoisted(() => ({ query: vi.fn(), json: vi.fn(), execute: vi.fn(), finish: vi.fn(), context: vi.fn() }));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('../../src/lib/resolve', () => ({ resolveOrgId: async () => 'org', requireModule: (modules: any, key: string) => modules[key] }));
vi.mock('../../src/lib/command', () => ({ getWriteContext: mocks.context, confirmWrite: vi.fn(), finishWrite: mocks.finish }));
vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.execute }));
vi.mock('../../src/lib/output', () => ({ isJsonMode: () => true, json: mocks.json, table: vi.fn() }));
import { registerRoleCommands } from '../../src/commands/role';
import { registerGroupCommands } from '../../src/commands/group';

const target = `0x${'11'.repeat(20)}`;
const other = `0x${'22'.repeat(20)}`;
const role = { id: '7', subjectId: '7', kind: 'Role', name: 'Member' };
const group = { id: '8', subjectId: '8', kind: 'Group', name: 'Team', memberRoles: [{ role }, { role: { id: '9' } }] };

beforeEach(() => vi.clearAllMocks());

describe('authority lifecycle CLI', () => {
  it('lists and filters delegated review windows without broadcasting and retains terminal history on request', async () => {
    const actions = [
      { id: 'a', pendingId: '1', action: 'Offer', status: 'Pending', user: target, subject: role, activatesAt: '123' },
      { id: 'b', pendingId: '2', action: 'Remove', status: 'Cancelled', user: target, subject: role, activatesAt: '124' },
      { id: 'c', pendingId: '3', action: 'Grant', status: 'Pending', user: other, subject: role, activatesAt: '125' },
    ];
    mocks.query.mockResolvedValue({ pendingActions: actions });
    await registerRoleCommands(yargs().exitProcess(false)).parseAsync(['pending', '--subject', '7', '--user', target]);
    expect(mocks.json.mock.calls[0][0].pendingActions).toEqual([actions[0]]);
    await registerRoleCommands(yargs().exitProcess(false)).parseAsync(['pending', '--all', '--user', target]);
    expect(mocks.json.mock.calls[1][0].pendingActions).toEqual(actions.slice(0, 2));
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('derives group members from active role memberships without double-counting wallets', async () => {
    mocks.query.mockImplementation(async (document: string) => {
      if (document.includes('AuthoritySubjects')) return { subjects: [role, group] };
      if (document.includes('AuthorityMemberships')) return { subjectMemberships: [
        { id: 'a', subject: role, user: target, isMember: true },
        { id: 'b', subject: { id: '9' }, user: target.toUpperCase(), isMember: true },
        { id: 'c', subject: role, user: other, isMember: false },
      ] };
      if (document.includes('AuthorityPerms')) return { permRows: [{ id: 'p', subject: group, exists: true }, { id: 'q', subject: group, exists: false }] };
      return { pendingActions: [] };
    });
    await registerGroupCommands(yargs().exitProcess(false)).parseAsync(['view', '--group', '8']);
    expect(mocks.json.mock.calls[0][0]).toMatchObject({ members: [target], permissions: [{ id: 'p' }] });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('returns the on-chain pending ID and activation time required to continue delegation', async () => {
    mocks.context.mockResolvedValue({ modules: { membershipAuthorityAddress: other }, orgId: ethers.constants.HashZero,
      signer: new ethers.VoidSigner(target) });
    mocks.execute.mockResolvedValue({ logs: [{ name: 'PendingActionCreated', args: {
      pendingId: ethers.BigNumber.from(42), activatesAt: ethers.BigNumber.from(123),
    } }] });
    await registerRoleCommands(yargs().exitProcess(false)).parseAsync(['delegate-offer', '--subject', '7', '--user', target]);
    expect(mocks.finish.mock.calls[0][1].fields).toMatchObject({ subjectId: '7', pendingId: '42', activatesAt: '123' });
  });

  it('lets governance cancel a pending action through an executor proposal instead of requiring a manager wallet', async () => {
    mocks.context.mockResolvedValue({ modules: { membershipAuthorityAddress: other, hybridVotingAddress: target },
      orgId: ethers.constants.HashZero, signer: new ethers.VoidSigner(target) });
    mocks.execute.mockResolvedValue({ logs: [] });
    await registerRoleCommands(yargs().exitProcess(false)).parseAsync(['cancel', '--pending', '42', '--governance']);
    const [contract, method, args] = mocks.execute.mock.calls[0];
    expect(contract.address).toBe(target);
    expect(method).toBe('createProposal');
    const [call] = args[4][0];
    expect(call[0]).toBe(other);
    expect(call[2]).toBe(new ethers.utils.Interface(['function cancel(uint256)']).encodeFunctionData('cancel', [42]));
  });
});
