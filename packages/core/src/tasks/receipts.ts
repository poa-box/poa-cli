import { ethers } from 'ethers';
import { requireRawUint, RawUintInput } from '../amounts';
import { Fact, knownFact, unknownFact } from '../data/facts';
import { metadataPointerToBytes32 } from '../encoding/cid';
import { getAbi } from '../contracts';

export interface TaskCreationEvidence {
  projectId: string; payoutRaw: RawUintInput; title: string; metadataHash: string;
  bountyToken: string; bountyPayoutRaw: RawUintInput; requiresApplication: boolean;
}
export interface TaskReceiptInput {
  taskManagerAddress: string;
  /** Must attest successful outer execution; the host separately verifies userOp inner outcome. */
  status: number | boolean;
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
  creations: readonly TaskCreationEvidence[];
  /**
   * Explicit HOST attestation: logs contain all creation events from exactly
   * one successfully executed operation, in their original emission order.
   * The host has already verified inner success and isolated that operation
   * (e.g. its UserOp), excluding other operations and unrelated creations.
   * An outer receipt alone never establishes this scope. Repeated identical
   * drafts may then consume matching events in submitted occurrence order.
   */
  creationLogScope?: 'ordered-single-operation';
}
/** Authoritative emitted IDs in requested draft order; no indexed-max predictions. */
export function parseTaskCreatedReceipt(input: TaskReceiptInput): Fact<readonly string[]> {
  try {
    const emitter = ethers.utils.getAddress(input.taskManagerAddress).toLowerCase();
    if (emitter === ethers.constants.AddressZero || (input.status !== 1 && input.status !== true)) return unknownFact('RECEIPT_NOT_SUCCESSFUL');
    if (!input.creations.length) return unknownFact('MISSING_CREATION_EVIDENCE');
    const iface = new ethers.utils.Interface(getAbi('TaskManagerNew'));
    const topic = iface.getEventTopic('TaskCreated');
    if (input.creationLogScope !== undefined && input.creationLogScope !== 'ordered-single-operation') return unknownFact('INVALID_CREATION_LOG_SCOPE');
    const scoped = input.creationLogScope === 'ordered-single-operation';
    const records: ethers.utils.LogDescription[] = [];
    for (const log of input.logs) {
      if (log.topics[0]?.toLowerCase() !== topic.toLowerCase()) continue;
      if (ethers.utils.getAddress(log.address).toLowerCase() !== emitter) {
        if (scoped) return unknownFact('FOREIGN_TASK_CREATED');
        continue;
      }
      const record = iface.parseLog({ topics: [...log.topics], data: log.data });
      // Reject extra topics, trailing bytes and noncanonical/malformed encodings.
      const encoded = iface.encodeEventLog(iface.getEvent('TaskCreated'), record.args);
      if (encoded.data.toLowerCase() !== log.data.toLowerCase() || encoded.topics.length !== log.topics.length
        || encoded.topics.some((value, index) => value.toLowerCase() !== log.topics[index].toLowerCase())) return unknownFact('INVALID_TASK_CREATED_EVIDENCE');
      records.push(record);
    }
    if (scoped && records.length !== input.creations.length) return unknownFact('TASK_CREATED_CARDINALITY_MISMATCH');
    const recordIds = records.map(row => row.args[0].toString());
    if (new Set(recordIds).size !== recordIds.length) return unknownFact('DUPLICATE_TASK_CREATED');
    const consumed = new Set<ethers.utils.LogDescription>();
    const ids: string[] = [];
    for (const expected of input.creations) {
      if (!ethers.utils.isHexString(expected.projectId, 32) || typeof expected.requiresApplication !== 'boolean') throw new Error('Invalid creation evidence');
      const hash = (expected.metadataHash === ethers.constants.HashZero ? expected.metadataHash : metadataPointerToBytes32(expected.metadataHash)).toLowerCase();
      const payout = requireRawUint(expected.payoutRaw);
      const bounty = requireRawUint(expected.bountyPayoutRaw);
      const token = ethers.utils.getAddress(expected.bountyToken).toLowerCase();
      const title = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(expected.title));
      const matches = records.filter(record => !consumed.has(record)).filter(({ args: a }) => a[1].toLowerCase() === expected.projectId.toLowerCase()
        && a[2].toString() === payout && a[3].toLowerCase() === token && a[4].toString() === bounty
        && a[5] === expected.requiresApplication && a[6].toLowerCase() === title.toLowerCase() && a[7].toLowerCase() === hash);
      if (!matches.length || (!scoped && matches.length !== 1)) return unknownFact(matches.length ? 'AMBIGUOUS_TASK_CREATED' : 'MISSING_TASK_CREATED');
      const id = matches[0].args[0].toString();
      consumed.add(matches[0]);
      ids.push(id);
    }
    return knownFact(ids);
  } catch { return unknownFact('INVALID_TASK_CREATED_EVIDENCE'); }
}
