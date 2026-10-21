import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { getAbi } from '@poa-box/core/contracts';
import { buildAllowlist } from '@poa-box/core/zkemail';
import { prepareUserAction } from '../../src/commands/user/prepare';
import { prepareEmailAction } from '../../src/commands/zkemail/prepare';
import { prepareTaskAction } from '../../src/commands/task/prepare';
import { prepareProjectAction } from '../../src/commands/project/prepare';

const TARGET = '0x1111111111111111111111111111111111111111';
const ACCOUNT = '0x2222222222222222222222222222222222222222';
const REGISTRY = '0x3333333333333333333333333333333333333333';
const HASH = '0x' + '44'.repeat(32), ORG = '0x' + '55'.repeat(32);
const Z = ethers.constants.HashZero;
const passkey = { credentialId: HASH, publicKeyX: HASH, publicKeyY: HASH, salt: '9007199254740993' };
const auth = { authenticatorData: '0x1234', clientDataJSON: '0x1234', challengeIndex: '0', typeIndex: '1', r: HASH, s: HASH };
const proof = { pi_a: ['1', '2', '1'], pi_b: [['3', '4'], ['5', '6'], ['1', '0']], pi_c: ['7', '8', '1'], protocol: 'groth16', curve: 'bn128' };
const signals = ['1', '2', BigInt(ACCOUNT).toString(), '3', '4'];
const email = { zkEmailInvitesAddress: TARGET, orgId: ORG, claimer: ACCOUNT, proof, publicSignals: signals,
  hatIds: ['9007199254740993', '2'], merkleProof: [HASH] };
const task = { taskManagerAddress: TARGET, projectId: Z, payoutRaw: '1', title: 'One wei', metadataHash: Z };

describe('CLI core work/identity adoption at the offline preparation boundary', () => {
  it('encodes exact raw task amounts and atomic assignment against the checked-in ABI', () => {
    const result: any = prepareTaskAction('create-and-assign', { ...task, assignee: ACCOUNT });
    const args = new ethers.utils.Interface(getAbi('TaskManagerNew')).decodeFunctionData('createAndAssignTask', result.data);
    expect(result).toMatchObject({ prepared: true, broadcast: false, method: 'createAndAssignTask', value: '0' });
    expect(args).toHaveLength(10); expect(args[0].toString()).toBe('1'); expect(args[4]).toBe(ACCOUNT);
    const batch: any = prepareTaskAction('create-batch', { taskManagerAddress: TARGET, projectId: Z, tasks: [task, { ...task, title: 'Second' }] });
    expect(new ethers.utils.Interface(getAbi('TaskManagerNew')).decodeFunctionData('createTasksBatch', batch.data)[1]).toHaveLength(2);
  });

  it('rejects unsafe numbers, incomplete metadata replacement and retired configuration', () => {
    expect(() => prepareTaskAction('create', { ...task, payoutRaw: 9007199254740992 })).toThrow();
    expect(() => prepareTaskAction('metadata', { mode: 'replace', metadata: { name: 'Partial' } })).toThrow();
    expect(() => prepareTaskAction('config', { taskManagerAddress: TARGET, config: { key: 'ROLE_PERM' } })).toThrow();
    const existing = { name: 'Task', description: 'Keep', location: '', difficulty: 'hard', estHours: '2.5', submission: '', dueDate: 1000 };
    const metadata: any = prepareTaskAction('metadata', { mode: 'patch', existing, updates: { name: 'Renamed' } });
    expect(metadata.metadata).toEqual({ ...existing, name: 'Renamed' });
    expect(Object.keys(JSON.parse(metadata.serialized))).toEqual(Object.keys(existing));
  });

  it('projects creator authorization from the supplied original scopes without asserting live verification', () => {
    const ref = { chainId: 100, orgId: ORG, contract: TARGET, endpoint: 'fixture://creator', method: 'task-manager',
      indexed: true, snapshot: 'pinned', block: { number: '50', hash: HASH } };
    const coverage = { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
    const known = (value: unknown) => ({ state: 'known', value });
    const authSource = { ...ref, contract: REGISTRY, method: 'authority' };
    const input = { scope: { chainId: 100, orgId: ORG, contract: TARGET, endpoint: ref.endpoint, account: ACCOUNT,
      contracts: { membershipAuthority: REGISTRY } },
      taskManager: { source: ref, coverage, data: { creatorSubjectIds: known(['1']), membershipAuthority: known(REGISTRY), executor: known(REGISTRY) } },
      authority: { source: authSource, coverage, data: { subjects: [{ subjectId: '1', kind: 'Role', name: null }], groupEdges: [], permissions: [] } },
      memberships: { source: { ...authSource, account: ACCOUNT }, coverage, data: [{ subjectId: '1', isMember: known(true) }] } };
    const positive: any = prepareProjectAction('creator-authorization', input);
    expect(positive).toMatchObject({ prepared: true, broadcast: false, liveAuthorizationVerified: false,
      authorization: { creator: { state: 'known', value: true }, executor: { state: 'known', value: false }, authorized: { state: 'known', value: true } } });
    input.taskManager.data.creatorSubjectIds = known([]);
    expect((prepareProjectAction('creator-authorization', input) as any).authorization.authorized).toMatchObject({ state: 'known', value: false });
    input.taskManager.data.executor = known(ACCOUNT);
    input.authority.source.endpoint = 'fixture://foreign';
    expect((prepareProjectAction('creator-authorization', input) as any).authorization.authorized).toMatchObject({ state: 'unknown' });
  });

  it('keeps explicit profile patch and replacement semantics distinct', () => {
    const patch: any = prepareUserAction('profile', { mode: 'patch', updates: { bio: '' }, existing: { bio: 'Old', github: 'alice' } });
    expect(patch.serialized).toBe('{"bio":"","github":"alice"}');
    const replacement: any = prepareUserAction('profile', { mode: 'replace', updates: { bio: 'New' }, existing: { github: 'alice' } });
    expect(replacement.metadata).toEqual({ bio: 'New', avatar: '', github: '', twitter: '', website: '' });
    expect(() => prepareUserAction('profile', { mode: 'patch', updates: { bio: 123 } })).toThrow('Invalid profile field');
    expect(() => prepareUserAction('profile', { updates: { bio: 'New' } })).toThrow('mode');
  });

  it('uses the correct EOA versus passkey registration typed data and one atomic enrollment call', () => {
    const input = { user: ACCOUNT, username: 'alice', nonce: '9007199254740993', deadline: '4000000000', chainId: '100', registryAddress: REGISTRY };
    const eoa: any = prepareUserAction('registration-challenge', { ...input, kind: 'eoa' });
    const key: any = prepareUserAction('registration-challenge', { ...input, kind: 'passkey' });
    expect(eoa.challenge).not.toBe(key.challenge); expect(eoa.types).toHaveProperty('RegisterAccount'); expect(key.types).toHaveProperty('RegisterPasskeyAccount');
    const prepared: any = prepareUserAction('register-and-join-passkey', { quickJoinAddress: TARGET, passkey, auth, username: 'alice', nonce: input.nonce, deadline: input.deadline });
    const args = new ethers.utils.Interface(getAbi('QuickJoinNew')).decodeFunctionData('registerAndQuickJoinWithPasskey', prepared.data);
    expect(args[0].salt.toString()).toBe(passkey.salt); expect(args[3].toString()).toBe(input.nonce);
  });

  it('projects an externally supplied Groth16 proof exactly once and preserves committed role order', () => {
    const result: any = prepareEmailAction('claim-email', email);
    const args = new ethers.utils.Interface(getAbi('ZkEmailInvites')).decodeFunctionData('claimRoleByEmail', result.data);
    expect(result).toMatchObject({ prepared: true, broadcast: false, proofCryptographicallyVerified: false });
    expect(args[2].map((id: any) => id.toString())).toEqual(email.hatIds);
    expect(args[0].pB.map((row: any) => row.map((v: any) => v.toString()))).toEqual([['4', '3'], ['6', '5']]);
    expect(() => prepareEmailAction('claim-email', { ...email, publicSignals: ['1', '2', '1', '3', '4'] })).toThrow('different claimer');
    expect(() => prepareEmailAction('claim-domain', email)).toThrow('Malformed Groth16');
  });

  it('encodes passkey email enrollment as a single current-ABI operation', () => {
    const result: any = prepareEmailAction('register-and-claim-email-passkey', { ...email, passkey, auth, username: 'alice', nonce: '0', deadline: '4000000000' });
    const args = new ethers.utils.Interface(getAbi('ZkEmailInvites')).decodeFunctionData('registerAndClaimByEmailWithPasskey', result.data);
    expect(args).toHaveLength(8); expect(args[0].credentialId).toBe(HASH);
    expect(args[6].map((id: any) => id.toString())).toEqual(email.hatIds);
  });

  it('replaces a verified whole allowlist without publishing private email plaintext', async () => {
    const current = await buildAllowlist({ orgId: ORG, entries: [{ type: 'domain', identifier: 'example.org', hatIds: ['1'] }] });
    const unchanged: any = prepareEmailAction('replace-allowlist', { orgId: ORG, currentRoot: current.root, current: current.doc, retained: [{ index: 0 }] });
    expect(unchanged.merkleRoot).toBe(current.root);
    const edited: any = prepareEmailAction('replace-allowlist', { orgId: ORG, currentRoot: current.root, current: current.doc,
      retained: [], additions: [{ type: 'email', identifier: 'alice@example.org', hatIds: ['2'] }] });
    expect(edited.serialized).not.toContain('alice@example.org'); expect(edited.document.entries).toHaveLength(1);
    expect(() => prepareEmailAction('replace-allowlist', { orgId: ORG, currentRoot: Z, current: current.doc, retained: [] })).toThrow();
    expect(() => prepareEmailAction('replace-allowlist', { orgId: ORG, currentRoot: current.root, current: current.doc, retained: [{ index: 1 }] })).toThrow('index');
  });

  it('projects supplied invitation readiness without claiming live verification and blocks unknown DKIM evidence', async () => {
    const allowlist = await buildAllowlist({ orgId: ORG, entries: [{ type: 'domain', identifier: 'example.org', hatIds: ['1'] }] });
    const known = (value: unknown) => ({ state: 'known', value });
    const scope = { chainId: 100, orgId: ORG, contract: TARGET };
    const live = { ...scope, endpoint: 'fixture://rpc', method: 'eth_call', indexed: false, snapshot: 'latest', observedAt: 1000 };
    const coverage = { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
    const data = { root: known(allowlist.root), cidDigest: known(HASH), entries: known([]), executor: known(TARGET),
      domainVerifier: known(TARGET), emailVerifier: known(TARGET), dkimRegistry: known(TARGET), accountRegistry: known(REGISTRY),
      universalFactory: known(TARGET), authorityReady: known(true), authorityMatches: known(true), minterAuthorized: known(true),
      dkimKeyValid: known(true), circuitVersion: known('v1'), keyVersion: known('ceremony-v1'), budgetAvailable: known(true) };
    const input = { scope, currentRoot: allowlist.root, document: allowlist.doc, documentCidDigest: HASH,
      version: 'v1', keyVersion: 'ceremony-v1', freshness: { nowSeconds: 1000, maxAgeSeconds: 60 },
      evidence: { indexed: { source: { ...live, endpoint: 'fixture://graph', method: 'graph', indexed: true }, data, coverage },
        authoritative: { source: live, data, coverage } } };
    const projected: any = prepareEmailAction('invite-state', input);
    expect(projected).toMatchObject({ prepared: true, broadcast: false, liveAuthorizationVerified: false,
      projection: { lifecycle: { state: 'known', value: 'active' }, action: { status: 'ready' } } });
    input.evidence.authoritative.data = { ...data, dkimKeyValid: { state: 'unknown', code: 'DKIM_UNAVAILABLE' } as any };
    const blocked: any = prepareEmailAction('invite-state', input);
    expect(blocked.projection.action.status).toBe('blocked');
    expect(blocked.projection.action.codes).toContain('DKIM_KEY_VALID_UNKNOWN');
  });

  it('keeps unproven email recovery non-activating and non-creating', () => {
    expect(prepareEmailAction('restart-guidance', {})).toMatchObject({ retainLegacy: true, activationAllowed: false, createCredentialAllowed: false });
  });
});
