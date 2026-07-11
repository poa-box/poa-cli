import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { MULTICALL3, getEthBalanceCall } from '../../src/lib/multicall';
import {
  runPreflight,
  checkGasBalance,
  checkHasHat,
  checkUsernameFree,
  checkTaskStatus,
  checkProposalActive,
  PreflightCheck,
} from '../../src/lib/preflight';
import { PreconditionError } from '../../src/lib/errors';
import { TASK_STATUS } from '../../src/lib/task-lens';

const HATS = ethers.utils.getAddress('0x' + 'aa'.repeat(20));
const REGISTRY = ethers.utils.getAddress('0x' + 'bb'.repeat(20));
const TM = ethers.utils.getAddress('0x' + 'cc'.repeat(20));
const VOTING = ethers.utils.getAddress('0x' + 'dd'.repeat(20));
const WALLET = ethers.utils.getAddress('0x' + 'ee'.repeat(20));
const OTHER = ethers.utils.getAddress('0x' + '99'.repeat(20));

const MC_IFACE = new ethers.utils.Interface([
  'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) returns (tuple(bool success, bytes returnData)[] returnData)',
]);
const TRY_AGGREGATE = MC_IFACE.getSighash('tryAggregate');

const uintWord = (n: ethers.BigNumberish) => ethers.utils.defaultAbiCoder.encode(['uint256'], [n]);
const addrWord = (a: string) => ethers.utils.defaultAbiCoder.encode(['address'], [a]);

const V6_TYPES = ['bytes32', 'uint96', 'address', 'uint96', 'bool', 'uint8', 'address', 'uint48', 'uint32', 'uint48'];

function encodeTaskTuple(overrides: Partial<{ status: number; claimer: string; claimDeadline: number }> = {}): string {
  const t = {
    status: TASK_STATUS.UNCLAIMED,
    claimer: ethers.constants.AddressZero,
    claimDeadline: 0,
    ...overrides,
  };
  return ethers.utils.defaultAbiCoder.encode(V6_TYPES, [
    ethers.utils.hexZeroPad('0x01', 32), 0, t.claimer, 0, false, t.status,
    ethers.constants.AddressZero, 0, 0, t.claimDeadline,
  ]);
}

/** Wrap a task tuple the way getLensData returns it: abi-encoded `bytes`. */
function lensReturn(tuplePayload: string): string {
  return ethers.utils.defaultAbiCoder.encode(['bytes'], [tuplePayload]);
}

type Handler = (to: string, data: string) => string;

/**
 * Mock provider. With multicall enabled, batched tryAggregate calls are
 * unwrapped and each inner call routed through `handler` (throw → success
 * false). With multicall disabled, getCode returns '0x' and direct calls
 * hit `handler`; native balances come from `balances` (default 1 ether).
 */
function makeProvider(handler: Handler, opts?: { multicall?: boolean; balances?: Record<string, ethers.BigNumber> }) {
  const multicall = opts?.multicall ?? true;
  const calls: Array<{ to: string; data: string }> = [];
  return {
    calls,
    async getCode(address: string): Promise<string> {
      return multicall && address === MULTICALL3 ? '0x60806040' : '0x';
    },
    async call(tx: { to: string; data: string }): Promise<string> {
      calls.push(tx);
      if (multicall && tx.to === MULTICALL3 && tx.data.startsWith(TRY_AGGREGATE)) {
        const [, batched] = MC_IFACE.decodeFunctionData('tryAggregate', tx.data);
        const results = batched.map((c: { target: string; callData: string }) => {
          try {
            return [true, handler(c.target, c.callData)];
          } catch {
            return [false, '0x'];
          }
        });
        return MC_IFACE.encodeFunctionResult('tryAggregate', [results]);
      }
      return handler(tx.to, tx.data);
    },
    async getBalance(address: string): Promise<ethers.BigNumber> {
      return opts?.balances?.[address] ?? ethers.utils.parseEther('1');
    },
  } as any;
}

/** Handler answering every check builder's call with a configurable state. */
function handlerFor(state: {
  balanceWei?: ethers.BigNumber;
  hatBalance?: number;
  usernameHolder?: string;
  taskTuple?: string;
  proposalsCount?: number;
} = {}): Handler {
  return (to: string) => {
    if (to === MULTICALL3) return uintWord(state.balanceWei ?? ethers.utils.parseEther('1')); // getEthBalance
    if (to === HATS) return uintWord(state.hatBalance ?? 1);
    if (to === REGISTRY) return addrWord(state.usernameHolder ?? ethers.constants.AddressZero);
    if (to === TM) return lensReturn(state.taskTuple ?? encodeTaskTuple());
    if (to === VOTING) return uintWord(state.proposalsCount ?? 10);
    throw new Error(`no handler for ${to}`);
  };
}

async function captureError(promise: Promise<void>): Promise<any> {
  return promise.then(
    () => {
      throw new Error('expected runPreflight to reject');
    },
    (err) => err
  );
}

describe('runPreflight', () => {
  it('resolves when every check passes, batching all calls into one RPC', async () => {
    const provider = makeProvider(handlerFor());
    const localRan: string[] = [];
    const checks: PreflightCheck[] = [
      checkGasBalance(WALLET),
      checkHasHat(HATS, WALLET, 5),
      checkUsernameFree(REGISTRY, 'alice'),
      checkTaskStatus(TM, 1, [TASK_STATUS.UNCLAIMED]),
      checkProposalActive(VOTING, 2),
      { label: 'local', local: () => (localRan.push('yes'), { ok: true }) },
    ];

    await expect(runPreflight(provider, checks)).resolves.toBeUndefined();
    expect(localRan).toEqual(['yes']);
    // All five contract reads went through a single tryAggregate call
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].to).toBe(MULTICALL3);
  });

  it('throws PreconditionError (code 4) listing a single failure with its suggestion', async () => {
    const provider = makeProvider(handlerFor({ hatBalance: 0 }));
    const err = await captureError(
      runPreflight(provider, [checkGasBalance(WALLET), checkHasHat(HATS, WALLET, 5)])
    );

    expect(err).toBeInstanceOf(PreconditionError);
    expect(err.code).toBe(4);
    expect(err.message).toContain('Pre-flight checks failed:');
    expect(err.message).toContain(`  ✗ role (hat): ${WALLET} does not wear hat 5`);
    expect(err.message).toContain('(list org roles with pop org roles, then request one via pop role apply)');
    // Passing checks are not listed
    expect(err.message).not.toContain('gas balance');
  });

  it('collects ALL failures in check order, not just the first', async () => {
    const provider = makeProvider(handlerFor({
      balanceWei: ethers.BigNumber.from(0),
      hatBalance: 0,
      usernameHolder: OTHER,
    }));
    const err = await captureError(
      runPreflight(provider, [
        checkGasBalance(WALLET),
        checkHasHat(HATS, WALLET, 7),
        checkUsernameFree(REGISTRY, 'bob'),
      ])
    );

    expect(err).toBeInstanceOf(PreconditionError);
    expect(err.message.match(/✗/g)).toHaveLength(3);
    const gasIdx = err.message.indexOf('✗ gas balance');
    const hatIdx = err.message.indexOf('✗ role (hat)');
    const nameIdx = err.message.indexOf('✗ username "bob"');
    expect(gasIdx).toBeGreaterThan(-1);
    expect(hatIdx).toBeGreaterThan(gasIdx);
    expect(nameIdx).toBeGreaterThan(hatIdx);
    expect(err.message).toContain(`already registered to ${OTHER}`);
  });

  it('reports low gas with ETH-denominated detail and a funding suggestion', async () => {
    const provider = makeProvider(handlerFor({ balanceWei: ethers.utils.parseEther('0.00005') }));
    const err = await captureError(runPreflight(provider, [checkGasBalance(WALLET)]));

    expect(err.message).toContain('0.00005');
    expect(err.message).toContain('0.0001');
    expect(err.message).toContain(`fund ${WALLET}`);
  });

  it('skip bypasses everything without touching the provider', async () => {
    const provider: any = {
      getCode() { throw new Error('provider should not be touched'); },
      call() { throw new Error('provider should not be touched'); },
      getBalance() { throw new Error('provider should not be touched'); },
    };

    await expect(
      runPreflight(provider, [checkGasBalance(WALLET), checkHasHat(HATS, WALLET, 1)], { skip: true })
    ).resolves.toBeUndefined();
    await expect(runPreflight(provider, [])).resolves.toBeUndefined();
  });

  it('collects failures from local checks (thrown errors become details)', async () => {
    const provider = makeProvider(handlerFor());
    const err = await captureError(
      runPreflight(provider, [
        { label: 'duplicate scan', local: () => ({ ok: false, detail: 'similar task exists', suggestion: 'use --force' }) },
        { label: 'flaky local', local: async () => { throw new Error('boom'); } },
      ])
    );

    expect(err.message).toContain('  ✗ duplicate scan: similar task exists (use --force)');
    expect(err.message).toContain('  ✗ flaky local: boom');
  });

  describe('when Multicall3 is unavailable (getCode returns 0x)', () => {
    it('falls back to direct calls and eth_getBalance, still passing', async () => {
      const provider = makeProvider(handlerFor(), { multicall: false });
      await expect(
        runPreflight(provider, [checkGasBalance(WALLET), checkHasHat(HATS, WALLET, 5)])
      ).resolves.toBeUndefined();
      // Only the hat check goes through eth_call; the balance uses getBalance
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].to).toBe(HATS);
    });

    it('maps a throwing direct call to a check failure instead of crashing', async () => {
      const provider = makeProvider(
        (to) => {
          if (to === REGISTRY) throw new Error('execution reverted');
          return handlerFor()(to, '');
        },
        { multicall: false, balances: { [WALLET]: ethers.BigNumber.from(0) } }
      );
      const err = await captureError(
        runPreflight(provider, [
          checkGasBalance(WALLET),
          checkUsernameFree(REGISTRY, 'carol'),
          checkHasHat(HATS, WALLET, 5),
        ])
      );

      expect(err).toBeInstanceOf(PreconditionError);
      expect(err.message).toContain('✗ gas balance');
      expect(err.message).toContain('✗ username "carol": could not query the account registry');
      expect(err.message).not.toContain('role (hat)');
    });
  });
});

describe('checkTaskStatus interpret', () => {
  const NOW = 1750000000;

  it('passes when the status is in the allowed set', () => {
    const check = checkTaskStatus(TM, 5, [TASK_STATUS.UNCLAIMED]);
    const result = check.interpret!(lensReturn(encodeTaskTuple({ status: TASK_STATUS.UNCLAIMED })), true);
    expect(result.ok).toBe(true);
  });

  it('fails with readable status names when disallowed', () => {
    const check = checkTaskStatus(TM, 5, [TASK_STATUS.UNCLAIMED, TASK_STATUS.SUBMITTED]);
    const result = check.interpret!(
      lensReturn(encodeTaskTuple({ status: TASK_STATUS.COMPLETED })),
      true
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('status is COMPLETED, expected UNCLAIMED or SUBMITTED');
  });

  it('allows expired-claim takeover, naming the previous claimer', () => {
    const check = checkTaskStatus(TM, 5, [TASK_STATUS.UNCLAIMED], { allowExpiredTakeover: true, now: NOW });
    const expired = check.interpret!(
      lensReturn(encodeTaskTuple({ status: TASK_STATUS.CLAIMED, claimer: OTHER, claimDeadline: NOW - 100 })),
      true
    );
    expect(expired.ok).toBe(true);
    expect(expired.detail).toContain(OTHER);
    expect(expired.detail).toContain('expired');

    const active = check.interpret!(
      lensReturn(encodeTaskTuple({ status: TASK_STATUS.CLAIMED, claimer: OTHER, claimDeadline: NOW + 5000 })),
      true
    );
    expect(active.ok).toBe(false);
    expect(active.detail).toContain('claim deadline has not passed');
  });

  it('enforces claimerMustBe case-insensitively', () => {
    const tuple = lensReturn(encodeTaskTuple({ status: TASK_STATUS.CLAIMED, claimer: WALLET }));
    const match = checkTaskStatus(TM, 5, [TASK_STATUS.CLAIMED], { claimerMustBe: WALLET.toLowerCase() });
    expect(match.interpret!(tuple, true).ok).toBe(true);

    const mismatch = checkTaskStatus(TM, 5, [TASK_STATUS.CLAIMED], { claimerMustBe: OTHER });
    const result = mismatch.interpret!(tuple, true);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(WALLET);
    expect(result.detail).toContain(OTHER);
  });

  it('fails gracefully when the lens call itself failed', () => {
    const check = checkTaskStatus(TM, 999, [TASK_STATUS.UNCLAIMED]);
    const result = check.interpret!('0x', false);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('may not exist');
  });
});

describe('checkProposalActive interpret', () => {
  it('passes when proposalsCount > id and fails with a range explanation otherwise', () => {
    const check = checkProposalActive(VOTING, 2);
    expect(check.interpret!(uintWord(3), true).ok).toBe(true);

    const outOfRange = checkProposalActive(VOTING, 5).interpret!(uintWord(3), true);
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.detail).toContain('proposal IDs run 0 to 2');

    const empty = checkProposalActive(VOTING, 0).interpret!(uintWord(0), true);
    expect(empty.ok).toBe(false);
    expect(empty.detail).toContain('no proposals have been created yet');
  });
});
