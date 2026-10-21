import { ethers } from 'ethers';
import { requireRawUint, RawUintInput } from '../amounts';

export const SUBJECT_TYPE = { ACCOUNT: 0, HAT: 1, ONBOARDING: 3, ORG_DEPLOY: 4, CLAIM: 5 } as const;
export type SponsorshipSubjectType = typeof SUBJECT_TYPE[keyof typeof SUBJECT_TYPE];
export const ZERO_SUBJECT = '0x' + '00'.repeat(32);

/** A literal address/uint/bytes32, never a lossy Number. */
export function subjectIdBytes32(input: RawUintInput): string {
  if (typeof input === 'string' && /^0x[\da-fA-F]{1,64}$/.test(input)) {
    input = BigInt(input);
  }
  return ethers.utils.hexZeroPad(ethers.BigNumber.from(requireRawUint(input)).toHexString(), 32);
}

function checkType(type: number): asserts type is SponsorshipSubjectType {
  if (!Object.values(SUBJECT_TYPE).includes(type as SponsorshipSubjectType)) throw new Error('Unsupported sponsorship subject type');
}

/** Only org-scoped ACCOUNT/HAT/CLAIM modes have this budget key. */
export function paymasterSubjectKey(type: number, id: RawUintInput): string {
  checkType(type);
  if (type !== SUBJECT_TYPE.ACCOUNT && type !== SUBJECT_TYPE.HAT && type !== SUBJECT_TYPE.CLAIM) throw new Error('Subject mode has no org budget key');
  return ethers.utils.solidityKeccak256(['uint8', 'bytes32'], [type, subjectIdBytes32(id)]);
}

export interface SponsorshipPayload {
  orgId: string;
  subjectType: SponsorshipSubjectType;
  subjectId: RawUintInput;
  ruleId?: RawUintInput;
  mailboxCommit?: RawUintInput;
}

/** v1: version|org|type|subject|rule|mailbox = 1+32+1+32+4+8 bytes. */
export function encodeSponsorshipPayload(payload: SponsorshipPayload): string {
  checkType(payload.subjectType);
  if (!/^0x[\da-fA-F]{64}$/.test(payload.orgId)) throw new Error('orgId must be bytes32');
  const id = subjectIdBytes32(payload.subjectId);
  if ((payload.subjectType === 3 || payload.subjectType === 4)
    && (payload.orgId.toLowerCase() !== ZERO_SUBJECT || id !== ZERO_SUBJECT || requireRawUint(payload.ruleId ?? 0, 32) !== '0')) throw new Error('Solidarity mode requires zero org, subject and generic rule');
  // ACCOUNT and CLAIM contract paths interpret subjectId as an address.
  if ((payload.subjectType === 0 || payload.subjectType === 5) && typeof payload.subjectId === 'string' && payload.subjectId.startsWith('0x') && !/^0x(?:[\da-fA-F]{40}|[\da-fA-F]{64})$/.test(payload.subjectId)) throw new Error('Address subject must be address or bytes32');
  if ((payload.subjectType === 0 || payload.subjectType === 5) && BigInt(id) >= 1n << 160n) throw new Error('Address subject exceeds 160 bits');
  return ethers.utils.solidityPack(['uint8', 'bytes32', 'uint8', 'bytes32', 'uint32', 'uint64'],
    [1, payload.orgId, payload.subjectType, id, requireRawUint(payload.ruleId ?? 0, 32), requireRawUint(payload.mailboxCommit ?? 0, 64)]);
}

export interface ParsedSponsorshipPayload {
  version: 1;
  orgId: string;
  subjectType: SponsorshipSubjectType;
  subjectId: string;
  ruleId: string;
  mailboxCommit: string;
}

export function parseSponsorshipPayload(data: string): ParsedSponsorshipPayload {
  if (!/^0x[\da-fA-F]{156}$/.test(data) || data.slice(2, 4) !== '01') throw new Error('Invalid v1 sponsorship payload');
  const payload: ParsedSponsorshipPayload = {
    version: 1, orgId: '0x' + data.slice(4, 68), subjectType: parseInt(data.slice(68, 70), 16) as SponsorshipSubjectType,
    subjectId: '0x' + data.slice(70, 134), ruleId: BigInt('0x' + data.slice(134, 142)).toString(), mailboxCommit: BigInt('0x' + data.slice(142, 158)).toString(),
  };
  encodeSponsorshipPayload(payload); // Identical validation in both directions.
  return payload;
}
