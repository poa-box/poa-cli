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
}
/** Authoritative emitted IDs in requested draft order; no indexed-max predictions. */
export function parseTaskCreatedReceipt(input: TaskReceiptInput): Fact<readonly string[]> {
  try {
    const emitter = ethers.utils.getAddress(input.taskManagerAddress).toLowerCase();
    if (emitter === ethers.constants.AddressZero || (input.status !== 1 && input.status !== true)) return unknownFact('RECEIPT_NOT_SUCCESSFUL');
    if (!input.creations.length) return unknownFact('MISSING_CREATION_EVIDENCE');
    const iface = new ethers.utils.Interface(getAbi('TaskManagerNew'));
    const topic = iface.getEventTopic('TaskCreated');
    const records: ethers.utils.LogDescription[] = [];
    for (const log of input.logs) {
      if (log.address.toLowerCase() !== emitter || log.topics[0]?.toLowerCase() !== topic.toLowerCase()) continue;
      records.push(iface.parseLog({ topics: [...log.topics], data: log.data }));
    }
    const ids: string[] = [];
    for (const expected of input.creations) {
      if (!ethers.utils.isHexString(expected.projectId, 32) || typeof expected.requiresApplication !== 'boolean') throw new Error('Invalid creation evidence');
      const hash = metadataPointerToBytes32(expected.metadataHash).toLowerCase();
      const payout = requireRawUint(expected.payoutRaw);
      const bounty = requireRawUint(expected.bountyPayoutRaw);
      const token = ethers.utils.getAddress(expected.bountyToken).toLowerCase();
      const title = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(expected.title));
      const matches = records.filter(({ args: a }) => a[1].toLowerCase() === expected.projectId.toLowerCase()
        && a[2].toString() === payout && a[3].toLowerCase() === token && a[4].toString() === bounty
        && a[5] === expected.requiresApplication && a[6].toLowerCase() === title.toLowerCase() && a[7].toLowerCase() === hash);
      if (matches.length !== 1) return unknownFact(matches.length ? 'AMBIGUOUS_TASK_CREATED' : 'MISSING_TASK_CREATED');
      const id = matches[0].args[0].toString();
      if (ids.includes(id) || records.filter(row => row.args[0].toString() === id).length !== 1) return unknownFact('DUPLICATE_TASK_CREATED');
      ids.push(id);
    }
    return knownFact(ids);
  } catch { return unknownFact('INVALID_TASK_CREATED_EVIDENCE'); }
}
