import { ethers } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { requireRawUint } from '../amounts';
import { knownFact, unknownFact, type Fact } from '../data/facts';
import { cidV0ToBytes32 } from '../encoding/cid';

export interface DistributionClaim { amount: string; proof: string[] }
/** Frozen current document wire order and fields. Manager/org/policy are external bindings. */
export interface DistributionClaimsDocument {
  token: string; tokenSymbol: string; totalAmount: string; checkpointBlock: string | number;
  merkleRoot: string; claims: Record<string, DistributionClaim>; createdAt: number;
}
export interface DistributionClaimsReference {
  chainId: number; orgId: string; paymentManager: string; distributionId?: string;
  cid: string; merkleRoot: string; token: string; totalAmount: string; checkpointBlock: string;
}
export interface VerifiedDistributionClaimsDocument {
  readonly document: DistributionClaimsDocument;
  readonly reference: DistributionClaimsReference;
}
function hash(value: string): string {
  if (!ethers.utils.isHexString(value, 32) || value === ethers.constants.HashZero) throw new Error('INVALID_MERKLE_ROOT');
  return value.toLowerCase();
}
export function requireDistributionClaimsReference(reference: DistributionClaimsReference): void {
  if (!Number.isSafeInteger(reference.chainId) || reference.chainId <= 0 || !ethers.utils.isHexString(reference.orgId, 32)) throw new Error('INVALID_CLAIM_SCOPE');
  if (ethers.utils.getAddress(reference.paymentManager) === ethers.constants.AddressZero) throw new Error('INVALID_CLAIM_MANAGER');
  ethers.utils.getAddress(reference.token); hash(reference.merkleRoot); cidV0ToBytes32(reference.cid);
  requireRawUint(reference.totalAmount); requireRawUint(reference.checkpointBlock);
  if (reference.distributionId !== undefined) requireRawUint(reference.distributionId);
}
/** Verify the STORED leaves/proofs and total; never run allocation from current holders. */
export function verifyDistributionClaimsDocument(document: unknown, input: { reference: DistributionClaimsReference; loadedCid: string }): Fact<VerifiedDistributionClaimsDocument> {
  try {
    const reference = input.reference;
    requireDistributionClaimsReference(reference);
    cidV0ToBytes32(input.loadedCid);
    if (input.loadedCid !== reference.cid) throw new Error('CLAIM_CID_MISMATCH');
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('CLAIM_DOCUMENT_UNAVAILABLE');
    const doc = document as DistributionClaimsDocument;
    if (ethers.utils.getAddress(doc.token).toLowerCase() !== reference.token.toLowerCase()
      || requireRawUint(doc.totalAmount) !== requireRawUint(reference.totalAmount)
      || requireRawUint(doc.checkpointBlock) !== requireRawUint(reference.checkpointBlock)
      || hash(doc.merkleRoot) !== hash(reference.merkleRoot)) throw new Error('CLAIM_DOCUMENT_BINDING_MISMATCH');
    const validated = buildDistributionClaimsDocument(doc), claims: Record<string, DistributionClaim> = {};
    for (const [key, value] of Object.entries(validated.claims)) {
      claims[key.toLowerCase()] = Object.freeze({ amount: value.amount, proof: Object.freeze([...value.proof]) as unknown as string[] });
    }
    const verifiedDoc = Object.freeze({ token: doc.token, tokenSymbol: doc.tokenSymbol, totalAmount: doc.totalAmount,
      checkpointBlock: doc.checkpointBlock, merkleRoot: doc.merkleRoot, claims: Object.freeze(claims), createdAt: doc.createdAt });
    return knownFact(Object.freeze({ document: verifiedDoc, reference: Object.freeze({ ...reference }) }));
  } catch (error) { return unknownFact(error instanceof Error ? error.message : 'CLAIM_DOCUMENT_UNAVAILABLE'); }
}
export function buildDistributionClaimsDocument(input: DistributionClaimsDocument): DistributionClaimsDocument {
  // Keep provided key case and numeric/string checkpoint wire representation intact.
  if (!input.claims || typeof input.claims !== 'object' || Array.isArray(input.claims)) throw new Error('INVALID_CLAIM_DOCUMENT');
  const document = { token: input.token, tokenSymbol: input.tokenSymbol, totalAmount: requireRawUint(input.totalAmount),
    checkpointBlock: typeof input.checkpointBlock === 'number' ? Number(requireRawUint(input.checkpointBlock)) : requireRawUint(input.checkpointBlock),
    merkleRoot: input.merkleRoot, claims: Object.fromEntries(Object.entries(input.claims).map(([address, claim]) => {
      if (!claim || typeof claim.amount !== 'string' || !Array.isArray(claim.proof)) throw new Error('INVALID_CLAIM_PROOF');
      return [address, { amount: requireRawUint(claim.amount), proof: [...claim.proof] }];
    })), createdAt: input.createdAt };
  ethers.utils.getAddress(document.token); hash(document.merkleRoot);
  if (typeof document.tokenSymbol !== 'string' || !Number.isSafeInteger(document.createdAt) || document.createdAt < 0) throw new Error('INVALID_CLAIM_DOCUMENT');
  const seen = new Set<string>(), leaves: [string, string][] = [];
  let total = 0n;
  for (const [key, claim] of Object.entries(document.claims)) {
    const address = ethers.utils.getAddress(key), normalized = address.toLowerCase();
    if (address === ethers.constants.AddressZero || seen.has(normalized)) throw new Error('DUPLICATE_OR_INVALID_CLAIM');
    seen.add(normalized);
    if (claim.proof.some(p => !ethers.utils.isHexString(p, 32)) || !StandardMerkleTree.verify(document.merkleRoot, ['address', 'uint256'], [address, claim.amount], claim.proof)) throw new Error('INVALID_CLAIM_PROOF');
    total += BigInt(claim.amount); requireRawUint(total); leaves.push([address, claim.amount]);
  }
  if (!leaves.length || total.toString() !== document.totalAmount || StandardMerkleTree.of(leaves, ['address', 'uint256']).root.toLowerCase() !== hash(document.merkleRoot)) throw new Error('CLAIM_SET_MISMATCH');
  return document;
}
export function findDistributionClaim(verified: Fact<VerifiedDistributionClaimsDocument>, address: string): Fact<DistributionClaim | null> {
  if (verified.state === 'unknown') return verified;
  try {
    const claim = verified.value.document.claims[ethers.utils.getAddress(address).toLowerCase()];
    return knownFact(claim ? { amount: claim.amount, proof: [...claim.proof] } : null);
  } catch { return unknownFact('INVALID_CLAIM_ACCOUNT'); }
}
export function distributionClaimCacheKey(reference: DistributionClaimsReference, account: string): string {
  requireDistributionClaimsReference(reference);
  if (reference.distributionId === undefined) throw new Error('DISTRIBUTION_ID_REQUIRED');
  return [reference.chainId, reference.orgId.toLowerCase(), reference.paymentManager.toLowerCase(), requireRawUint(reference.distributionId), reference.token.toLowerCase(),
    requireRawUint(reference.checkpointBlock), reference.merkleRoot.toLowerCase(), reference.cid, ethers.utils.getAddress(account).toLowerCase()].join(':');
}
export function distributionClaimsDiscoveryMarker(reference: DistributionClaimsReference): string {
  requireDistributionClaimsReference(reference);
  return `Merkle tree: ipfs://${reference.cid} Root: ${reference.merkleRoot}`;
}
export function parseDistributionClaimsDiscoveryMarker(description: string): Fact<{ cid: string; merkleRoot: string }> {
  const matches = [...description.matchAll(/Merkle tree: ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]+) Root: (0x[\da-fA-F]{64})(?![\da-fA-F])/g)];
  if (matches.length !== 1) return unknownFact(matches.length ? 'AMBIGUOUS_CLAIM_REFERENCE' : 'CLAIM_REFERENCE_UNAVAILABLE');
  try { cidV0ToBytes32(matches[0][1]); hash(matches[0][2]); return knownFact({ cid: matches[0][1], merkleRoot: matches[0][2] }); }
  catch { return unknownFact('INVALID_CLAIM_REFERENCE'); }
}
