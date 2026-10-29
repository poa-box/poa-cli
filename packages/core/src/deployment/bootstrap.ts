/** Authority genesis only. Normal project writes must leave the retired role arrays empty. */
import { ethers } from 'ethers';
import { parseDecimalAmountToRaw, requireRawUint, type RawUintInput } from '../amounts';
import { metadataPointerToBytes32 } from '../encoding/cid';

export type BootstrapAmount = { raw: RawUintInput; decimal?: never; decimals?: never }
  | { decimal: string; decimals: number; raw?: never };

export interface BootstrapProjectInput {
  title: string;
  /** Prepared CIDv0/nonzero bytes32; omission or literal HashZero means no metadata. */
  metadataHash?: string;
  cap?: BootstrapAmount;
  managers?: string[];
  createRoleIndices?: number[];
  claimRoleIndices?: number[];
  reviewRoleIndices?: number[];
  assignRoleIndices?: number[];
  bountyTokens?: string[];
  bountyCaps?: BootstrapAmount[];
}

export interface BootstrapTaskInput {
  projectIndex: number;
  payout: BootstrapAmount;
  title: string;
  metadataHash?: string;
  bountyToken?: string;
  bountyPayout?: BootstrapAmount;
  requiresApplication?: boolean;
}

export interface BootstrapConfigInput {
  projects: BootstrapProjectInput[];
  tasks: BootstrapTaskInput[];
}

export type BootstrapProjectTuple = [string, string, string, string[], string[], string[], string[], string[], string[], string[]];
export type BootstrapTaskTuple = [number, string, string, string, string, string, boolean];
export type BootstrapConfigTuple = [BootstrapProjectTuple[], BootstrapTaskTuple[]];

const MAX_PAYOUT = 10n ** 24n;
const UNLIMITED = (1n << 128n) - 1n;

function amount(value: BootstrapAmount | undefined, kind: 'cap' | 'payout' | 'bounty'): string {
  if (value !== undefined && (!value || typeof value !== 'object'
    || (value.raw !== undefined && ('decimal' in value || 'decimals' in value)))) throw new Error('Bootstrap amount must be raw OR decimal with explicit decimals');
  const raw = value === undefined ? '0' : value.raw !== undefined ? requireRawUint(value.raw)
    : parseDecimalAmountToRaw(value.decimal!, value.decimals!);
  const n = BigInt(raw);
  if ((kind === 'payout' && n === 0n) || (n > MAX_PAYOUT && !(kind === 'cap' && n === UNLIMITED))) {
    throw new Error('Bootstrap ' + kind + ' exceeds contract limits');
  }
  return raw;
}

function shares(value: BootstrapAmount | undefined, kind: 'cap' | 'payout'): string {
  if (value?.decimal !== undefined && value.decimals !== 18) throw new Error('Participation-token decimals must be 18');
  return amount(value, kind);
}

function title(value: string): string {
  if (typeof value !== 'string') throw new Error('Bootstrap title must be text');
  const bytes = ethers.utils.toUtf8Bytes(value);
  if (!value.trim() || bytes.length > 256) throw new Error('Bootstrap title must be nonblank and at most 256 UTF-8 bytes');
  return ethers.utils.hexlify(bytes);
}

function address(value: string, nonzero = true): string {
  if (!ethers.utils.isAddress(value) || (nonzero && value.toLowerCase() === ethers.constants.AddressZero)) throw new Error('Invalid bootstrap address');
  return value;
}

function pointer(value?: string): string {
  return value === undefined || value === ethers.constants.HashZero ? ethers.constants.HashZero : metadataPointerToBytes32(value);
}

function roles(value: number[] | undefined, roleCount: number): string[] {
  if (value !== undefined && !Array.isArray(value)) throw new Error('Bootstrap role indices must be an array');
  return (value ?? []).map(i => {
    if (!Number.isSafeInteger(i) || i < 0 || i >= roleCount) throw new Error('Invalid bootstrap role index');
    return requireRawUint(i);
  });
}

export function buildBootstrapConfig(input: BootstrapConfigInput, roleCount: number): BootstrapConfigTuple {
  if (!Number.isSafeInteger(roleCount) || roleCount < 1 || roleCount > 16) throw new Error('Bootstrap requires 1–16 authority roles');
  if (!input || !Array.isArray(input.projects) || !Array.isArray(input.tasks)) throw new Error('Bootstrap projects/tasks must be arrays');
  const projects: BootstrapProjectTuple[] = input.projects.map(p => {
    if (!p || ['createHats', 'claimHats', 'reviewHats', 'assignHats'].some(key => key in p)) throw new Error('Bootstrap uses authority role indices, not retired hat lists');
    if (p.managers !== undefined && !Array.isArray(p.managers)) throw new Error('Bootstrap managers must be an array');
    const tokens = p.bountyTokens ?? [], caps = p.bountyCaps ?? [];
    if (!Array.isArray(tokens) || !Array.isArray(caps) || tokens.length !== caps.length) throw new Error('Bootstrap bounty arrays must have equal lengths');
    return [title(p.title), pointer(p.metadataHash), shares(p.cap, 'cap'), (p.managers ?? []).map(a => address(a)),
      roles(p.createRoleIndices, roleCount), roles(p.claimRoleIndices, roleCount), roles(p.reviewRoleIndices, roleCount), roles(p.assignRoleIndices, roleCount),
      tokens.map(a => address(a)), caps.map(c => amount(c, 'cap'))];
  });
  const tasks: BootstrapTaskTuple[] = input.tasks.map(t => {
    if (!t || 'absoluteDeadline' in t || 'completionWindow' in t || 'deadline' in t) throw new Error('Bootstrap tasks have seven fields and no deadline extension');
    if (!Number.isSafeInteger(t.projectIndex) || t.projectIndex < 0 || t.projectIndex > 255 || t.projectIndex >= projects.length) throw new Error('Invalid bootstrap projectIndex (uint8)');
    if (t.requiresApplication !== undefined && typeof t.requiresApplication !== 'boolean') throw new Error('Bootstrap requiresApplication must be boolean');
    const token = address(t.bountyToken ?? ethers.constants.AddressZero, false);
    const bounty = amount(t.bountyPayout, 'bounty');
    if ((token.toLowerCase() === ethers.constants.AddressZero) !== (bounty === '0')) throw new Error('Bootstrap bounty token/payout mismatch');
    return [t.projectIndex, shares(t.payout, 'payout'), title(t.title), pointer(t.metadataHash), token, bounty, t.requiresApplication ?? false];
  });
  return [projects, tasks];
}

export function validateBootstrapConfig(input: BootstrapConfigInput, roleCount: number): void {
  buildBootstrapConfig(input, roleCount);
}
