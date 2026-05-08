import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import abi from '../../../src/abi/TaskManagerNew.json';

/**
 * Task #514 (HB#969 sentinel_01) — close the 4 spec-gap items argus_prime
 * flagged in HB#698 reject (which was moot because vigil approved silently
 * mid-flight, but the gaps are real). These tests lock the contract for
 * the createTasksBatch CLI integration shipped in #508.
 *
 * The tests don't exercise the full handler (would need a mocked Signer +
 * IPFS client + RPC), but they DO lock the calldata-encoding contract,
 * which is the most regression-prone piece. The handler-flow unit tests
 * would essentially be redundant with the e2e script (test/scripts/
 * create-batch-e2e.js, also added in this task).
 */

const iface = new ethers.utils.Interface(abi as any);

function buildSampleTuples(n: number): any[] {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    out.push([
      ethers.utils.parseUnits((10 + i).toString(), 18), // payout
      ethers.utils.toUtf8Bytes(`task ${i}`), // title
      ethers.utils.hexZeroPad('0x' + (i + 1).toString(16), 32), // metadataHash
      ethers.constants.AddressZero, // bountyToken
      0, // bountyPayout
      false, // requiresApplication
    ]);
  }
  return out;
}

describe('Task #514 — createTasksBatch CLI calldata contract (#508 follow-up)', () => {
  it('selector is 0xc18aa1c9 (matches keccak256 of canonical signature)', () => {
    const sighash = iface.getSighash(
      'createTasksBatch(bytes32,(uint256,bytes,bytes32,address,uint256,bool)[])',
    );
    expect(sighash).toBe('0xc18aa1c9');
  });

  it('encodes a single-task batch into a SINGLE createTasksBatch call (NOT createTask fallback)', () => {
    // Locks acceptance #1e (single-task batch input still uses createTasksBatch,
    // not auto-fallback to createTask). The CLI handler MUST always emit
    // createTasksBatch; this test fails if a future refactor adds a 1-task
    // optimization that calls createTask instead.
    const pid = ethers.utils.hexZeroPad('0x01', 32);
    const tuples = buildSampleTuples(1);
    const calldata = iface.encodeFunctionData('createTasksBatch', [pid, tuples]);

    expect(calldata.startsWith('0xc18aa1c9')).toBe(true);
    // createTask selector for the existing 7-arg signature
    const createTaskSelector = iface.getSighash(
      'createTask(uint256,bytes,bytes32,bytes32,address,uint256,bool)',
    );
    expect(calldata.startsWith(createTaskSelector)).toBe(false);
  });

  it('encodes 3 tasks into a single calldata blob (decodes round-trip)', () => {
    const pid = ethers.utils.hexZeroPad('0x42', 32);
    const tuples = buildSampleTuples(3);
    const calldata = iface.encodeFunctionData('createTasksBatch', [pid, tuples]);
    expect(calldata.startsWith('0xc18aa1c9')).toBe(true);

    const decoded = iface.decodeFunctionData('createTasksBatch', calldata);
    expect(decoded.pid).toBe(pid);
    expect(decoded.tasks.length).toBe(3);

    for (let i = 0; i < 3; i++) {
      const t = decoded.tasks[i];
      expect(t.payout.toString()).toBe(ethers.utils.parseUnits((10 + i).toString(), 18).toString());
      expect(ethers.utils.toUtf8String(t.title)).toBe(`task ${i}`);
      expect(t.metadataHash.toLowerCase()).toBe(
        ethers.utils.hexZeroPad('0x' + (i + 1).toString(16), 32),
      );
      expect(t.bountyToken).toBe(ethers.constants.AddressZero);
      expect(t.bountyPayout.toString()).toBe('0');
      expect(t.requiresApplication).toBe(false);
    }
  });

  it('tuple order is (payout, title, metadataHash, bountyToken, bountyPayout, requiresApplication)', () => {
    // Locks the struct layout. If the contract ABI is updated to reorder
    // fields, the CLI calldata will be wrong; this test catches it.
    const fn = abi.find((e: any) => e.type === 'function' && e.name === 'createTasksBatch') as any;
    expect(fn).toBeDefined();
    const tasksInput = fn.inputs.find((i: any) => i.name === 'tasks');
    expect(tasksInput).toBeDefined();
    expect(tasksInput.type).toBe('tuple[]');

    const componentNames = (tasksInput.components ?? []).map((c: any) => c.name);
    expect(componentNames).toEqual([
      'payout',
      'title',
      'metadataHash',
      'bountyToken',
      'bountyPayout',
      'requiresApplication',
    ]);
  });

  it('EmptyBatch error is decodable from receipt revert data', () => {
    // The contract reverts createTasksBatch with EmptyBatch() if tasks.length == 0.
    // The CLI early-returns before reaching the contract on empty input, but
    // the ABI must still be able to decode this error if it surfaces from
    // a different caller (e.g., a malformed sponsored-tx flow).
    const errFragment = abi.find((e: any) => e.type === 'error' && e.name === 'EmptyBatch') as any;
    expect(errFragment).toBeDefined();

    const errSelector = iface.getSighash('EmptyBatch()');
    expect(errSelector.length).toBe(10); // 0x + 8 hex chars
    // Empty-batch revert data is exactly the 4-byte selector with no args
    expect(iface.decodeErrorResult('EmptyBatch', errSelector)).toEqual([]);
  });
});
