import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  STORAGE_KEYS,
  TASK_STATUS,
  taskStatusName,
  encodeLensCall,
  decodeTaskInfo,
  getTaskOnChain,
  deriveClaimState,
  TaskOnChain,
} from '../../src/lib/task-lens';

const TM = '0x' + 'cc'.repeat(20);
const PROJECT_ID = ethers.utils.hexZeroPad('0xabcd', 32);
const CLAIMER = ethers.utils.getAddress('0x' + '11'.repeat(20));
const BOUNTY_TOKEN = ethers.utils.getAddress('0x' + '22'.repeat(20));

/** Field order verified against decodeTaskInfo's TASK_TUPLE_V6. */
const V6_TYPES = ['bytes32', 'uint96', 'address', 'uint96', 'bool', 'uint8', 'address', 'uint48', 'uint32', 'uint48'];
const LEGACY_TYPES = ['bytes32', 'uint96', 'address', 'uint96', 'bool', 'uint8', 'address'];

function encodeV6Tuple(overrides: Partial<{
  projectId: string; payout: ethers.BigNumberish; claimer: string; bountyPayout: ethers.BigNumberish;
  requiresApplication: boolean; status: number; bountyToken: string;
  absoluteDeadline: number; completionWindow: number; claimDeadline: number;
}> = {}): string {
  const t = {
    projectId: PROJECT_ID,
    payout: ethers.utils.parseEther('12'),
    claimer: CLAIMER,
    bountyPayout: 500,
    requiresApplication: true,
    status: TASK_STATUS.CLAIMED,
    bountyToken: BOUNTY_TOKEN,
    absoluteDeadline: 1750000000,
    completionWindow: 86400,
    claimDeadline: 1749990000,
    ...overrides,
  };
  return ethers.utils.defaultAbiCoder.encode(V6_TYPES, [
    t.projectId, t.payout, t.claimer, t.bountyPayout, t.requiresApplication,
    t.status, t.bountyToken, t.absoluteDeadline, t.completionWindow, t.claimDeadline,
  ]);
}

/** Wrap a tuple payload the way getLensData returns it: abi-encoded `bytes`. */
function lensReturn(tuplePayload: string): string {
  return ethers.utils.defaultAbiCoder.encode(['bytes'], [tuplePayload]);
}

function mockProvider(handler: (tx: { to: string; data: string }) => string) {
  return {
    async call(tx: { to: string; data: string }): Promise<string> {
      return handler(tx);
    },
  } as unknown as ethers.providers.Provider;
}

describe('getTaskOnChain', () => {
  it('sends a getLensData(TASK_INFO, abi.encode(id)) call and decodes the v6 tuple', async () => {
    const requests: Array<{ to: string; data: string }> = [];
    const provider = mockProvider((tx) => {
      requests.push(tx);
      return lensReturn(encodeV6Tuple());
    });

    const task = await getTaskOnChain(provider, TM, 7);

    expect(requests).toHaveLength(1);
    expect(requests[0].to).toBe(TM);
    expect(requests[0].data).toBe(
      encodeLensCall(STORAGE_KEYS.TASK_INFO, ethers.utils.defaultAbiCoder.encode(['uint256'], [7]))
    );

    expect(task.projectId).toBe(PROJECT_ID);
    expect(task.payout.eq(ethers.utils.parseEther('12'))).toBe(true);
    expect(task.claimer).toBe(CLAIMER);
    expect(task.bountyPayout.toNumber()).toBe(500);
    expect(task.requiresApplication).toBe(true);
    expect(task.status).toBe(TASK_STATUS.CLAIMED);
    expect(task.bountyToken).toBe(BOUNTY_TOKEN);
    expect(task.absoluteDeadline).toBe(1750000000);
    expect(task.completionWindow).toBe(86400);
    expect(task.claimDeadline).toBe(1749990000);
  });

  it('accepts subgraph-format IDs ("contractAddress-taskId")', async () => {
    let requestData = '';
    const provider = mockProvider((tx) => {
      requestData = tx.data;
      return lensReturn(encodeV6Tuple());
    });

    await getTaskOnChain(provider, TM, `${TM.toLowerCase()}-42`);
    expect(requestData).toBe(
      encodeLensCall(STORAGE_KEYS.TASK_INFO, ethers.utils.defaultAbiCoder.encode(['uint256'], [42]))
    );
  });

  it('decodes legacy 7-field payloads with undefined deadline fields', async () => {
    const legacy = ethers.utils.defaultAbiCoder.encode(LEGACY_TYPES, [
      PROJECT_ID, 1000, CLAIMER, 0, false, TASK_STATUS.SUBMITTED, ethers.constants.AddressZero,
    ]);
    const provider = mockProvider(() => lensReturn(legacy));

    const task = await getTaskOnChain(provider, TM, 3);
    expect(task.status).toBe(TASK_STATUS.SUBMITTED);
    expect(task.payout.toNumber()).toBe(1000);
    expect(task.absoluteDeadline).toBeUndefined();
    expect(task.completionWindow).toBeUndefined();
    expect(task.claimDeadline).toBeUndefined();
  });
});

describe('decodeTaskInfo', () => {
  it('round-trips a v6 tuple', () => {
    const task = decodeTaskInfo(encodeV6Tuple({ status: TASK_STATUS.UNCLAIMED, claimer: ethers.constants.AddressZero }));
    expect(task.status).toBe(TASK_STATUS.UNCLAIMED);
    expect(task.claimer).toBe(ethers.constants.AddressZero);
    expect(task.absoluteDeadline).toBe(1750000000);
  });

  it('falls back to the legacy tuple when the payload is only 7 words', () => {
    const legacy = ethers.utils.defaultAbiCoder.encode(LEGACY_TYPES, [
      PROJECT_ID, 0, ethers.constants.AddressZero, 0, false, TASK_STATUS.UNCLAIMED, ethers.constants.AddressZero,
    ]);
    const task = decodeTaskInfo(legacy);
    expect(task.status).toBe(TASK_STATUS.UNCLAIMED);
    expect(task.claimDeadline).toBeUndefined();
  });
});

describe('deriveClaimState', () => {
  const NOW = 1750000000;

  function claimedTask(overrides: Partial<TaskOnChain> = {}): TaskOnChain {
    return {
      projectId: PROJECT_ID,
      payout: ethers.BigNumber.from(0),
      claimer: CLAIMER,
      bountyPayout: ethers.BigNumber.from(0),
      requiresApplication: false,
      status: TASK_STATUS.CLAIMED,
      bountyToken: ethers.constants.AddressZero,
      absoluteDeadline: 0,
      completionWindow: 0,
      claimDeadline: 0,
      ...overrides,
    };
  }

  it('returns none for non-CLAIMED statuses regardless of deadlines', () => {
    expect(deriveClaimState(claimedTask({ status: TASK_STATUS.UNCLAIMED, claimDeadline: NOW - 100 }), NOW)).toBe('none');
    expect(deriveClaimState(claimedTask({ status: TASK_STATUS.SUBMITTED, claimDeadline: NOW - 100 }), NOW)).toBe('none');
  });

  it('returns none for CLAIMED with no deadline (zero/undefined)', () => {
    expect(deriveClaimState(claimedTask(), NOW)).toBe('none');
    expect(deriveClaimState(claimedTask({ claimDeadline: undefined, absoluteDeadline: undefined }), NOW)).toBe('none');
  });

  it('is expired only strictly after the deadline: exactly-now is still expiring-soon', () => {
    // Implementation uses `deadline < ts` — a deadline of exactly now is not yet expired
    expect(deriveClaimState(claimedTask({ claimDeadline: NOW }), NOW)).toBe('expiring-soon');
    expect(deriveClaimState(claimedTask({ claimDeadline: NOW - 1 }), NOW)).toBe('expired-claimable');
  });

  it('flags expiring-soon inside the 24h window (inclusive boundary)', () => {
    expect(deriveClaimState(claimedTask({ claimDeadline: NOW + 3600 }), NOW)).toBe('expiring-soon');
    expect(deriveClaimState(claimedTask({ claimDeadline: NOW + 24 * 3600 }), NOW)).toBe('expiring-soon');
    expect(deriveClaimState(claimedTask({ claimDeadline: NOW + 24 * 3600 + 1 }), NOW)).toBe('on-track');
  });

  it('prefers claimDeadline over absoluteDeadline', () => {
    expect(deriveClaimState(claimedTask({ claimDeadline: NOW + 48 * 3600, absoluteDeadline: NOW - 100 }), NOW)).toBe('on-track');
    // Zero claimDeadline falls through to absoluteDeadline
    expect(deriveClaimState(claimedTask({ claimDeadline: 0, absoluteDeadline: NOW - 100 }), NOW)).toBe('expired-claimable');
  });
});

describe('taskStatusName', () => {
  it('names all five statuses and marks unknowns', () => {
    expect(taskStatusName(TASK_STATUS.UNCLAIMED)).toBe('UNCLAIMED');
    expect(taskStatusName(TASK_STATUS.CANCELLED)).toBe('CANCELLED');
    expect(taskStatusName(9)).toBe('UNKNOWN(9)');
  });
});
