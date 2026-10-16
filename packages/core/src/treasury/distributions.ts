import { ethers } from 'ethers';
import { requireRawUint } from '../amounts';
import { requireCompleteSnapshot, type SourceBlock, type SourceSnapshot } from '../data/facts';
import { computeDistributionAllocations, buildDistributionTree, getAllocationProof, type DistributionMemberInput } from '../tx/treasury';
import { assertTreasuryModuleBindings } from './evidence';

/** Defaults deliberately preserve the CLI's INPUT-order first-holder dust and zero leaves. */
export type AllocationPolicy = 'cli-first-holder' | 'sorted-last-omit-zero';
export interface DistributionOptOutFact { address: string; optedOut: boolean }
export interface AllocateDistributionInput {
  policy?: AllocationPolicy;
  holders: SourceSnapshot<readonly DistributionMemberInput[]>;
  optOutFacts: SourceSnapshot<readonly DistributionOptOutFact[]>;
  chainId: number; orgId: string; holderContract: string; paymentManager: string;
  checkpoint: SourceBlock;
  totalRaw: string;
}
export interface PreparedDistributionAllocation {
  policy: AllocationPolicy; totalRaw: string; checkpoint: SourceBlock;
  allocations: readonly { address: string; amountRaw: string }[];
  merkleRoot: string;
  claims: Record<string, { amount: string; proof: string[] }>;
}
/** Complete checkpoint-qualified inputs only. Select this policy for NEW rounds;
 * stored old claims are verified independently of holders and allocator policy. */
export function allocateDistribution(input: AllocateDistributionInput): PreparedDistributionAllocation {
  const policy = input.policy ?? 'cli-first-holder';
  if (!['cli-first-holder', 'sorted-last-omit-zero'].includes(policy)) throw new Error('UNKNOWN_ALLOCATION_POLICY');
  if (!ethers.utils.isHexString(input.orgId, 32)) throw new Error('INVALID_ORG');
  if (ethers.utils.getAddress(input.holderContract) === ethers.constants.AddressZero || ethers.utils.getAddress(input.paymentManager) === ethers.constants.AddressZero) throw new Error('INVALID_ALLOCATION_CONTRACT');
  const holders = requireCompleteSnapshot(input.holders, { scope: { chainId: input.chainId, orgId: input.orgId, contract: input.holderContract }, snapshot: 'pinned', block: input.checkpoint });
  const opts = requireCompleteSnapshot(input.optOutFacts, { scope: { chainId: input.chainId, orgId: input.orgId, contract: input.paymentManager }, snapshot: 'pinned', block: input.checkpoint });
  const binding = { chainId: input.chainId, contracts: { participationToken: input.holderContract, paymentManager: input.paymentManager } };
  assertTreasuryModuleBindings(input.holders.source, binding);
  assertTreasuryModuleBindings(input.optOutFacts.source, binding);
  const total = BigInt(requireRawUint(input.totalRaw));
  const addresses = new Set<string>(), states = new Map<string, boolean>();
  for (const fact of opts) {
    const address = ethers.utils.getAddress(fact.address).toLowerCase();
    if (states.has(address) || typeof fact.optedOut !== 'boolean') throw new Error('INVALID_OPT_OUT_FACT');
    states.set(address, fact.optedOut);
  }
  const members = holders.map(holder => {
    const address = ethers.utils.getAddress(holder.address);
    if (addresses.has(address.toLowerCase()) || address === ethers.constants.AddressZero) throw new Error('INVALID_HOLDER');
    addresses.add(address.toLowerCase());
    const balance = requireRawUint(holder.participationTokenBalance);
    if (!['Active', 'Inactive', 'Banned'].includes(holder.membershipStatus)) throw new Error('MEMBERSHIP_UNKNOWN');
    if (holder.membershipStatus === 'Active' && balance !== '0' && !states.has(address.toLowerCase())) throw new Error('OPT_OUT_UNKNOWN');
    return { ...holder, address, participationTokenBalance: balance };
  });
  const optedOut = new Set([...states].filter(([, opted]) => opted).map(([address]) => address));
  requireRawUint(members.filter(h => h.membershipStatus === 'Active' && !optedOut.has(h.address.toLowerCase())).reduce((sum, h) => sum + BigInt(h.participationTokenBalance), 0n));
  let allocations;
  if (policy === 'cli-first-holder') allocations = computeDistributionAllocations(members, total.toString(), optedOut);
  else {
    if (total === 0n) throw new Error('ZERO_DISTRIBUTION');
    const eligible = members.filter(h => h.membershipStatus === 'Active' && h.participationTokenBalance !== '0' && !optedOut.has(h.address.toLowerCase()))
      .sort((a, b) => a.address.toLowerCase() < b.address.toLowerCase() ? -1 : a.address.toLowerCase() > b.address.toLowerCase() ? 1 : 0);
    const supply = eligible.reduce((sum, h) => sum + BigInt(h.participationTokenBalance), 0n);
    if (supply === 0n) throw new Error('NO_ELIGIBLE_HOLDERS');
    requireRawUint(supply);
    let allocated = 0n;
    allocations = eligible.map((h, i) => {
      const share = i === eligible.length - 1 ? total - allocated : total * BigInt(h.participationTokenBalance) / supply;
      allocated += share;
      return { address: h.address, amount: ethers.BigNumber.from(share.toString()) };
    }).filter(a => !a.amount.isZero());
  }
  const tree = buildDistributionTree(allocations);
  const claims: PreparedDistributionAllocation['claims'] = {};
  for (const a of allocations) claims[a.address] = { amount: a.amount.toString(), proof: getAllocationProof(tree, a) };
  return { policy, totalRaw: total.toString(), checkpoint: { ...input.checkpoint },
    allocations: allocations.map(a => ({ address: a.address, amountRaw: a.amount.toString() })), merkleRoot: tree.root, claims };
}
