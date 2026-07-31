/**
 * `pop token balance` — subgraph-first balance + symbol.
 *
 * TokenBalance is a complete mirror of ERC20 balanceOf (verified live: a
 * token's TokenBalance rows sum exactly to its indexed totalSupply) and
 * ParticipationTokenContract.symbol is populated on every live row, which
 * beats the hardcoded 'PT' the command fell back to when symbol() failed.
 *
 * The contract still settles the ambiguous case: a holder with no TokenBalance
 * row is indistinguishable from a holder whose row has not been indexed yet,
 * so "no row" means ask the chain rather than print a zero.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

const {
  resolveTokenAddressMock,
  createReadContractMock,
  createProviderMock,
  queryMock,
  jsonMock,
  errorMock,
} = vi.hoisted(() => ({
  resolveTokenAddressMock: vi.fn(),
  createReadContractMock: vi.fn(),
  createProviderMock: vi.fn(() => ({})),
  queryMock: vi.fn(),
  jsonMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('../../src/commands/token/helpers', () => ({ resolveTokenAddress: resolveTokenAddressMock }));
vi.mock('../../src/lib/subgraph', () => ({ query: queryMock }));
vi.mock('../../src/lib/signer', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, createProvider: createProviderMock };
});
vi.mock('../../src/lib/contracts', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, createReadContract: createReadContractMock };
});
vi.mock('../../src/lib/output', () => ({
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), text: '' })),
  success: vi.fn(), error: errorMock, info: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  table: vi.fn(), json: jsonMock, isJsonMode: vi.fn(() => true), keyValueBlock: vi.fn(),
}));

import { balanceHandler } from '../../src/commands/token/balance';

const TOKEN = ethers.utils.getAddress('0x' + '2b'.repeat(20));
const HOLDER = ethers.utils.getAddress('0x' + 'aa'.repeat(20));

describe('token balance', () => {
  let exitSpy: any;
  let logSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveTokenAddressMock.mockResolvedValue({ orgId: '0x' + '11'.repeat(32), tokenAddress: TOKEN });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('reads balance and symbol from the subgraph without any contract call', async () => {
    queryMock.mockResolvedValue({
      participationTokenContract: { id: TOKEN.toLowerCase(), symbol: 'KUBIX' },
      tokenBalance: { id: 'x', balance: '105000000000000000000', updatedAt: '1780457730' },
    });

    await balanceHandler.handler({ org: 'test-org', address: HOLDER, chain: 100 } as any);

    expect(createReadContractMock).not.toHaveBeenCalled();
    expect(createProviderMock).not.toHaveBeenCalled();
    // TokenBalance id is `${token}-${holder}`, both lowercase.
    expect(queryMock.mock.calls[0][1]).toEqual({
      token: TOKEN.toLowerCase(),
      balanceId: `${TOKEN.toLowerCase()}-${HOLDER.toLowerCase()}`,
    });
    expect(queryMock.mock.calls[0][2]).toBe(100);

    // Classic --json fields keep their exact names, values and order.
    const doc = jsonMock.mock.calls[0][0];
    expect(Object.keys(doc)).toEqual(['address', 'balance', 'balanceWei', 'token', 'symbol', 'source']);
    expect(doc.address).toBe(HOLDER);
    expect(doc.balance).toBe('105.0');
    expect(doc.balanceWei).toBe('105000000000000000000');
    expect(doc.token).toBe(TOKEN);
    expect(doc.symbol).toBe('KUBIX');
    expect(doc.source).toBe('subgraph');
  });

  it('asks the contract when the holder has no TokenBalance row (zero vs not-yet-indexed)', async () => {
    queryMock.mockResolvedValue({
      participationTokenContract: { id: TOKEN.toLowerCase(), symbol: 'KUBIX' },
      tokenBalance: null,
    });
    const contract = {
      balanceOf: vi.fn(async () => ethers.utils.parseEther('7')),
      symbol: vi.fn(async () => 'SHOULD_NOT_BE_USED'),
    };
    createReadContractMock.mockReturnValue(contract);

    await balanceHandler.handler({ org: 'test-org', address: HOLDER, chain: 100 } as any);

    expect(contract.balanceOf).toHaveBeenCalledWith(HOLDER);
    // The symbol was already known — no redundant symbol() call.
    expect(contract.symbol).not.toHaveBeenCalled();
    const doc = jsonMock.mock.calls[0][0];
    expect(doc.balance).toBe('7.0');
    expect(doc.symbol).toBe('KUBIX');
    expect(doc.source).toBe('rpc');
  });

  it('falls back completely when the subgraph is unavailable, keeping the PT symbol guard', async () => {
    queryMock.mockRejectedValue(new Error('no subgraph on this chain'));
    const contract = {
      balanceOf: vi.fn(async () => ethers.utils.parseEther('1.5')),
      symbol: vi.fn(async () => { throw new Error('no symbol()'); }),
    };
    createReadContractMock.mockReturnValue(contract);

    await balanceHandler.handler({ org: 'test-org', address: HOLDER, chain: 100 } as any);

    const doc = jsonMock.mock.calls[0][0];
    expect(doc.balance).toBe('1.5');
    expect(doc.symbol).toBe('PT');
    expect(doc.source).toBe('rpc');
  });
});

describe('token balance — explicit --rpc', () => {
  let exitSpy: any;
  let logSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveTokenAddressMock.mockResolvedValue({ orgId: '0x' + '11'.repeat(32), tokenAddress: TOKEN });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('bypasses the subgraph entirely — --rpc names WHERE to read (a fork, a private node)', async () => {
    const contract = {
      balanceOf: vi.fn(async () => ethers.utils.parseEther('3')),
      symbol: vi.fn(async () => 'FORK'),
    };
    createReadContractMock.mockReturnValue(contract);

    await balanceHandler.handler({
      org: 'test-org', address: HOLDER, chain: 100, rpc: 'http://localhost:8545',
    } as any);

    expect(queryMock).not.toHaveBeenCalled();
    expect(createProviderMock).toHaveBeenCalledWith({ chainId: 100, rpcUrl: 'http://localhost:8545' });
    const doc = jsonMock.mock.calls[0][0];
    expect(doc.balance).toBe('3.0');
    expect(doc.symbol).toBe('FORK');
    expect(doc.source).toBe('rpc');
  });
});
