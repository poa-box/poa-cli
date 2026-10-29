import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { readSubjectCreationProvenance, recoverSubjectCreationHistory } from '../src/governance/provenance';
import { subjectCreationRaceFacts } from '../src/authority/ids';
import { planRoleCreation, planExistingRoleConfiguration } from '../src/governance/role-planning';
import { knownFact } from '../src/data/facts';

const saved = JSON.parse(readFileSync(new URL('./fixtures/authority-test6-pending.json', import.meta.url), 'utf8'));
const org = saved.organization;
const contracts = { membershipAuthority: org.membershipAuthority.id, email: org.zkEmailInvites.id,
  participationToken: org.participationToken.id, paymentManager: org.paymentManager.id,
  taskManager: org.taskManager.id, executor: org.executorContract.id };
const scope = { chainId: 100, orgId: org.id, contract: org.hybridVoting.id, contracts };
const source = { ...scope, endpoint: 'fixture://saved-index', method: 'exact-proposal', indexed: true,
  snapshot: 'pinned' as const, block: saved.selected, observedAt: 1000 };
const coverage = { status: 'complete' as const, receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
function fixture(record: any) {
  const tx = { ...record.tx, value: ethers.BigNumber.from(record.tx.value) };
  const provider = { getNetwork: vi.fn(async () => ({ chainId: 100 })), getTransaction: vi.fn(async () => tx),
    getTransactionReceipt: vi.fn(async () => record.receipt), getBlock: vi.fn(async (tag: string) => {
      const block = tag.length === 66 ? Object.values(saved.blocks).find((b: any) => b.hash === tag)
        : saved.blocks[BigInt(tag).toString()];
      if (!block) throw new Error('UNRECORDED_BLOCK');
      return { ...(block as any), number: Number((block as any).number), timestamp: Number((block as any).timestamp) };
    }) };
  const query = vi.fn(async () => ({ _meta: { block: { ...saved.selected, number: Number(saved.selected.number), timestamp: Number(saved.selected.timestamp) } },
    organization: org, proposals: [record.row] }));
  return { scope, source, rpcSource: { ...source, indexed: false, endpoint: 'fixture://saved-rpc' },
    proposalId: record.row.proposalId, freshness: { now: 1000, maxAgeSeconds: 0 }, provider: provider as any, query };
}

describe('all 18 retained pending Test6 proposals, exact offline replay', () => {
  it('classifies reviewed bound APIs, retaining unknown legacy/initialization rather than inventing complete history', async () => {
    const proofs = [];
    const unknown = ['6', '13', '18', '20', '23'];
    expect(saved.records).toHaveLength(18);
    expect(new Set(saved.records.map((r: any) => r.row.proposalId)).size).toBe(18);
    for (const record of saved.records) {
      const input = fixture(record);
      const result = await readSubjectCreationProvenance(input);
      if (unknown.includes(record.row.proposalId)) {
        expect(result, record.row.proposalId).toMatchObject({ status: 'blocked', codes: ['INDIRECT_SUBJECT_ALLOCATION_UNPROVEN'] });
      } else {
        expect(result.status, record.row.proposalId).toBe('ready');
        if (result.status === 'ready') {
          expect(result.data.createsSubject).toBe(false);
          expect(result.data.creations).toEqual([]);
          proofs.push(result.data);
        }
      }
      expect(input.provider.getTransaction).toHaveBeenCalledOnce();
      expect(input.provider.getTransactionReceipt).toHaveBeenCalledOnce();
      expect(input.provider.getBlock).toHaveBeenCalledTimes(4);
      expect(input.query).toHaveBeenCalledOnce();
      const document = input.query.mock.calls[0][0];
      for (const field of ['zkEmailInvites', 'participationToken', 'paymentManager', 'taskManager', 'executorContract']) expect(document).toContain(field + ' { id }');
    }
    expect(proofs).toHaveLength(13);
    const history = { source, coverage, data: saved.records.map((r: any) => r.row) };
    const recovered = recoverSubjectCreationHistory(history, proofs);
    expect(recovered.coverage).toBe(coverage);
    expect(recovered.data.filter((r: any) => r.createsSubject === false)).toHaveLength(13);
    expect(subjectCreationRaceFacts(recovered, scope).hasCompetingCreation.state).toBe('unknown');
  });
  it('the actual 18-unsettled shape cannot disable standalone creation or configuring a real allocated ID', () => {
    const authorityScope = { ...scope, contract: contracts.membershipAuthority };
    const subjectId = ((BigInt(contracts.membershipAuthority) << 64n) | 42n).toString();
    const context = { source: { ...source, ...authorityScope, indexed: false, endpoint: 'fixture://saved-rpc' }, coverage,
      data: { readiness: { membershipAuthority: { id: contracts.membershipAuthority, isRouterBound: true, cutoverAt: '1' } },
        executorAuthorized: knownFact(true), subjects: [{ subjectId, kind: 'Role' as const, metadataPointer: ethers.constants.HashZero, imageURI: '', maxMembers: '2', memberCount: '0' }],
        groupEdges: [], accounts: [{ account: saved.records[0].tx.from, acceptedAnywhere: knownFact(true) }] } };
    const common = { scope: authorityScope, freshness: { now: 1000, maxAgeSeconds: 0, block: saved.selected }, context };
    const create = planRoleCreation({ ...common, request: { kind: 'Role', name: 'Independent creation' } });
    expect(create.status).toBe('ready');
    if (create.status === 'ready') expect(create.data).not.toHaveProperty('subjectId');
    const configure = planExistingRoleConfiguration({ ...common, subjectId,
      request: { kind: 'Role', name: 'Actual allocated role', holders: [{ account: saved.records[0].tx.from, sticky: false }] } });
    expect(configure.status).toBe('ready');
    if (configure.status === 'ready') expect(configure.data).toMatchObject({ subjectId, createsSubject: false });
    // These new APIs accept no history input, rather than manufacturing a complete empty one.
    expect(common).not.toHaveProperty('proposals');
    expect(common).not.toHaveProperty('allocations');
  });
  it('rejects missing/mismatched module context and stale canonical observations', async () => {
    const record = saved.records.find((r: any) => r.row.proposalId === '31');
    const input = fixture(record);
    const mismatched = { ...input, scope: { ...scope, contracts: { ...contracts, email: org.participationToken.id } },
      source: { ...source, contracts: { ...contracts, email: org.participationToken.id } },
      rpcSource: { ...input.rpcSource, contracts: { ...contracts, email: org.participationToken.id } } };
    expect(await readSubjectCreationProvenance(mismatched)).toMatchObject({ status: 'blocked', codes: ['PROPOSAL_BINDING_UNPROVEN'] });
    const minimal = { membershipAuthority: contracts.membershipAuthority };
    expect(await readSubjectCreationProvenance({ ...input, scope: { ...scope, contracts: minimal },
      source: { ...source, contracts: minimal }, rpcSource: { ...input.rpcSource, contracts: minimal } })).toMatchObject({ status: 'blocked', codes: ['INDIRECT_SUBJECT_ALLOCATION_UNPROVEN'] });
    const stale = fixture(record);
    expect(await readSubjectCreationProvenance({ ...stale, freshness: { now: 1001, maxAgeSeconds: 0 } })).toMatchObject({ status: 'blocked', codes: ['PROVENANCE_STALE'] });
    expect(stale.provider.getNetwork).not.toHaveBeenCalled();
  });
});
