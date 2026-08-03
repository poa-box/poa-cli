/**
 * `pop agent onboard --dry-run` must have ZERO side effects.
 *
 * Three leaks are pinned here, all real at one point:
 *   1. Step 1 shelled out to `pop user register … -y` with NO dry-run guard —
 *      probing the CLI safely broadcast a live registration tx.
 *   2. The same shell-out interpolated --username into a command STRING
 *      (injectable); it must be an execFile args array.
 *   3. Step 3 called pinJson() BEFORE its dry-run check — a dry run still
 *      published the registration doc to IPFS, publicly and irreversibly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  pinJson: vi.fn(),
  delegateEOA: vi.fn(),
  isDelegated: vi.fn(),
  createSigner: vi.fn(),
  resolveNetworkConfig: vi.fn(),
  balanceOf: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: mocks.execFileSync,
  execSync: mocks.execSync,
}));
vi.mock('@poa-box/cli/lib/signer', () => ({ createSigner: mocks.createSigner }));
vi.mock('@poa-box/cli/lib/ipfs', () => ({ pinJson: mocks.pinJson }));
vi.mock('@poa-box/cli/lib/sponsored', () => ({
  isDelegated: mocks.isDelegated,
  delegateEOA: mocks.delegateEOA,
}));
vi.mock('@poa-box/cli/config/networks', () => ({
  resolveNetworkConfig: mocks.resolveNetworkConfig,
}));
vi.mock('@poa-box/cli/lib/contracts', () => ({ createWriteContract: vi.fn() }));
vi.mock('@poa-box/cli/lib/tx', () => ({ executeTx: vi.fn() }));
vi.mock('@poa-box/cli/lib/resolve', () => ({ resolveOrgModules: vi.fn() }));
vi.mock('@poa-box/cli/lib/output', () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), set text(_: string) { /* noop */ } }),
  isJsonMode: () => true,
  json: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('ethers', async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    ethers: {
      ...real.ethers,
      Contract: class {
        balanceOf = mocks.balanceOf;
        register = () => { throw new Error('register() must never run under --dry-run'); };
      },
      Wallet: class { constructor(_k: string, _p?: any) { /* inert */ } },
      providers: { JsonRpcProvider: class { /* inert */ } },
    },
  };
});

import { onboardHandler } from '../../src/commands/agent/onboard';

const KEY = '0x' + '11'.repeat(32);

describe('agent onboard --dry-run has no side effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSigner.mockReturnValue({ signer: { getAddress: async () => '0x' + 'aa'.repeat(20) } });
    mocks.resolveNetworkConfig.mockReturnValue({ chainId: 100, resolvedRpc: 'http://unit.invalid' });
    mocks.isDelegated.mockResolvedValue(false);
    mocks.balanceOf.mockResolvedValue({ gt: () => false });
  });

  it('never spawns, never pins, never delegates, never registers', async () => {
    await onboardHandler.handler({
      username: 'probe; rm -rf /', // hostile on purpose — must never reach a shell
      org: 'Test6',
      dryRun: true,
      privateKey: KEY,
    } as any);

    expect(mocks.execSync).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.delegateEOA).not.toHaveBeenCalled();
    expect(mocks.pinJson).not.toHaveBeenCalled();
  });

  it('live mode uses an execFile ARGS ARRAY, never a shell string', async () => {
    mocks.execFileSync.mockReturnValue(JSON.stringify({ ok: true }));
    mocks.delegateEOA.mockResolvedValue('0xtx');
    mocks.pinJson.mockResolvedValue('bafyCID');

    await onboardHandler.handler({
      username: 'evil$(touch /tmp/pwned)',
      org: 'Test6',
      dryRun: false,
      privateKey: KEY,
    } as any);

    expect(mocks.execSync).not.toHaveBeenCalled();
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    const [bin, args] = mocks.execFileSync.mock.calls[0];
    expect(bin).toBe(process.execPath);
    expect(Array.isArray(args)).toBe(true);
    // The hostile username arrives as ONE argv element, uninterpreted.
    expect(args).toContain('evil$(touch /tmp/pwned)');
  });
});
