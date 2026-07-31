/**
 * Regression: the opt-out exclusion in `pop treasury compute-merkle`.
 *
 * This is the ONLY enforcement point for payout opt-out (audit L-19):
 * PaymentManager.claim deliberately does not check it, so a member excluded
 * here is excluded, and a member wrongly included gets allocated real money.
 *
 * The bug being pinned: the call site once passed the raw Multicall3 tuple
 * names `{ target, callData }` to tryAggregate, which reads `{ to, data }`.
 * `ptHolders` is untyped subgraph JSON, so `.map` produced `any[]` and the
 * wrong shape COMPILED — then every probe failed at runtime and NO ONE was
 * ever excluded, silently. These tests assert the wire shape itself, so a
 * recurrence fails loudly instead of passing money to opted-out members.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolveOrgModules: vi.fn(),
  tryAggregate: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/lib/subgraph', () => ({ query: mocks.query }));
vi.mock('../../src/lib/resolve', () => ({ resolveOrgModules: mocks.resolveOrgModules }));
vi.mock('../../src/lib/multicall', () => ({ tryAggregate: mocks.tryAggregate }));
vi.mock('../../src/config/networks', () => ({
  resolveNetworkConfig: () => ({ resolvedRpc: 'http://unit.test.invalid', chainId: 100 }),
}));
vi.mock('../../src/lib/output', () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), set text(_: string) { /* noop */ } }),
  isJsonMode: () => true,
  json: vi.fn(),
  info: vi.fn(),
  warn: mocks.warn,
  error: vi.fn(),
  debug: vi.fn(),
}));

import { computeMerkleHandler } from '../../src/commands/treasury/compute-merkle';

const PM = '0x409f51250Dc5C66Bb1d6952f947d841192f11140'.toLowerCase();
const ALICE = '0x0000000000000000000000000000000000000a11';
const BOB = '0x0000000000000000000000000000000000000b0b';
const PM_IFACE = new ethers.utils.Interface([
  'function isOptedOut(address account) view returns (bool)',
]);

function orgFixture() {
  return {
    organization: {
      users: [
        { address: ALICE, participationTokenBalance: ethers.utils.parseEther('3').toString(), membershipStatus: 'Active', account: { username: 'alice' } },
        { address: BOB, participationTokenBalance: ethers.utils.parseEther('1').toString(), membershipStatus: 'Active', account: { username: 'bob' } },
      ],
      participationToken: { totalSupply: ethers.utils.parseEther('4').toString() },
    },
  };
}

function runArgv() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'merkle-optout-')), 'out.json');
  return { amount: '100', token: '0x' + 'ee'.repeat(20), output: out } as any;
}

describe('compute-merkle opt-out exclusion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOrgModules.mockResolvedValue({
      orgId: '0x' + '11'.repeat(32),
      paymentManagerAddress: PM,
    });
    mocks.query.mockResolvedValue(orgFixture());
    // Provider is only used for getBlockNumber before the multicall; stub it
    // on the prototype so the handler's `new JsonRpcProvider(...)` is harmless.
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getBlockNumber')
      .mockResolvedValue(12345);
    vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'detectNetwork')
      .mockResolvedValue({ name: 'gnosis', chainId: 100 } as any);
  });

  it('sends tryAggregate calls shaped { to, data } — the exact recurrence guard', async () => {
    mocks.tryAggregate.mockResolvedValue([
      { success: true, returnData: ethers.utils.defaultAbiCoder.encode(['bool'], [false]) },
      { success: true, returnData: ethers.utils.defaultAbiCoder.encode(['bool'], [false]) },
    ]);

    await computeMerkleHandler.handler(runArgv());

    expect(mocks.tryAggregate).toHaveBeenCalledTimes(1);
    const calls = mocks.tryAggregate.mock.calls[0][1];
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      // The bug shipped `{ target, callData }`: both fields below were undefined.
      expect(typeof c.to, 'Call.to must be a string (was the {target,callData} bug reintroduced?)').toBe('string');
      expect(typeof c.data).toBe('string');
      expect(c.to.toLowerCase()).toBe(PM);
      // isOptedOut(address) selector
      expect(c.data.startsWith(PM_IFACE.getSighash('isOptedOut'))).toBe(true);
    }
  });

  it('an opted-out member is excluded from the tree; the rest reallocate', async () => {
    mocks.tryAggregate.mockResolvedValue([
      { success: true, returnData: ethers.utils.defaultAbiCoder.encode(['bool'], [true]) },  // alice opted out
      { success: true, returnData: ethers.utils.defaultAbiCoder.encode(['bool'], [false]) }, // bob in
    ]);

    const argv = runArgv();
    await computeMerkleHandler.handler(argv);

    const written = JSON.parse(fs.readFileSync(argv.output, 'utf8'));
    const addrs = written.allocations.map((a: any) => a.address.toLowerCase());
    expect(addrs).not.toContain(ALICE.toLowerCase());
    expect(addrs).toContain(BOB.toLowerCase());
    // Bob is the only member left — the full amount goes to him.
    expect(written.allocations).toHaveLength(1);
    expect(written.allocations[0].allocation).toBe(ethers.utils.parseEther('100').toString());
  });

  it('every probe failing warns loudly instead of silently including everyone', async () => {
    mocks.tryAggregate.mockResolvedValue([
      { success: false, returnData: '0x' },
      { success: false, returnData: '0x' },
    ]);

    const argv = runArgv();
    await computeMerkleHandler.handler(argv);

    // Fail-open: everyone stays in (better than stranding a distribution)...
    const written = JSON.parse(fs.readFileSync(argv.output, 'utf8'));
    expect(written.allocations).toHaveLength(2);
    // ...but never silently.
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('Opt-out status could not be read'));
  });
});
