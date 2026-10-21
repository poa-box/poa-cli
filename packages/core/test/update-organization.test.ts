import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { join } from 'path';
import oracleAbi from './fixtures/core-update/organization/org-deployer-abi.json';
import legacy from './fixtures/core-update/organization/legacy-deployment.json';
import { buildOrgDeployMetadata, mergeOrgMetadata, requireRawOrgMetadata, resolveTokenLabel, serializeOrgMetadata } from '../src/metadata/org';
import { buildTokenRequestMetadata, buildTokenRequestMetadataAtSeconds, serializeTokenRequestMetadata } from '../src/metadata/token';
import { buildBootstrapConfig, type BootstrapConfigInput } from '../src/deployment/bootstrap';
import { parseDeployerSemVer, requireSupportedDeployerVersion, selectDeploymentEntrypoint, validateParticipationTokenText, requireDeploymentModuleAddresses } from '../src/deployment/policy';
import { pinJson, pinFile, fetchJson, type ContentService, type IpfsOptions } from '../src/ipfs';
import { bytes32ToCidV0 } from '../src/encoding/cid';
import { buildDeployFullOrg, buildDeployFullOrgWithZkEmail, buildDeploymentParams, deployFullOrgIntent, updateOrgMetaIntent, validateOrgDeployConfig, requireAuthorityDeployerVersion, type OrgDeployConfig } from '../src/tx/org';
import { encodeIntent } from '../src/tx/intent';
import { encodeProjectStruct } from '../src/tx/project';
import { buildGovernanceProposal } from '../src/tx/governance';
import { createModuleIntent } from '../src/tx/education';
import { setProfileMetadataIntent } from '../src/tx/user';
import { createProposalIntent } from '../src/tx/vote';
import { createTaskIntent } from '../src/tx/task';
import type { PopContext } from '../src/context';
import { EXIT } from '../src/exit-codes';

const mocks = vi.hoisted(() => ({ readContract: vi.fn(), resolveOrgId: vi.fn(), resolveOrgModules: vi.fn() }));
vi.mock('../src/contracts', async importOriginal => ({ ...await importOriginal<typeof import('../src/contracts')>(), createReadContract: mocks.readContract }));
vi.mock('../src/reads/resolve', async importOriginal => ({ ...await importOriginal<typeof import('../src/reads/resolve')>(), resolveOrgId: mocks.resolveOrgId, resolveOrgModules: mocks.resolveOrgModules }));

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const ORG = legacy.resolved.orgId;
const HASH = legacy.resolved.metadataHash;
const ZERO = ethers.constants.HashZero;
const CID = bytes32ToCidV0(HASH);
const oracle = new ethers.utils.Interface(oracleAbi);
const config = (): OrgDeployConfig => structuredClone(legacy.config) as OrgDeployConfig;
const resolved = () => ({ ...legacy.resolved });
const service = () => ({ pinJson: vi.fn().mockResolvedValue(CID), pinFile: vi.fn().mockResolvedValue(CID), fetchJson: vi.fn().mockResolvedValue({ description: 'old', logo: 'old', template: 'worker-coop', extension: { privateRoot: HASH }, id: 'raw-extension', useTokenSymbol: false, taskPayoutHoursOnly: true, taskPayoutHourlyRate: 12.5 }) });
const infra = { poaManagerContracts: [{ orgRegistryProxy: A, orgDeployerProxy: A, globalAccountRegistryProxy: B }] };
function context(storage = service(), pointer: unknown = HASH, indexed: unknown = null) {
  const query = vi.fn().mockResolvedValueOnce(infra).mockResolvedValueOnce({ organization: { name: 'Original', metadataHash: pointer, metadata: indexed } });
  const ctx = { chainId: 100, client: { query }, ipfs: { service: storage } } as unknown as PopContext;
  return { ctx, storage, query };
}
function organizationContext(organization: unknown) {
  const result = context();
  result.query.mockReset().mockResolvedValueOnce(infra).mockResolvedValueOnce({ organization });
  return result;
}
function deployment(storage = service(), overrides: Partial<PopContext> = {}) {
  const query = vi.fn().mockResolvedValue(infra);
  const ctx = { chainId: 100, provider: {}, client: { query }, ipfs: { service: storage }, ...overrides } as PopContext;
  const signer = { _signTypedData: vi.fn().mockResolvedValue('0x') };
  return { ctx, storage, query, signer };
}
function bootstrap(): BootstrapConfigInput {
  return {
    projects: [
      { title: 'Project A', metadataHash: CID, cap: { decimal: '20', decimals: 18 }, managers: [A, B], createRoleIndices: [1, 0], claimRoleIndices: [0], reviewRoleIndices: [1], assignRoleIndices: [1], bountyTokens: [B], bountyCaps: [{ decimal: '3.000001', decimals: 6 }] },
      { title: 'Project B', metadataHash: HASH, cap: { raw: 0 }, managers: [B], claimRoleIndices: [1] },
    ],
    tasks: [
      { projectIndex: 1, title: 'Task 1', metadataHash: CID, payout: { decimal: '0.125', decimals: 18 } },
      { projectIndex: 0, title: 'Task 2', metadataHash: HASH, payout: { decimal: '1.75', decimals: 18 }, bountyToken: B, bountyPayout: { decimal: '1.000001', decimals: 6 }, requiresApplication: true },
      { projectIndex: 1, title: 'Task 3', payout: { raw: '9007199254740993' } },
    ],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network forbidden'); }));
  mocks.resolveOrgId.mockResolvedValue(ORG);
  mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG, orgName: 'Fixture', taskManagerAddress: A, educationHubAddress: A, hybridVotingAddress: A, directDemocracyVotingAddress: B });
  mocks.readContract.mockImplementation((_address: string, name: string) => name === 'OrgDeployerNew'
    ? { VERSION: vi.fn().mockResolvedValue('2.0.0') } : { nonces: vi.fn().mockResolvedValue(ethers.BigNumber.from(7)) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('ORG-UNREADABLE-WRITE raw-base refusal', () => {
  for (const indexed of [null, {}, { description: 'projection-only' }]) {
    for (const raw of ['reject', null, [], 'scalar', 0, false, 'invalid JSON']) {
      it(`refuses positive pointer indexed=${JSON.stringify(indexed)} raw=${JSON.stringify(raw)} before logo/JSON pins`, async () => {
        const s = service();
        if (raw === 'reject') s.fetchJson.mockRejectedValue(new Error('gateway unavailable'));
        else s.fetchJson.mockResolvedValue(raw);
        const { ctx } = context(s, HASH, indexed);
        await expect(updateOrgMetaIntent(ctx, { org: ORG, description: 'new', logo: new Uint8Array([1]) })).rejects.toMatchObject({ code: EXIT.INFRA });
        expect(s.fetchJson).toHaveBeenCalledTimes(1);
        expect(s.pinFile).not.toHaveBeenCalled(); expect(s.pinJson).not.toHaveBeenCalled(); expect(mocks.readContract).not.toHaveBeenCalled();
      });
    }
  }
  for (const indexed of [null, {}, { description: 'indexed', extension: 'display projection' }]) {
    it.each(['omitted', 'undefined'] as const)(`refuses %s pointer evidence with indexed=${JSON.stringify(indexed)} before content callbacks`, async mode => {
      const organization: Record<string, unknown> = { name: 'Original', metadata: indexed };
      if (mode === 'undefined') organization.metadataHash = undefined;
      const { ctx, storage } = organizationContext(organization);
      await expect(updateOrgMetaIntent(ctx, { org: ORG, description: 'new', logo: new Uint8Array([1]) })).rejects.toMatchObject({ code: EXIT.INFRA });
      expect(storage.fetchJson).not.toHaveBeenCalled();
      expect(storage.pinFile).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled();
    });
  }
  it.each([0, false, {}, []])('refuses malformed pointer evidence %s before content callbacks', async metadataHash => {
    const { ctx, storage } = organizationContext({ name: 'Original', metadataHash });
    await expect(updateOrgMetaIntent(ctx, { org: ORG, logo: new Uint8Array([1]) })).rejects.toMatchObject({ code: EXIT.INFRA });
    expect(storage.fetchJson).not.toHaveBeenCalled();
    expect(storage.pinFile).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled();
  });
  it('does not treat an inherited empty pointer as evidence from the fetched row', async () => {
    const organization = Object.assign(Object.create({ metadataHash: null }), { name: 'Original' });
    const { ctx, storage } = organizationContext(organization);
    await expect(updateOrgMetaIntent(ctx, { org: ORG, logo: new Uint8Array([1]) })).rejects.toMatchObject({ code: EXIT.INFRA });
    expect(storage.fetchJson).not.toHaveBeenCalled();
    expect(storage.pinFile).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled();
  });
  it('requires pointer evidence even when the caller deliberately replaces the name', async () => {
    const { ctx, storage } = organizationContext({ name: 'Original', metadata: { template: 'indexed' } });
    await expect(updateOrgMetaIntent(ctx, { org: ORG, name: 'Replacement', logo: new Uint8Array([1]) })).rejects.toMatchObject({ code: EXIT.INFRA });
    expect(storage.fetchJson).not.toHaveBeenCalled();
    expect(storage.pinFile).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled();
  });
  it.each([null, '', ZERO, '0x0', '0X0000'])('initializes an explicitly established empty/zero pointer %s without treating indexed display as raw', async pointer => {
    const { ctx, storage } = context(service(), pointer, { lostExtension: 'display projection', id: 'entity' });
    const intent = await updateOrgMetaIntent(ctx, { org: ORG, description: '' });
    expect(storage.fetchJson).not.toHaveBeenCalled(); expect(storage.pinJson).toHaveBeenCalledTimes(1);
    expect(intent.meta.ipfs?.metadata).toMatchObject({ description: '', template: 'default', logo: null });
    expect(intent.meta.ipfs?.metadata).not.toHaveProperty('id');
    expect(intent.meta.ipfs?.metadata).not.toHaveProperty('lostExtension');
    expect(ethers.utils.toUtf8String(intent.args[1] as Uint8Array)).toBe('Original');
  });
  it.each([HASH, CID])('preserves raw extensions/template for %s including keys named like indexed bookkeeping', async pointer => {
    const { ctx, storage } = context(service(), pointer, { template: 'display', extension: { privateRoot: ZERO } });
    const intent = await updateOrgMetaIntent(ctx, { org: ORG, description: 'new' });
    expect(ethers.utils.toUtf8String(intent.args[1] as Uint8Array)).toBe('Original');
    expect(intent.meta.ipfs?.metadata).toMatchObject({ template: 'worker-coop', logo: 'old', extension: { privateRoot: HASH }, id: 'raw-extension' });
    expect(storage.fetchJson).toHaveBeenCalledTimes(1); expect(storage.fetchJson).toHaveBeenCalledWith(pointer);
    expect(storage.pinJson).toHaveBeenCalledTimes(1); expect(storage.pinFile).not.toHaveBeenCalled();
  });
  it.each([
    ['omitted', {}], ['undefined', { name: undefined }], ['null', { name: null }],
    ['number', { name: 0 }], ['boolean', { name: false }],
  ] as const)('refuses an unknown current name (%s) before content callbacks when preserving it', async (_label, nameFields) => {
    const { ctx, storage } = organizationContext({ metadataHash: HASH, ...nameFields });
    await expect(updateOrgMetaIntent(ctx, { org: ORG, description: 'new', logo: new Uint8Array([1]) })).rejects.toMatchObject({ code: EXIT.INFRA });
    expect(storage.fetchJson).not.toHaveBeenCalled();
    expect(storage.pinFile).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled();
  });
  it('an empty replacement name keeps the legacy preservation policy and requires a known current name', async () => {
    const { ctx, storage } = organizationContext({ metadataHash: null });
    await expect(updateOrgMetaIntent(ctx, { org: ORG, name: '', logo: new Uint8Array([1]) })).rejects.toMatchObject({ code: EXIT.INFRA });
    expect(storage.fetchJson).not.toHaveBeenCalled();
    expect(storage.pinFile).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled();
  });
  it('does not infer a current name from the query input or an inherited field', async () => {
    const { ctx, storage } = organizationContext(Object.assign(Object.create({ name: 'Inherited' }), { metadataHash: null }));
    await expect(updateOrgMetaIntent(ctx, { org: 'Lookup Name', description: 'new', logo: new Uint8Array([1]) })).rejects.toMatchObject({ code: EXIT.INFRA });
    expect(storage.fetchJson).not.toHaveBeenCalled();
    expect(storage.pinFile).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled();
  });
  it.each([
    ['omitted', {}], ['undefined', { name: undefined }], ['null', { name: null }],
    ['number', { name: 0 }], ['boolean', { name: false }],
  ] as const)('allows a deliberate valid rename when the current name is unknown (%s)', async (_label, nameFields) => {
    const { ctx, storage } = organizationContext({ metadataHash: HASH, ...nameFields });
    const intent = await updateOrgMetaIntent(ctx, { org: ORG, name: 'Deliberate Réname' });
    const registryOracle = new ethers.utils.Interface(['function updateOrgMetaAsAdmin(bytes32 orgId, bytes name, bytes32 metadataHash)']);
    const decoded = registryOracle.decodeFunctionData('updateOrgMetaAsAdmin', encodeIntent(intent).data);
    expect(decoded.orgId).toBe(ORG); expect(ethers.utils.toUtf8String(decoded.name)).toBe('Deliberate Réname'); expect(decoded.metadataHash).toBe(HASH);
    expect(intent.meta.ipfs?.metadata).toMatchObject({ template: 'worker-coop', extension: { privateRoot: HASH } });
    expect(storage.fetchJson).toHaveBeenCalledTimes(1); expect(storage.pinJson).toHaveBeenCalledTimes(1); expect(storage.pinFile).not.toHaveBeenCalled();
  });
  it.each([['Original', '', 'Original'], ['', undefined, '']] as const)('keeps known current name %s with replacement %s as %s', async (currentName, name, expected) => {
    const { ctx } = organizationContext({ name: currentName, metadataHash: null });
    const intent = await updateOrgMetaIntent(ctx, { org: ORG, name, description: 'new' });
    expect(ethers.utils.toUtf8String(intent.args[1] as Uint8Array)).toBe(expected);
  });
  it('refuses unknown organizations before storage callbacks', async () => {
    const { ctx, storage, query } = context(); query.mockReset().mockResolvedValueOnce(infra).mockResolvedValueOnce({ organization: null });
    await expect(updateOrgMetaIntent(ctx, { org: ORG, description: 'new' })).rejects.toMatchObject({ code: EXIT.INFRA });
    expect(storage.fetchJson).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled();
  });
  it.each([null, [], 'bad', 1, new Date(0)])('pure raw-base validator rejects non-JSON-object %s', raw => {
    expect(() => requireRawOrgMetadata(raw)).toThrow();
  });
});

describe('ORG-LOGO-CLEAR / ORG-METADATA-FIELDS / SETTINGS-EXTENSIONS', () => {
  const raw = { description: 'old', logo: 'old', template: 'worker-coop', extension: { keep: true }, useTokenSymbol: true, taskPayoutHoursOnly: true, taskPayoutHourlyRate: '12.5' };
  it('preserves the historical merged canonical key order when extensions/options are omitted', () => {
    expect(serializeOrgMetadata(mergeOrgMetadata({}, {}))).toBe('{"description":"","links":[],"template":"default","logo":null,"backgroundColor":null,"hideTreasury":false,"useTokenSymbol":false,"taskPayoutHoursOnly":false,"taskPayoutHourlyRate":null}');
  });
  it.each([[undefined, 'old'], ['replacement', 'replacement'], [null, null], ['', null]] as const)('pure logo edit %s -> %s', (logoCid, expected) => {
    const result = mergeOrgMetadata(raw, { logoCid });
    expect(result.logo).toBe(expected); expect(result.extension).toEqual({ keep: true }); expect(result.taskPayoutHourlyRate).toBe(12.5);
  });
  it.each([null, ''] as const)('resolved clear-only logo %s counts as supplied', async logoCid => {
    const { ctx, storage } = context(); const intent = await updateOrgMetaIntent(ctx, { org: ORG, logoCid });
    expect(intent.meta.ipfs?.metadata).toMatchObject({ logo: null, extension: { privateRoot: HASH } });
    expect(storage.pinJson).toHaveBeenCalledTimes(1); expect(storage.pinFile).not.toHaveBeenCalled();
  });
  it('keeps description-only logo, pins replacement bytes once, and forwards exact preferences/staged allowlist', async () => {
    const { ctx, storage } = context();
    const staged = { root: HASH, cid: CID, roleIndexes: [1] };
    const intent = await updateOrgMetaIntent(ctx, { org: ORG, logo: new Uint8Array([9]), useTokenSymbol: false, taskPayoutHoursOnly: false, taskPayoutHourlyRate: 0, zkEmailAllowlist: staged, extensions: { custom: { untouched: true } } });
    expect(storage.pinFile).toHaveBeenCalledTimes(1); expect(storage.pinJson).toHaveBeenCalledTimes(1);
    expect(intent.meta.ipfs?.metadata).toMatchObject({ logo: CID, useTokenSymbol: false, taskPayoutHoursOnly: false, taskPayoutHourlyRate: 0, zkEmailAllowlist: staged, custom: { untouched: true }, extension: { privateRoot: HASH } });
    expect(JSON.parse(storage.pinJson.mock.calls[0][0]).taskPayoutHourlyRate).toBe(0);
  });
  it.each([false, true])('explicit %s preferences replace opposite values', flag => {
    const result = mergeOrgMetadata({ ...raw, useTokenSymbol: !flag, taskPayoutHoursOnly: !flag }, { useTokenSymbol: flag, taskPayoutHoursOnly: flag });
    expect(result.useTokenSymbol).toBe(flag); expect(result.taskPayoutHoursOnly).toBe(flag);
  });
  it('numeric rate patch and null clears survive while extension keys cannot shadow canonical edits', () => {
    const result = mergeOrgMetadata(raw, { taskPayoutHourlyRate: '12.5', zkEmailAllowlist: { root: HASH }, extensions: { logo: 'shadow', useTokenSymbol: false, newField: 1 } });
    expect(result.logo).toBe('old'); expect(result.useTokenSymbol).toBe(true); expect(result.taskPayoutHourlyRate).toBe(12.5);
    expect(mergeOrgMetadata(result, { taskPayoutHourlyRate: null, zkEmailAllowlist: null })).toMatchObject({ taskPayoutHourlyRate: null, zkEmailAllowlist: null, newField: 1 });
  });
  it.each([[undefined, 'MiXeD', 'Shares'], [null, 'MiXeD', 'Shares'], [false, 'MiXeD', 'Shares'], [true, 'MiXeD', 'MiXeD'], [true, '  ', 'Shares'], [true, ' MiXeD ', 'MiXeD']] as const)('label %s/%s preserves case/default %s', (useTokenSymbol, symbol, expected) => {
    expect(resolveTokenLabel({ useTokenSymbol, symbol })).toBe(expected);
  });
  it.each(['NaN', '', Infinity, true])('invalid rate %s refuses before logo upload', async rate => {
    const { ctx, storage } = context();
    await expect(updateOrgMetaIntent(ctx, { org: ORG, logo: new Uint8Array([1]), taskPayoutHourlyRate: rate as any })).rejects.toThrow();
    expect(storage.pinFile).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled();
  });
  it('nonserializable patch refuses before a logo publication', async () => {
    const circular: any = {}; circular.self = circular; const { ctx, storage } = context();
    await expect(updateOrgMetaIntent(ctx, { org: ORG, logo: new Uint8Array([1]), extensions: circular })).rejects.toThrow();
    expect(storage.pinFile).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled();
  });
});

describe('DEPLOY-METADATA-INPUT fresh/prepared metadata parity', () => {
  it('keeps historical six-key bytes when all options are omitted', () => {
    // Strict noEmit of this test also protects old consumers' narrowed null fields.
    const oldLogo: null = buildOrgDeployMetadata({ description: 'old' }).logo;
    const oldBackground: null = buildOrgDeployMetadata({}).backgroundColor;
    expect(oldLogo).toBeNull(); expect(oldBackground).toBeNull();
    expect(serializeOrgMetadata(buildOrgDeployMetadata({}))).toBe('{"description":"","links":[],"template":"default","logo":null,"backgroundColor":null,"hideTreasury":false}');
    expect(serializeOrgMetadata(buildOrgDeployMetadata({ description: 'old', links: [{ name: 'Home', url: 'https://example.test' }] }))).toBe('{"description":"old","links":[{"name":"Home","url":"https://example.test","index":0}],"template":"default","logo":null,"backgroundColor":null,"hideTreasury":false}');
  });
  it('writes selected fields in canonical order and preserves extensions', () => {
    expect(serializeOrgMetadata(buildOrgDeployMetadata({ description: 'selected', template: 'worker-coop', logoCid: CID, backgroundColor: '#123', hideTreasury: true, useTokenSymbol: true, taskPayoutHourlyRate: '12.5', extensions: { extension: { keep: true } } }))).toBe(`{"description":"selected","links":[],"template":"worker-coop","logo":"${CID}","backgroundColor":"#123","hideTreasury":true,"useTokenSymbol":true,"taskPayoutHourlyRate":12.5,"extension":{"keep":true}}`);
  });
  it.each([undefined, CID, HASH])('prepared document pointer %s retains metadata with no duplicate publication', async pointer => {
    const { ctx, storage, signer } = deployment();
    const document = { description: 'selected', links: [], template: 'worker-coop', logo: CID, backgroundColor: null, hideTreasury: true, useTokenSymbol: true, symbol: 'MiXeD', extension: { keep: true } };
    const intent = await deployFullOrgIntent(ctx, { config: config(), deployerAddress: A, signer, regDeadline: 1700000000, preparedMetadata: { document, pointer } });
    const decoded = oracle.decodeFunctionData('deployFullOrg', encodeIntent(intent).data)[0];
    expect(decoded.metadataHash).toBe(HASH); expect(intent.meta.ipfs?.metadata).toEqual(document);
    expect(storage.pinJson).toHaveBeenCalledTimes(pointer === undefined ? 1 : 0);
    if (pointer === undefined) expect(storage.pinJson).toHaveBeenCalledWith(JSON.stringify(document));
    expect(signer._signTypedData).toHaveBeenCalledTimes(1);
  });
  it('resolved selected metadata uploads once and enters the encoded tuple', async () => {
    const { ctx, storage, signer } = deployment(); const c = config(); c.metadata = { template: 'worker-coop', logoCid: CID, hideTreasury: true, useTokenSymbol: true };
    const intent = await deployFullOrgIntent(ctx, { config: c, deployerAddress: A, signer, regDeadline: 1700000000 });
    expect(storage.pinJson).toHaveBeenCalledTimes(1); expect(storage.pinFile).not.toHaveBeenCalled();
    expect(oracle.decodeFunctionData('deployFullOrg', encodeIntent(intent).data)[0].metadataHash).toBe(HASH);
    expect(intent.meta.ipfs?.metadata).toMatchObject(c.metadata && { template: 'worker-coop', logo: CID, hideTreasury: true, useTokenSymbol: true });
  });
  it.each([null, [], 'not-json', 1])('invalid prepared document %s fails before reads, pins and signer callbacks', async document => {
    const { ctx, storage, signer, query } = deployment();
    await expect(deployFullOrgIntent(ctx, { config: config(), deployerAddress: A, signer, preparedMetadata: { document: document as any, pointer: CID } })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled(); expect(signer._signTypedData).not.toHaveBeenCalled();
  });
});

describe('DEPLOY-BOOTSTRAP / DEPLOY-TEMPLATES authority genesis', () => {
  it('matches the independently stored recursive ABI, project/task order and PT18/bounty6 literals', () => {
    const c = config(); c.roles.push({ name: 'Manager', open: false, canVote: true }); c.groups = [{ name: 'All', memberRoleIndices: [0, 1] }]; c.bootstrap = bootstrap();
    const params = buildDeploymentParams(c, resolved());
    const decoded = oracle.decodeFunctionData('deployFullOrg', encodeIntent(buildDeployFullOrg({ orgDeployerAddress: A, deployParams: params })).data)[0];
    expect(decoded.bootstrap.projects.map((p: any) => ethers.utils.toUtf8String(p.title))).toEqual(['Project A', 'Project B']);
    expect(decoded.bootstrap.projects[0].cap.toString()).toBe('20000000000000000000');
    expect(decoded.bootstrap.projects[0].bountyCaps.map(String)).toEqual(['3000001']);
    expect(decoded.bootstrap.projects[0].metadataHash).toBe(HASH); expect(decoded.bootstrap.projects[0].managers).toEqual([A, B]);
    expect(decoded.bootstrap.projects[0].createHats.map(String)).toEqual(['1', '0']);
    expect(decoded.bootstrap.projects[0].claimHats.map(String)).toEqual(['0']); expect(decoded.bootstrap.projects[0].reviewHats.map(String)).toEqual(['1']); expect(decoded.bootstrap.projects[0].assignHats.map(String)).toEqual(['1']);
    expect(decoded.bootstrap.tasks.map((t: any) => t.projectIndex)).toEqual([1, 0, 1]);
    expect(decoded.bootstrap.tasks.map((t: any) => t.payout.toString())).toEqual(['125000000000000000', '1750000000000000000', '9007199254740993']);
    expect(decoded.bootstrap.tasks[1].bountyPayout.toString()).toBe('1000001'); expect(decoded.bootstrap.tasks[1].requiresApplication).toBe(true);
    expect(decoded.bootstrap.tasks[0]).toHaveLength(7); expect(decoded.bootstrap.tasks[2].metadataHash).toBe(ZERO);
    expect(encodeProjectStruct({ taskManagerAddress: A, name: 'Normal', managers: [A] }).slice(4, 8)).toEqual([[], [], [], []]);
    const source = readFileSync(join(__dirname, 'fixtures/core-update/organization/OrgDeployer-bootstrap.sol.txt'), 'utf8');
    expect(source).toContain('_resolveRoleIndices(projects[i].createHats, roleSubjectIds)'); expect(source).toContain('factory.buildProjectPermRows(projects[p], roleSubjectIds, projectIds[p])');
  });
  const failures: Array<[string, (b: BootstrapConfigInput) => void]> = [
    ['empty project title', b => { b.projects[0].title = ''; }], ['oversized UTF8 title', b => { b.tasks[0].title = 'é'.repeat(129); }],
    ['negative project index', b => { b.tasks[0].projectIndex = -1; }], ['foreign project index', b => { b.tasks[0].projectIndex = 2; }], ['uint8 overflow', b => { b.tasks[0].projectIndex = 256; }], ['fractional project index', b => { b.tasks[0].projectIndex = 0.5; }],
    ['foreign role index', b => { b.projects[0].claimRoleIndices = [2]; }], ['unsafe role index', b => { b.projects[0].createRoleIndices = [Number.MAX_SAFE_INTEGER + 1]; }],
    ['mismatched bounty arrays', b => { b.projects[0].bountyCaps = []; }], ['zero manager', b => { b.projects[0].managers = [ethers.constants.AddressZero]; }],
    ['Shares overprecision', b => { b.tasks[0].payout = { decimal: '0.0000000000000000001', decimals: 18 }; }], ['Shares wrong decimals', b => { b.tasks[0].payout = { decimal: '1', decimals: 6 }; }],
    ['bounty overprecision', b => { b.tasks[1].bountyPayout = { decimal: '1.0000001', decimals: 6 }; }], ['negative payout', b => { b.tasks[0].payout = { raw: '-1' }; }], ['zero payout', b => { b.tasks[0].payout = { raw: '0' }; }],
    ['payout above contract bound', b => { b.tasks[0].payout = { raw: (10n ** 24n + 1n).toString() }; }], ['cap above contract bound', b => { b.projects[0].cap = { raw: (10n ** 24n + 1n).toString() }; }],
    ['ambiguous units', b => { b.tasks[0].payout = { raw: '1', decimal: '1', decimals: 18 } as any; }], ['invalid prepared pointer', b => { b.projects[0].metadataHash = 'not-a-cid'; }],
    ['unsupported deadline', b => { (b.tasks[0] as any).completionWindow = 60; }], ['retired hat arrays', b => { (b.projects[0] as any).createHats = [1]; }], ['bounty pair mismatch', b => { b.tasks[0].bountyPayout = { raw: 1 }; }],
  ];
  it.each(failures)('rejects %s before reads/pins/signing', async (_label, mutate) => {
    const c = config(); c.roles.push({ name: 'Manager', open: false, canVote: true }); c.bootstrap = bootstrap(); mutate(c.bootstrap);
    const { ctx, storage, signer, query } = deployment();
    await expect(deployFullOrgIntent(ctx, { config: c, deployerAddress: A, signer })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled(); expect(mocks.readContract).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled(); expect(signer._signTypedData).not.toHaveBeenCalled();
  });
  it('validates 256-byte title, maximum uint8 linkage, cap sentinels and exact payout boundaries', () => {
    const b = bootstrap(); b.projects = Array.from({ length: 256 }, () => ({ title: 'é'.repeat(128), cap: { raw: (2n ** 128n - 1n).toString() } }));
    b.tasks = [{ projectIndex: 255, title: 'max', payout: { raw: (10n ** 24n).toString() } }];
    const built = buildBootstrapConfig(b, 2); expect(built[0]).toHaveLength(256); expect(built[1][0][0]).toBe(255); expect(built[0][0][2]).toBe('340282366920938463463374607431768211455');
  });
  it('does not weaken legacy-role rejection when template/bootstrap support is selected', () => {
    const c = config(); (c.roles[0] as any).hatConfig = {}; c.metadata = { template: 'worker-coop' };
    expect(() => validateOrgDeployConfig(c)).toThrow('legacy Hats');
  });
});

describe('DEPLOY-SPONSORSHIP / DEPLOY-DD-TARGETS existing tuple compatibility', () => {
  it('preserves exact original omitted-option calldata from the independent literal CLI fixture', () => {
    const intent = buildDeployFullOrg({ orgDeployerAddress: A, deployParams: buildDeploymentParams(config(), resolved()) });
    expect(encodeIntent(intent).data).toBe(oracle.encodeFunctionData('deployFullOrg', [legacy.expectedParams]));
  });
  it.each([false, true])('preserves whitelist=%s, custom/zero gas, exact gwei/native budgets and no-operator', whitelist => {
    const c = config(); c.paymaster = { autoWhitelistContracts: whitelist, operatorRoleIndex: ethers.constants.MaxUint256, maxFeePerGas: '1.000000001', maxPriorityFeePerGas: '0', maxCallGas: 123456, maxVerificationGas: 234567, maxPreVerificationGas: 34567, defaultBudgetCapPerEpoch: '0.0002', defaultBudgetEpochLen: 3600 };
    const pm = oracle.decodeFunctionData('deployFullOrg', encodeIntent(buildDeployFullOrg({ orgDeployerAddress: A, deployParams: buildDeploymentParams(c, resolved()) })).data)[0].paymasterConfig;
    expect(pm.operatorRoleIndex.toString()).toBe(ethers.constants.MaxUint256.toString()); expect(pm.autoWhitelistContracts).toBe(whitelist);
    expect(pm.maxFeePerGas.toString()).toBe('1000000001'); expect(pm.maxPriorityFeePerGas.toString()).toBe('0'); expect(pm.defaultBudgetCapPerEpoch.toString()).toBe('200000000000000'); expect(pm.defaultBudgetEpochLen).toBe(3600);
    expect([pm.maxCallGas, pm.maxVerificationGas, pm.maxPreVerificationGas]).toEqual([123456, 234567, 34567]);
    c.paymaster.maxCallGas = 0; c.paymaster.maxVerificationGas = 0; c.paymaster.maxPreVerificationGas = 0;
    const tuple = buildDeploymentParams(c, resolved())[21] as any[]; expect(tuple.slice(4, 7)).toEqual([0, 0, 0]);
    expect(tuple).not.toEqual(buildDeploymentParams(config(), resolved())[21]);
  });
  it('keeps omitted gas/whitelist CLI defaults, accepts omitted operator deliberately, and leaves disabled tuple untouched', () => {
    const c = config(); c.paymaster = { maxFeePerGas: '1', maxPriorityFeePerGas: '0', defaultBudgetCapPerEpoch: '0', defaultBudgetEpochLen: 0 };
    const pm = buildDeploymentParams(c, resolved())[21] as any[]; expect(pm.slice(4, 7)).toEqual([500000, 500000, 100000]); expect(pm[1]).toBe(true); expect(String(pm[0])).toBe(ethers.constants.MaxUint256.toString());
    const disabled = buildDeploymentParams(config(), resolved())[21] as any[]; expect(disabled.slice(1)).toEqual([false, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('accepts exact uint32/128/256 maxima without rounding or epoch-unit conversion', () => {
    const c = config();
    c.paymaster = { operatorRoleIndex: '0', maxCallGas: 4294967295, maxVerificationGas: 4294967295, maxPreVerificationGas: 4294967295,
      maxFeePerGas: ethers.utils.formatUnits(ethers.constants.MaxUint256, 9), maxPriorityFeePerGas: '0',
      defaultBudgetCapPerEpoch: ethers.utils.formatUnits(ethers.BigNumber.from(2).pow(128).sub(1), 18), defaultBudgetEpochLen: 4294967295 };
    const pm = buildDeploymentParams(c, resolved())[21] as any[];
    expect(pm.slice(4, 7)).toEqual([4294967295, 4294967295, 4294967295]); expect(pm[8]).toBe(4294967295);
    expect(String(pm[2])).toBe(ethers.constants.MaxUint256.toString()); expect(String(pm[7])).toBe('340282366920938463463374607431768211455');
  });
  it.each(['maxCallGas', 'maxVerificationGas', 'maxPreVerificationGas', 'defaultBudgetEpochLen', 'operatorRoleIndex', 'defaultBudgetCapPerEpoch', 'maxFeePerGas'] as const)('rejects out-of-range %s without I/O', async field => {
    const c = config(); c.paymaster = { operatorRoleIndex: 0, maxFeePerGas: '1', maxPriorityFeePerGas: '0', defaultBudgetCapPerEpoch: '0', defaultBudgetEpochLen: 0 };
    (c.paymaster as any)[field] = field === 'operatorRoleIndex' ? Number.MAX_SAFE_INTEGER + 1 : field === 'defaultBudgetCapPerEpoch' ? ethers.utils.formatUnits(ethers.BigNumber.from(2).pow(128), 18) : field === 'maxFeePerGas' ? ethers.utils.formatUnits(ethers.BigNumber.from(2).pow(256), 9) : 4294967296;
    const { ctx, storage, signer, query } = deployment(); await expect(deployFullOrgIntent(ctx, { config: c, deployerAddress: A, signer })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled(); expect(storage.pinJson).not.toHaveBeenCalled(); expect(signer._signTypedData).not.toHaveBeenCalled();
  });
  it('retains exact DD initial target order in pure and resolved calldata with native funding value', async () => {
    const c = config(); c.directDemocracy = { thresholdPct: 51, initialTargets: [B, A] }; c.paymaster = { operatorRoleIndex: 0, maxFeePerGas: '1', maxPriorityFeePerGas: '0', defaultBudgetCapPerEpoch: '0', defaultBudgetEpochLen: 0, funding: '0.000000000000000001' };
    const { ctx, signer } = deployment(); const intent = await deployFullOrgIntent(ctx, { config: c, deployerAddress: A, signer, regDeadline: 1700000000 });
    expect(oracle.decodeFunctionData('deployFullOrg', encodeIntent(intent).data)[0].ddInitialTargets).toEqual([B, A]); expect(String(intent.value)).toBe('1');
    expect(buildDeploymentParams(c, resolved())[13]).toEqual([B, A]); expect(buildDeploymentParams(config(), resolved())[13]).toEqual([]);
    const proposal = buildGovernanceProposal({ votingAddress: A, votingAbiName: 'HybridVotingNew', title: 'Binding', descriptionHash: HASH, durationMinutes: 60, numOptions: 2, batches: [[{ target: B, value: ethers.constants.Zero, calldata: '0x' }], []] });
    const hybridOracle = new ethers.utils.Interface(['function createProposal(bytes,bytes32,uint32,uint8,(address,uint256,bytes)[][],uint256[])']);
    expect(hybridOracle.decodeFunctionData('createProposal', encodeIntent(proposal).data)[4][0][0][0]).toBe(B);
  });
});

describe('DEPLOY-ENTRYPOINTS / DEPLOY-VERSION-GUARD / DEPLOY-TOKEN-BOUNDS', () => {
  it.each([false, true])('selects email enabled=%s and encodes the independently snapshotted extra tuple', enabled => {
    const zkConfig = { enabled, initialRoot: ZERO, initialCid: ZERO };
    expect(selectDeploymentEntrypoint(enabled)).toBe(enabled ? 'deployFullOrgWithZkEmail' : 'deployFullOrg');
    const intent = buildDeployFullOrgWithZkEmail({ orgDeployerAddress: A, deployParams: buildDeploymentParams(config(), resolved()), zkConfig, value: 17 });
    const decoded = oracle.decodeFunctionData('deployFullOrgWithZkEmail', encodeIntent(intent).data);
    expect(Array.from(decoded[1])).toEqual([enabled, ZERO, ZERO]); expect(String(intent.value)).toBe('17');
    expect(intent.meta.summary?.deployerVersionVerified).toBe(false);
  });
  it('resolved email path retains prepared root/CID and checks returned zero module explicitly', async () => {
    const { ctx, signer } = deployment(); const zkConfig = { enabled: true, initialRoot: HASH, initialCid: HASH };
    const intent = await deployFullOrgIntent(ctx, { config: config(), deployerAddress: A, signer, regDeadline: 1700000000, zkConfig });
    expect(Array.from(oracle.decodeFunctionData('deployFullOrgWithZkEmail', encodeIntent(intent).data)[1])).toEqual([true, HASH, HASH]);
    expect(() => requireDeploymentModuleAddresses({ zkEmailInvites: ethers.constants.AddressZero }, ['zkEmailInvites'])).toThrow('unavailable');
    expect(() => requireDeploymentModuleAddresses({}, ['membershipAuthority'])).toThrow('unavailable');
    expect(() => requireDeploymentModuleAddresses({ zkEmailInvites: A, membershipAuthority: B }, ['zkEmailInvites', 'membershipAuthority'])).not.toThrow();
  });
  it.each(['2.0.0', '2.1.3-alpha.1+build.7', '2.0.0-0+001'])('accepts strict SemVer %s without clock or I/O', version => {
    expect(parseDeployerSemVer(version)?.major).toBe('2'); expect(() => requireSupportedDeployerVersion(version)).not.toThrow();
  });
  it.each(['2', '2.x', '2.0', '2.0.0garbage', '2.not-semver', '2.01.0', '2.0.0-01', '2.0.0-', '2.0.0+.', ' 2.0.0', '1.9.9', '3.0.0', undefined, null])('rejects strict malformed/unsupported version %s', version => {
    expect(() => requireSupportedDeployerVersion(version, { strict: true })).toThrow();
  });
  it('preserves the legacy CLI prefix guard as an explicit default policy', () => {
    expect(() => requireAuthorityDeployerVersion('2.not-semver')).not.toThrow(); expect(() => requireSupportedDeployerVersion('2.x', { strict: false })).not.toThrow();
    expect(() => requireAuthorityDeployerVersion('1.9.9')).toThrow();
  });
  it.each(['2.x', undefined, 'throw'])('unavailable/unsupported VERSION %s prevents pins/signing and strict preview verification', async version => {
    mocks.readContract.mockImplementation(() => ({ VERSION: version === 'throw' ? vi.fn().mockRejectedValue(new Error('reverted')) : vi.fn().mockResolvedValue(version) }));
    const { ctx, storage, signer } = deployment(); await expect(deployFullOrgIntent(ctx, { config: config(), deployerAddress: A, signer, strictDeployerVersion: true })).rejects.toThrow();
    expect(storage.pinJson).not.toHaveBeenCalled(); expect(signer._signTypedData).not.toHaveBeenCalled();
  });
  it('a successful version read is explicit verified evidence in resolved preview', async () => {
    const { ctx, signer } = deployment(); const intent = await deployFullOrgIntent(ctx, { config: config(), deployerAddress: A, signer, regDeadline: 1700000000, strictDeployerVersion: true });
    expect(intent.meta.summary).toMatchObject({ deployerVersion: '2.0.0', deployerVersionVerified: true });
  });
  it.each([['n'.repeat(64), 's'.repeat(16)], ['é'.repeat(32), 'é'.repeat(8)], ['', ''], [undefined, undefined]])('accepts explicit UTF8 text boundaries/defaults %s/%s', (name, symbol) => {
    expect(() => validateParticipationTokenText({ name, symbol, policy: 'setter-compatible' })).not.toThrow();
  });
  it.each([['n'.repeat(65), 'ok'], ['ok', 's'.repeat(17)], ['é'.repeat(33), 'ok'], ['ok', 'é'.repeat(9)]])('rejects explicit setter policy beyond UTF8 boundary %s/%s', (name, symbol) => {
    expect(() => validateParticipationTokenText({ name, symbol, policy: 'setter-compatible' })).toThrow();
    const c = config(); c.token = { name, symbol }; expect(() => validateOrgDeployConfig(c)).not.toThrow();
  });
  it('initializer has no setter byte limits, while default empty deployment text stays empty', () => {
    const source = readFileSync(join(__dirname, 'fixtures/core-update/organization/ParticipationToken.sol'), 'utf8');
    const initializer = source.slice(source.indexOf('function initialize('), source.indexOf('/*────────── Modifiers'));
    expect(initializer).toContain('__ERC20_init(name_, symbol_)'); expect(initializer).not.toMatch(/MAX_NAME_LENGTH|MAX_SYMBOL_LENGTH|StringTooLong/);
    expect(source).toContain('if (len > MAX_NAME_LENGTH) revert StringTooLong()'); expect(source).toContain('if (len > MAX_SYMBOL_LENGTH) revert StringTooLong()');
    expect(buildDeploymentParams(config(), resolved()).slice(25)).toEqual(['', '']);
  });
});

describe('STORAGE-RESOLVED injected host transport', () => {
  it('dispatches pin/file/fetch once and never uses global HTTP when service is injected', async () => {
    const s = service(); expect(await pinJson('{}', { service: s })).toBe(CID); expect(await pinFile(new Uint8Array([1]), { service: s })).toBe(CID);
    await fetchJson(HASH, { service: s }); expect(s.pinJson).toHaveBeenCalledTimes(1); expect(s.pinFile).toHaveBeenCalledTimes(1); expect(s.fetchJson).toHaveBeenCalledWith(HASH); expect(s.fetchJson).toHaveBeenCalledTimes(1); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('compiled host readback adapter retries retrieval twice while publishing once', async () => {
    const upload = vi.fn().mockResolvedValue(CID), retrieve = vi.fn().mockRejectedValueOnce(new Error('not propagated')).mockRejectedValueOnce(new Error('not propagated')).mockResolvedValue({ ok: true });
    const host: ContentService = { pinFile: async () => CID, fetchJson: retrieve, pinJson: async content => {
      const cid = await upload(content);
      for (let i = 0; i < 3; i++) { try { await retrieve(cid); return cid; } catch (error) { if (i === 2) throw error; } }
      throw new Error('unreachable');
    } };
    expect(await pinJson('{"ok":true}', { service: host })).toBe(CID); expect(upload).toHaveBeenCalledTimes(1); expect(retrieve).toHaveBeenCalledTimes(3);
  });
  it('readonly rejects before every injected publishing/signing callback, including pre-pinned deployment', async () => {
    const s = service(); const opts = { readonly: true, service: s };
    await expect(pinJson('{}', opts)).rejects.toThrow('POP_READONLY'); await expect(pinFile(new Uint8Array([1]), opts)).rejects.toThrow('POP_READONLY');
    const { ctx, signer } = deployment(s, { ipfs: opts });
    await expect(deployFullOrgIntent(ctx, { config: config(), deployerAddress: A, signer, preparedMetadata: { document: {}, pointer: CID } })).rejects.toThrow('POP_READONLY');
    expect(s.pinJson).not.toHaveBeenCalled(); expect(s.pinFile).not.toHaveBeenCalled(); expect(signer._signTypedData).not.toHaveBeenCalled();
  });
  it.each(['bafy-invalid', 'Qm-invalid', bytes32ToCidV0(ZERO, { strict: false })])('rejects invalid/zero injected CID %s before deployment signing', async cid => {
    const s = service(); s.pinJson.mockResolvedValue(cid); const { ctx, signer } = deployment(s);
    await expect(deployFullOrgIntent(ctx, { config: config(), deployerAddress: A, signer })).rejects.toThrow(); expect(s.pinJson).toHaveBeenCalledTimes(1); expect(signer._signTypedData).not.toHaveBeenCalled();
  });
  it('host callback failure is never retried or bypassed by default upload transport', async () => {
    const s = service(); s.pinJson.mockRejectedValue(new Error('host rejected')); const { ctx, signer } = deployment(s);
    await expect(deployFullOrgIntent(ctx, { config: config(), deployerAddress: A, signer })).rejects.toThrow('host rejected'); expect(s.pinJson).toHaveBeenCalledTimes(1); expect(globalThis.fetch).not.toHaveBeenCalled(); expect(signer._signTypedData).not.toHaveBeenCalled();
  });
  it('existing HTTP defaults still pin once and retain the caller gateway-first cascade', async () => {
    const http = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ Hash: CID }) }).mockResolvedValueOnce({ ok: false, status: 500, statusText: 'ERR' }).mockResolvedValueOnce({ ok: true, text: async () => '{"default":"kept"}' });
    const opts: IpfsOptions = { fetch: http as any, gateways: ['https://host.test/ipfs/'] };
    expect(await pinJson('{}', opts)).toBe(CID); expect(http.mock.calls[0][0]).toBe('https://api.thegraph.com/ipfs/api/v0/add');
    expect(await fetchJson(CID, opts)).toEqual({ default: 'kept' }); expect(http.mock.calls[1][0]).toBe('https://host.test/ipfs/' + CID); expect(http.mock.calls[2][0]).toBe('https://ipfs.io/ipfs/' + CID);
  });
  it('existing resolved education/proposal/profile/task builders dispatch the injected content service', async () => {
    const s = service(); const { ctx } = context(s); (ctx.client.query as any).mockReset().mockResolvedValue({ universalAccountRegistries: [{ id: B }], account: { metadata: { bio: 'old' } }, organization: { metadata: { taskPayoutHourlyRate: '10' } } });
    await createModuleIntent(ctx, { org: ORG, name: 'Course', description: 'Learn', payout: 1, correctAnswer: 0 });
    await createProposalIntent(ctx, { org: ORG, type: 'hybrid', name: 'Proposal', description: 'Explain', durationMinutes: 60, optionNames: ['Yes', 'No'], createdAt: 1700000000 });
    await setProfileMetadataIntent(ctx, { address: A, bio: 'new' });
    await createTaskIntent(ctx, { org: ORG, project: '1', name: 'Task', description: 'Work', payout: 1, features: { deadlines: true, version: '7.0.0' } as any });
    expect(s.pinJson).toHaveBeenCalledTimes(4); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('REQUEST-TIMEUNIT explicit seconds and historical default', () => {
  it('supplied seconds retain exact reason/submittedAt order without touching the clock', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Clock forbidden'); });
    expect(serializeTokenRequestMetadata(buildTokenRequestMetadata('fixture', 1700000000))).toBe('{"reason":"fixture","submittedAt":1700000000}');
    expect(serializeTokenRequestMetadata(buildTokenRequestMetadataAtSeconds('fixture', 1700000000))).toBe('{"reason":"fixture","submittedAt":1700000000}');
    expect(buildTokenRequestMetadataAtSeconds('zero', 0).submittedAt).toBe(0);
  });
  it('omitted timestamp keeps the historical millisecond CLI default', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000123);
    expect(serializeTokenRequestMetadata(buildTokenRequestMetadata('fixture'))).toBe('{"reason":"fixture","submittedAt":1700000000123}');
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('explicit seconds rejects invalid timestamp %s', timestamp => {
    expect(() => buildTokenRequestMetadataAtSeconds('fixture', timestamp)).toThrow();
  });
});
