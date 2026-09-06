import { describe, it, expect, vi } from 'vitest';
import yargs from 'yargs/yargs';
const mocks = vi.hoisted(() => ({ query: vi.fn(), json: vi.fn() }));
vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('../../src/lib/resolve', () => ({ resolveOrgId: async () => '0xorg', requireModule: vi.fn() }));
vi.mock('../../src/lib/output', () => ({ isJsonMode: () => true, json: mocks.json, table: vi.fn() }));
import { registerVouchCommands } from '../../src/commands/vouch';

describe('native vouch status lookup', () => {
  it('accepts the numeric subject ID shown by org roles and excludes stale epochs', async () => {
    const id = '0xauthority-123';
    const subject = { id, subjectId: '123', name: 'Member', vouchConfig: { epoch: '2', quorum: '1' } };
    mocks.query.mockImplementation(async (document: string) => {
      if (document.includes('AuthoritySubjects')) return { subjects: [subject, { id: 'other', subjectId: '456' }] };
      if (document.includes('AuthorityMemberships')) return { subjectMemberships: [{ id: 'member', user: '0xuser', subject }] };
      return { subjectVouchRecords: [{ id: 'vouch', user: '0xuser', subject, active: true, epoch: '1', config: { epoch: '2' } }] };
    });
    await registerVouchCommands(yargs().exitProcess(false)).parseAsync(['status', '--subject', '123']);
    const result = mocks.json.mock.calls[0][0];
    expect(result.subjects).toEqual([subject]); expect(result.memberships).toHaveLength(1);
    expect(result.vouches[0].active).toBe(false);
  });
});
