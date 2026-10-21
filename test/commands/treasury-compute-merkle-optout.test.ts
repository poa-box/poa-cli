/** Allocation is money policy: missing holder/opt-out/checkpoint facts must fail closed. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { composeSubjectId } from '@poa-box/core/authority/ids';
const mocks = vi.hoisted(() => ({ query: vi.fn(), resolveOrgModules: vi.fn(), tryAggregate: vi.fn(), error: vi.fn(), createProvider: vi.fn(), createIndexedSource: vi.fn() }));
vi.mock('../../src/lib/resolve', () => ({ resolveOrgModules: mocks.resolveOrgModules, requireModule: (modules: any, key: string) => { if (!modules[key]) throw new Error('missing module'); return modules[key]; } }));
vi.mock('../../src/lib/multicall', () => ({ tryAggregate: mocks.tryAggregate }));
vi.mock('../../src/lib/indexed-source', () => ({ createIndexedSource: mocks.createIndexedSource }));
vi.mock('../../src/lib/signer', () => ({ createProvider: mocks.createProvider }));
vi.mock('../../src/commands/treasury/helpers', () => ({ resolvePayoutTokenInfo: async (_p: any, address: string) => ({ address, symbol: 'TEST', decimals: 6, isNative: false }) }));
vi.mock('../../src/config/networks', () => ({ resolveNetworkConfig: () => ({ chainId: 100 }) }));
vi.mock('../../src/lib/output', () => ({ spinner: () => ({ start: vi.fn(), stop: vi.fn(), text: '' }), isJsonMode: () => true, json: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.error }));
import { computeMerkleHandler } from '../../src/commands/treasury/compute-merkle';
const AUTHORITY = '0x' + 'cc'.repeat(20);
const PM = '0x409f51250dc5c66bb1d6952f947d841192f11140', PT = '0x' + 'dd'.repeat(20), TOKEN = '0x' + 'ee'.repeat(20);
const ALICE = '0x0000000000000000000000000000000000000a11', BOB = '0x0000000000000000000000000000000000000b0b', ORG = '0x' + '11'.repeat(32), HASH = '0x' + 'aa'.repeat(32);
const source = { chainId: 100, orgId: ORG, contract: PT, contracts: { participationToken: PT, paymentManager: PM, membershipAuthority: AUTHORITY }, endpoint: 'fixture://test', method: 'graph', indexed: true, snapshot: 'pinned', block: { number: '12345', hash: HASH } };
const encode = (opted: boolean) => ({ success: true, returnData: ethers.utils.defaultAbiCoder.encode(['bool'], [opted]) });
let dir: string;
function fixture() { return { organization: { id: ORG, participationToken: { id: PT }, paymentManager: { id: PM }, users: [
  { id: 'a', address: ALICE, participationTokenBalance: '3000000000000000000', membershipStatus: 'Active', account: { username: 'alice' } },
  { id: 'b', address: BOB, participationTokenBalance: '1000000000000000000', membershipStatus: 'Active', account: { username: 'bob' } },
] }, _meta: { block: { number: 12345, hash: HASH } } }; }
function currentEvidenceQuery(options: { aliceActive?: boolean; bobActive?: boolean; balances?: [string, string]; omitAliceHistory?: boolean } = {}) {
  const balances = options.balances ?? ['3000000000000000000', '1000000000000000000'];
  const roleId = composeSubjectId(AUTHORITY, 1);
  const subject = { id: roleId, subjectId: roleId, kind: 'Role', defaultAllow: false, vouchConfig: null,
    organization: { id: ORG }, authority: { id: AUTHORITY } };
  const seats = [ALICE, BOB].map((user, i) => ({ id: `${roleId}-${user}`, user, accepted: true, emailVerified: false,
    ruleKind: (i === 0 ? options.aliceActive ?? true : options.bobActive ?? true) ? 'Grant' : 'None',
    vouchCount: 0, vouchEpoch: '0', subject, organization: { id: ORG }, authority: { id: AUTHORITY } }));
  const tokenBalances = [ALICE, BOB].map((account, i) => ({ id: `${PT}-${account}`, account, balance: balances[i], updatedAtBlock: '12344',
    participationToken: { id: PT, organization: { id: ORG } } }));
  const meta = { deployment: 'fixture-deployment', hasIndexingErrors: false, block: { number: 12345, hash: HASH } };
  const organization = { ...fixture().organization, membershipAuthority: { id: AUTHORITY, isRouterBound: true, cutoverAt: '1', acceptedMembershipCount: 2 },
    executorContract: null, eligibilityModule: null };
  return async (document: string, variables: any) => {
    if (document.includes('CurrentMemberTotalState')) return { organization, _meta: meta };
    if (document.includes('CurrentMemberTotalPage')) return { subjectMemberships: seats.filter(row => row.id > variables.cursor).slice(0, variables.first), _meta: meta };
    if (document.includes('TokenHolderTotalState')) return { participationTokenContract: { id: PT,
      totalSupply: (BigInt(balances[0]) + BigInt(balances[1])).toString(), organization: { id: ORG } }, _meta: meta };
    if (document.includes('TokenHolderTotalPage')) return { tokenBalances: tokenBalances.filter(row => row.id > variables.cursor).slice(0, variables.first), _meta: meta };
    const historical = { ...organization, users: organization.users.filter(user => !options.omitAliceHistory || user.address !== ALICE) };
    return { organization: historical, _meta: meta };
  };
}
const argv = () => ({ amount: '100.000001', token: TOKEN, output: path.join(dir, 'out.json') }) as any;
beforeEach(() => {
  vi.clearAllMocks(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merkle-complete-')); process.exitCode = undefined;
  mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG, paymentManagerAddress: PM, participationTokenAddress: PT, membershipAuthorityAddress: AUTHORITY });
  mocks.createProvider.mockReturnValue({ getNetwork: async () => ({ chainId: 100 }), getBlock: async () => ({ number: 12345, hash: HASH }) });
  mocks.createIndexedSource.mockResolvedValue({ source, protocolQuery: mocks.query }); mocks.query.mockImplementation(currentEvidenceQuery());
  mocks.tryAggregate.mockResolvedValue([encode(false), encode(false)]);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exitCode = undefined; });
describe('compute-merkle checkpoint and opt-out qualification', () => {
  it('uses current authority eligibility instead of historical Active/Inactive user flags for a new allocation', async () => {
    const query = currentEvidenceQuery({ aliceActive: false, bobActive: true });
    mocks.query.mockImplementation(async (document, variables) => {
      const response: any = await query(document, variables);
      if (response.organization?.users) response.organization.users[1].membershipStatus = 'Inactive';
      return response;
    });
    mocks.tryAggregate.mockResolvedValue([encode(false)]);
    const args = argv(); await computeMerkleHandler.handler(args);
    const written = JSON.parse(fs.readFileSync(args.output, 'utf8'));
    expect(written.allocations).toHaveLength(1);
    expect(written.allocations[0].address.toLowerCase()).toBe(BOB);
    expect(written.allocations[0].allocation).toBe('100000001');
    expect(mocks.query.mock.calls.some(([document]) => document.includes('CurrentMemberTotalPage'))).toBe(true);
  });

  it('batches {to,data} opt-out probes pinned to the same checkpoint', async () => {
    const args = argv(); await computeMerkleHandler.handler(args);
    expect(mocks.tryAggregate).toHaveBeenCalledTimes(1);
    const [, calls, options] = mocks.tryAggregate.mock.calls[0];
    expect(calls).toHaveLength(2); expect(options).toEqual({ blockTag: 12345 });
    const iface = new ethers.utils.Interface(['function isOptedOut(address) view returns(bool)']);
    expect(calls).toEqual([ALICE, BOB].map(a => ({ to: PM, data: iface.encodeFunctionData('isOptedOut', [a]) })));
    const written = JSON.parse(fs.readFileSync(args.output, 'utf8'));
    expect(written.totalAmount).toBe('100000001'); // six decimals, no implicit parseEther
    expect(written.optOutCheck).toBe('ok'); expect(written.claimsDocument.claims).toEqual(written.claims);
  });
  it('uses supply-reconciled balances even when historical user balances and membership flags disagree', async () => {
    mocks.query.mockImplementation(currentEvidenceQuery({ balances: ['1000000000000000000', '3000000000000000000'], omitAliceHistory: true }));
    const args = argv(); await computeMerkleHandler.handler(args);
    const written = JSON.parse(fs.readFileSync(args.output, 'utf8'));
    expect(written.allocations.find((allocation: any) => allocation.address.toLowerCase() === ALICE).allocation).toBe('25000000');
    expect(written.allocations.find((allocation: any) => allocation.address.toLowerCase() === BOB).allocation).toBe('75000001');
    expect(mocks.query.mock.calls.every(([document]) => !document.includes('users(') && !document.includes('membershipStatus'))).toBe(true);
    expect(written).toMatchObject({ membershipCheck: 'ok', membershipAuthority: AUTHORITY,
      membershipSemantics: 'distinct-current-member-accounts', membershipCoverage: { status: 'complete' },
      membershipSource: { contract: AUTHORITY, block: source.block } });
  });

  it.each(['ban', 'stale-vouch-epoch'] as const)('excludes an accepted historical holder with current %s ineligibility', async reason => {
    const query = currentEvidenceQuery();
    mocks.query.mockImplementation(async (document, variables) => {
      const response: any = await query(document, variables);
      if (document.includes('CurrentMemberTotalPage')) {
        const alice = response.subjectMemberships.find((row: any) => row.user === ALICE);
        if (alice) {
          alice.ruleKind = reason === 'ban' ? 'Ban' : 'None';
          alice.isMember = true; // A stale cached status must not override current fold inputs.
          if (reason === 'stale-vouch-epoch') { alice.subject = { ...alice.subject, vouchConfig: { quorum: 1, epoch: '2' } }; alice.vouchCount = 10; alice.vouchEpoch = '1'; }
        }
      }
      return response;
    });
    mocks.tryAggregate.mockResolvedValue([encode(false)]);
    const args = argv(); await computeMerkleHandler.handler(args);
    const written = JSON.parse(fs.readFileSync(args.output, 'utf8'));
    expect(written.allocations).toHaveLength(1); expect(written.allocations[0].address.toLowerCase()).toBe(BOB);
  });

  it.each(['missing-fold-inputs', 'authority-not-ready', 'accepted-count', 'wrong-block', 'unhealthy-index', 'supply-mismatch', 'missing-balance-row', 'module-binding'] as const)('fails closed on %s evidence before probes or artifact publication', async failure => {
    const query = currentEvidenceQuery();
    mocks.query.mockImplementation(async (document, variables) => {
      const response: any = await query(document, variables);
      if (failure === 'missing-fold-inputs' && document.includes('CurrentMemberTotalPage') && response.subjectMemberships[0]) delete response.subjectMemberships[0].subject.vouchConfig;
      if (failure === 'authority-not-ready' && document.includes('CurrentMemberTotalState')) response.organization.membershipAuthority.isRouterBound = false;
      if (failure === 'accepted-count' && document.includes('CurrentMemberTotalState')) response.organization.membershipAuthority.acceptedMembershipCount = 1;
      if (failure === 'wrong-block' && document.includes('CurrentMemberTotalPage')) response._meta.block.hash = '0x' + 'bb'.repeat(32);
      if (failure === 'unhealthy-index' && document.includes('CurrentMemberTotalPage')) response._meta.hasIndexingErrors = true;
      if (failure === 'supply-mismatch' && document.includes('TokenHolderTotalState')) response.participationTokenContract.totalSupply = '1';
      if (failure === 'missing-balance-row' && document.includes('TokenHolderTotalPage')) response.tokenBalances = response.tokenBalances.slice(1);
      if (failure === 'module-binding' && document.includes('DistributionModules')) response.organization.membershipAuthority.id = TOKEN;
      return response;
    });
    const args = argv(); await computeMerkleHandler.handler(args);
    expect(fs.existsSync(args.output)).toBe(false); expect(mocks.tryAggregate).not.toHaveBeenCalled(); expect(mocks.error).toHaveBeenCalled();
  });

  it('fails closed if the organization has no supported authority instead of using historical User status', async () => {
    mocks.resolveOrgModules.mockResolvedValue({ orgId: ORG, paymentManagerAddress: PM, participationTokenAddress: PT });
    const args = argv(); await computeMerkleHandler.handler(args);
    expect(fs.existsSync(args.output)).toBe(false); expect(mocks.tryAggregate).not.toHaveBeenCalled(); expect(mocks.error).toHaveBeenCalled();
  });

  it('excludes opted-out holders and allocates the full exact amount to eligible holders', async () => {
    mocks.tryAggregate.mockResolvedValue([encode(true), encode(false)]);
    const args = argv(); await computeMerkleHandler.handler(args);
    const written = JSON.parse(fs.readFileSync(args.output, 'utf8'));
    expect(written.allocations).toHaveLength(1); expect(written.allocations[0].address.toLowerCase()).toBe(BOB);
    expect(written.allocations[0].allocation).toBe('100000001'); expect(written.excludedOptedOut).toBe(1);
  });
  it.each([[false, false], [true, false]])('refuses missing opt-out evidence instead of allocating to an unknown holder (%s,%s)', async (one, two) => {
    mocks.tryAggregate.mockResolvedValue([one ? encode(false) : { success: false, returnData: '0x' }, two ? encode(false) : { success: false, returnData: '0x' }]);
    const args = argv(); await computeMerkleHandler.handler(args);
    expect(fs.existsSync(args.output)).toBe(false); expect(mocks.error).toHaveBeenCalledWith('OPT_OUT_UNKNOWN');
  });
  it('refuses a capped complete-looking holder page without its terminal page', async () => {
    const args = { ...argv(), pageSize: 2, maxPages: 1 }; await computeMerkleHandler.handler(args);
    expect(fs.existsSync(args.output)).toBe(false); expect(mocks.error.mock.calls[0][0]).toContain('INCOMPLETE_SNAPSHOT');
  });
  it('refuses metadata-less indexed responses and mismatched RPC checkpoint hashes', async () => {
    const f = fixture(); delete (f as any)._meta; mocks.query.mockResolvedValue(f);
    const args = argv(); await computeMerkleHandler.handler(args); expect(fs.existsSync(args.output)).toBe(false);
    mocks.createProvider.mockReturnValue({ getNetwork: async () => ({ chainId: 100 }), getBlock: async () => ({ number: 12345, hash: '0x' + 'bb'.repeat(32) }) });
    await computeMerkleHandler.handler(args); expect(mocks.error).toHaveBeenLastCalledWith('INDEXED_RPC_CHECKPOINT_MISMATCH');
  });
});
