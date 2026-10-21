import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { bytes32ToIpfsCid } from '../../src/lib/encoding';
import fs from 'fs';
import os from 'os';
import path from 'path';
const mocks = vi.hoisted(() => ({ context: vi.fn(), confirm: vi.fn(), finish: vi.fn(), pin: vi.fn(), execute: vi.fn(), state: vi.fn(), availability: vi.fn(), error: vi.fn() }));
vi.mock('../../src/lib/command', () => ({ getWriteContext: mocks.context, confirmWrite: mocks.confirm, finishWrite: mocks.finish }));
vi.mock('../../src/lib/write-metadata', () => ({ pinWriteMetadata: mocks.pin }));
vi.mock('../../src/lib/tx', () => ({ executeTx: mocks.execute }));
vi.mock('../../src/lib/treasury-planning', () => ({ readTreasuryPlanningState: mocks.state, treasuryAvailability: mocks.availability }));
vi.mock('../../src/lib/contracts', () => ({ createWriteContract: () => ({}) }));
vi.mock('../../src/commands/treasury/helpers', () => ({ resolvePayoutTokenInfo: async () => ({ address: '0x' + '33'.repeat(20), decimals: 6, symbol: 'TEST', isNative: false }) }));
vi.mock('../../src/lib/preflight', () => ({ runPreflight: async () => {}, checkGasBalance: () => ({}) }));
vi.mock('../../src/lib/output', () => ({ spinner: () => ({ start: vi.fn(), stop: vi.fn(), text: '' }), error: mocks.error }));
import { proposeDistributionHandler } from '../../src/commands/treasury/propose-distribution';
const ACCOUNT = '0x' + '11'.repeat(20), PM = '0x' + '22'.repeat(20), TOKEN = '0x' + '33'.repeat(20), ORG = '0x' + '44'.repeat(32);
const CID = bytes32ToIpfsCid('0x' + 'ab'.repeat(32))!;
let dir: string;
function argv() {
  const tree = StandardMerkleTree.of([[ACCOUNT, '21000000']], ['address', 'uint256']);
  const file = path.join(dir, 'merkle.json');
  fs.writeFileSync(file, JSON.stringify({ merkleRoot: tree.root, totalAmount: '21000000', tokenAddress: TOKEN,
    checkpointBlock: 42, memberCount: 1, optOutCheck: 'ok', claims: { [ACCOUNT]: { amount: '21000000', proof: tree.getProof([ACCOUNT, '21000000']) } } }));
  return { org: 'test', merkleFile: file, duration: 60, yes: true, preflight: false } as any;
}
beforeEach(() => {
  vi.clearAllMocks(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-reserve-'));
  mocks.context.mockResolvedValue({ orgId: ORG, chainId: 100, address: ACCOUNT, provider: {}, signer: {}, modules: { paymentManagerAddress: PM, hybridVotingAddress: ACCOUNT } });
  mocks.state.mockResolvedValue({ source: { block: { number: '100' } } });
  mocks.availability.mockReturnValue({ status: 'ready', data: { spendableRaw: '20000000', committedRaw: '80000000' } });
  mocks.pin.mockResolvedValue(CID); mocks.execute.mockResolvedValue({ success: true, logs: [] });
  vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
describe('distribution proposal money gates', () => {
  it('cannot bypass existing reservations with --no-preflight and never pins an underfunded proposal', async () => {
    await expect(proposeDistributionHandler.handler(argv())).rejects.toThrow('exit');
    expect(mocks.error.mock.calls[0][0]).toMatch(/spendable/); expect(mocks.pin).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('rejects altered stored proof sets before publishing governance metadata', async () => {
    const args = argv(), data = JSON.parse(fs.readFileSync(args.merkleFile, 'utf8')); data.claims[ACCOUNT].amount = '1'; fs.writeFileSync(args.merkleFile, JSON.stringify(data));
    await expect(proposeDistributionHandler.handler(args)).rejects.toThrow('exit'); expect(mocks.pin).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('publishes a verified stored-claim marker and forwards dry-run policy for both documents', async () => {
    mocks.availability.mockReturnValue({ status: 'ready', data: { spendableRaw: '22000000' } });
    await proposeDistributionHandler.handler({ ...argv(), dryRun: true });
    expect(mocks.pin).toHaveBeenCalledTimes(2); expect(mocks.pin.mock.calls.every(call => call[1] === true)).toBe(true);
    expect(JSON.parse(mocks.pin.mock.calls[1][0]).description).toContain(`Merkle tree: ipfs://${CID} Root:`);
    expect(mocks.execute).toHaveBeenCalledWith(expect.anything(), 'createProposal', expect.anything(), { dryRun: true });
  });
});
