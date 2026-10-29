import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import yargs from 'yargs/yargs';
import { CASHOUT_RELAY_ABI_V1, CASHOUT_ESCROW_ABI_V1 } from '@poa-box/core/integrations/cashout';
const mocks = vi.hoisted(() => ({ aggregate: vi.fn(), signer: vi.fn(), execute: vi.fn(), json: vi.fn(), error: vi.fn(), finish: vi.fn() }));
vi.mock('../../src/lib/multicall', () => ({ tryAggregate: mocks.aggregate }));
vi.mock('../../src/lib/signer', () => ({ resolveIdentityAddress: () => '0x' + '11'.repeat(20), createSigner: mocks.signer }));
vi.mock('../../src/lib/tx', () => ({ executeIntent: mocks.execute }));
vi.mock('../../src/lib/prompt', () => ({ isInteractive: () => false }));
vi.mock('../../src/lib/output', () => ({ json: mocks.json, error: mocks.error, info: vi.fn(), isJsonMode: () => true }));
vi.mock('../../src/lib/command', async original => ({ ...await original<any>(), finishWrite: mocks.finish }));
import { registerCashoutCommands } from '../../src/commands/cashout';
const ACCOUNT = '0x' + '11'.repeat(20), OTHER = '0x' + '22'.repeat(20), RELAY = '0x' + '33'.repeat(20), ESCROW = '0x' + '44'.repeat(20), TOKEN = '0x' + '55'.repeat(20), HASH = '0x' + 'aa'.repeat(32);
const relay = new ethers.utils.Interface([...CASHOUT_RELAY_ABI_V1, 'function escrow() view returns(address)']);
const escrow = new ethers.utils.Interface([...CASHOUT_ESCROW_ABI_V1]);
let owner: string, code: string, amount: string;
const run = (action: string, extra: string[] = []) => registerCashoutCommands(yargs().exitProcess(false).option('chain', { type: 'number' }).option('yes', { type: 'boolean' }).option('dry-run', { type: 'boolean' }))
  .parseAsync([action, '--chain', '8453', '--rpc', 'http://offline.invalid', '--relay', RELAY, '--escrow', ESCROW, '--token', TOKEN, ...extra]);
beforeEach(() => {
  vi.clearAllMocks(); owner = ACCOUNT; code = '0x'; amount = '123456789'; process.exitCode = undefined; delete process.env.POP_ASSUME_YES;
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getNetwork').mockResolvedValue({ chainId: 8453, name: 'base' });
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getBlock').mockResolvedValue({ number: 100, hash: HASH, timestamp: 1234 } as any);
  vi.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getCode').mockImplementation(async () => code);
  mocks.signer.mockReturnValue({ address: ACCOUNT, signer: {} }); mocks.execute.mockResolvedValue({ success: true });
  mocks.aggregate.mockImplementation(async (_provider: any, calls: any[], options: any) => {
    expect(options).toEqual({ blockTag: 100 });
    return calls.map(call => {
      const iface = call.to.toLowerCase() === ESCROW ? escrow : relay, parsed = iface.parseTransaction({ data: call.data });
      const value = parsed.name === 'usdc' ? [TOKEN] : parsed.name === 'escrow' ? [ESCROW] : parsed.name === 'failedDepositor' ? [owner]
        : parsed.name === 'failedAmount' ? [amount] : [[owner, ethers.constants.AddressZero, TOKEN, [1, 1000000000], true, amount, '500', ethers.constants.AddressZero, true]];
      return { success: true, returnData: iface.encodeFunctionResult(parsed.name, value) };
    });
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline test forbids network'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = undefined; });
describe('explicit EOA cashout recovery adapter', () => {
  it('observes exact raw balance and keeps initiation capability unknown without a key', async () => {
    await run('status', ['--request', HASH]);
    expect(mocks.json.mock.calls[0][0].facts).toMatchObject({ state: 'known', value: { owner: true, recoverableAmountRaw: amount,
      transactionOnlyCapability: { state: 'known', value: true }, initiationCapability: { state: 'unknown' } } });
    expect(mocks.signer).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('a foreign depositor cannot be recovered even with --yes', async () => {
    owner = OTHER; await run('recover-failed', ['--request', HASH, '--yes']); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('a passkey or unrecognized contract account never gains EOA recovery capability', async () => {
    code = '0x1234'; await run('recover-failed', ['--request', HASH, '--yes']); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('JSON output never substitutes for explicit destructive consent', async () => {
    await run('recover-failed', ['--request', HASH]); expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.error.mock.calls[0][0]).toContain('--yes');
  });
  it('an explicit confirmed EOA recovery executes only the exact failed request intent', async () => {
    await run('recover-failed', ['--request', HASH, '--yes', '--dry-run']);
    expect(mocks.execute).toHaveBeenCalledWith({}, expect.objectContaining({ to: RELAY, method: 'recoverFailed', args: [HASH] }), { dryRun: true });
  });
  it('escrow recovery retains outstanding intents separately from withdrawable remaining deposits', async () => {
    await run('withdraw-deposit', ['--deposit', '9007199254740993', '--yes']);
    expect(mocks.execute).toHaveBeenCalledWith({}, expect.objectContaining({ to: ESCROW, method: 'withdrawDeposit', args: ['9007199254740993'] }), { dryRun: undefined });
    expect(mocks.finish.mock.calls[0][1].fields).toMatchObject({ amountRaw: amount, outstandingIntentAmountRaw: '500' });
  });
  it('zero pending balances and wrong-chain RPC responses fail before execution', async () => {
    amount = '0'; await run('recover-failed', ['--request', HASH, '--yes']); expect(mocks.execute).not.toHaveBeenCalled();
    vi.mocked(ethers.providers.JsonRpcProvider.prototype.getNetwork).mockResolvedValue({ chainId: 100, name: 'gnosis' });
    await run('recover-failed', ['--request', HASH, '--yes']); expect(mocks.error).toHaveBeenLastCalledWith('CASHOUT_RPC_CHAIN_MISMATCH'); expect(mocks.execute).not.toHaveBeenCalled();
  });
});
