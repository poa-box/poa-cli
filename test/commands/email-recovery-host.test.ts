import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ source: vi.fn(), provider: vi.fn(), verify: vi.fn(), migrate: vi.fn() }));
vi.mock('../../src/lib/indexed-source', () => ({ createIndexedSource: mocks.source }));
vi.mock('../../src/lib/signer', () => ({ createProvider: mocks.provider }));
vi.mock('../../src/config/networks', () => ({ resolveNetworkConfig: () => ({ resolvedRpc: 'https://rpc.example.org' }) }));
vi.mock('../../src/lib/subgraph', () => ({ redactSubgraphUrl: (url: string) => url }));
vi.mock('@poa-box/core/email/recovery', () => ({ readPendingEmailRecovery: mocks.verify, migratePendingEmailCredential: mocks.migrate }));
import { recoverPendingEmail } from '../../src/commands/zkemail/recover';

const source = { chainId: 100, endpoint: 'fixture://indexed', method: 'indexed', indexed: true, snapshot: 'pinned',
  block: { number: '100', hash: '0x' + '44'.repeat(32) }, observedAt: Math.floor(Date.now() / 1000) };
const input = { scope: { chainId: 100, account: '0x' + '11'.repeat(20), orgId: '0x' + '22'.repeat(32),
  contract: '0x' + '33'.repeat(20), contracts: { registry: '0x' + '55'.repeat(20), factory: '0x' + '66'.repeat(20) } },
  originalTransactionHash: '0x' + '77'.repeat(32), legacy: { username: 'alice' }, rawCredentialBytes: '0x1234' };

describe('read-only pending email recovery host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.source.mockResolvedValue({ source, protocolQuery: vi.fn() });
    mocks.provider.mockReturnValue({ call: vi.fn() });
  });
  it('uses an exact original hash and the same pinned indexed/RPC scope, without migrating an unresolved proof', async () => {
    const blocked = { status: 'blocked', codes: ['EMAIL_RECOVERY_PROOF_UNAVAILABLE'] };
    mocks.verify.mockResolvedValue(blocked);
    expect(await recoverPendingEmail(input)).toEqual({ verification: blocked });
    const args = mocks.verify.mock.calls[0][0];
    expect(args).toMatchObject({ scope: input.scope, legacy: input.legacy, rawCredentialBytes: input.rawCredentialBytes,
      originalTransactionHash: input.originalTransactionHash, source, rpcSource: { ...source, indexed: false, endpoint: 'https://rpc.example.org', method: 'email-recovery-rpc' } });
    expect(mocks.provider).toHaveBeenCalledWith({ chainId: 100, rpcUrl: undefined });
    expect(mocks.migrate).not.toHaveBeenCalled();
  });
  it('does not invent unresolved-submission clearance or write a migrated record', async () => {
    const proof = { status: 'ready', data: { recoveryId: 'verified' } };
    mocks.verify.mockResolvedValue(proof); mocks.migrate.mockReturnValue({ status: 'blocked', codes: ['EMAIL_RECOVERY_SUBMISSION_UNRESOLVED'] });
    const result: any = await recoverPendingEmail({ ...input, migrate: true, legacyRecordId: 'retained-old-record' });
    expect(mocks.migrate.mock.calls[0][0].hasUnresolvedSubmission).toBeUndefined();
    expect(mocks.migrate.mock.calls[0][0].proof).toBe(proof.data);
    expect(result.migration.status).toBe('blocked');
  });
});
