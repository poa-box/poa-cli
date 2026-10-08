/** MembershipAuthority intent builders. No legacy Hats/EligibilityModule write surface. */
import { ethers } from 'ethers';
import { getAbi } from '../contracts';
import type { TxIntent } from './intent';

/** The high byte selects the fold; the remaining 248 bits are the label hash shifted right. */
export function permissionKey(label: string, foldTag = 0): string {
  if (!Number.isInteger(foldTag) || foldTag < 0 || foldTag > 2) throw new Error('Invalid permission fold tag');
  return ethers.utils.hexZeroPad(ethers.BigNumber.from(ethers.utils.id(label)).shr(8)
    .or(ethers.BigNumber.from(foldTag).shl(248)).toHexString(), 32);
}
export const AUTHORITY_KEYS = {
  DD_VOTE: permissionKey('poa.perm.dd.vote'), DD_CREATE: permissionKey('poa.perm.dd.create'),
  HV_CREATE: permissionKey('poa.perm.hv.create'), TM_PERMS: permissionKey('poa.perm.tm.perms', 1),
  PT_MEMBER: permissionKey('poa.perm.pt.member'), PT_APPROVE: permissionKey('poa.perm.pt.approve'),
  EDU_CREATE: permissionKey('poa.perm.edu.create'), EDU_MEMBER: permissionKey('poa.perm.edu.member'),
  QJ_AUTOJOIN: permissionKey('poa.perm.qj.autojoin'), PAY_CREATE: permissionKey('poa.perm.pay.create'),
  SUBJECT_RENAME: permissionKey('poa.perm.subject.rename'),
};
export const EXISTS_BIT = ethers.BigNumber.from(1).shl(255);
export const INHERIT_GLOBAL_BIT = ethers.BigNumber.from(1).shl(254);
export const VALUE_MASK = INHERIT_GLOBAL_BIT.sub(1);
export function permissionWord(value: ethers.BigNumberish, inheritGlobal = false): ethers.BigNumber {
  const word = ethers.BigNumber.from(value);
  if (word.lt(0) || word.gt(VALUE_MASK)) throw new Error('Permission value must fit in 254 bits');
  return word.or(EXISTS_BIT).or(inheritGlobal ? INHERIT_GLOBAL_BIT : 0);
}
/** Project zero must not collide with the global context. */
export function projectContext(projectId: ethers.BigNumberish): string {
  const id = ethers.BigNumber.from(projectId);
  if (id.lt(0) || id.gte(ethers.constants.MaxUint256)) throw new Error('Project ID cannot be encoded as projectId + 1');
  return ethers.utils.hexZeroPad(id.add(1).toHexString(), 32);
}

/** Explicit allowlist excludes initialization, migration seeds and compatibility mint selectors. */
export const AUTHORITY_METHODS = [
  'claim', 'renounce', 'reconcile(uint256,address)', 'reconcile(uint256,address[])',
  'grant', 'offer', 'withdrawOffer', 'remove', 'unremove', 'setRule', 'clearRule',
  'delegatedGrant', 'delegatedOffer', 'delegatedRemove', 'delegatedUnremove', 'finalize', 'cancel',
  'setManagerConfig', 'createRole', 'createGroup', 'addRoleToGroup', 'removeRoleFromGroup',
  'renameSubject', 'setMaxMembers', 'setSubjectDefault', 'configureVouchAttestor',
  'resetVouchEpoch', 'clearUserVouches', 'setMaxDailyVouches', 'vouch', 'revokeVouch',
  'setPerm', 'clearPerm', 'setPaused',
] as const;
export type AuthorityMethod = typeof AUTHORITY_METHODS[number];

export function buildAuthorityAction(a: {
  authorityAddress: string; method: AuthorityMethod; args: unknown[]; orgId?: string;
}): TxIntent {
  if (!(AUTHORITY_METHODS as readonly string[]).includes(a.method)) throw new Error('Unsupported authority action');
  if (!ethers.utils.isAddress(a.authorityAddress) || a.authorityAddress === ethers.constants.AddressZero) {
    throw new Error('A nonzero MembershipAuthority address is required');
  }
  const abi = getAbi('MembershipAuthority');
  new ethers.utils.Interface(abi).encodeFunctionData(a.method, a.args);
  return { to: a.authorityAddress, abi, method: a.method, args: a.args,
    meta: { domain: 'role', action: a.method, orgId: a.orgId, summary: { authority: a.authorityAddress } } };
}
