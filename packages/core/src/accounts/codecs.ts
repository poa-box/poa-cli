import { ethers } from 'ethers';
import { requireRawUint, RawUintInput } from '../amounts';

const registrationFields = () => [
  { name: 'user', type: 'address' }, { name: 'username', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
];
export const REGISTER_ACCOUNT_TYPES = { RegisterAccount: registrationFields() };
export const REGISTER_PASSKEY_ACCOUNT_TYPES = { RegisterPasskeyAccount: registrationFields() };
export interface RegistrationChallengeInput {
  user: string; username: string; nonce: RawUintInput; deadline: RawUintInput; chainId: RawUintInput; registryAddress: string;
}
export function registrationDomain(chainId: RawUintInput, registryAddress: string) {
  const chain = requireRawUint(chainId);
  const registry = ethers.utils.getAddress(registryAddress);
  if (chain === '0' || registry === ethers.constants.AddressZero) throw new Error('Registration requires chain and registry');
  return { name: 'UniversalAccountRegistry', version: '1', chainId: chain, verifyingContract: registry };
}
export function registrationChallenge(input: RegistrationChallengeInput, kind: 'eoa' | 'passkey' = 'passkey'): string {
  if (kind !== 'eoa' && kind !== 'passkey') throw new Error('Invalid registration kind');
  if (typeof input.username !== 'string') throw new Error('Invalid username');
  return ethers.utils._TypedDataEncoder.hash(registrationDomain(input.chainId, input.registryAddress), kind === 'eoa' ? REGISTER_ACCOUNT_TYPES : REGISTER_PASSKEY_ACCOUNT_TYPES,
    { user: ethers.utils.getAddress(input.user), username: input.username, nonce: requireRawUint(input.nonce), deadline: requireRawUint(input.deadline) });
}
function hex(data: string, length?: number): string {
  if (typeof data !== 'string' || !/^0x(?:[\da-fA-F]{2})*$/.test(data) || (length !== undefined && data.length !== 2 + length * 2)) throw new Error('Invalid byte string');
  return data;
}
/** Raw credential bytes supplied by the host; no base64/DOM/browser dependencies. */
export function credentialIdDigest(raw: string | Uint8Array): string {
  const data = typeof raw === 'string' ? hex(raw) : ethers.utils.hexlify(raw);
  if (data === '0x') throw new Error('Empty credential');
  return ethers.utils.keccak256(data);
}
export function derivePasskeySalt(credentialId: string): string {
  return ethers.utils.solidityKeccak256(['bytes32', 'string'], [hex(credentialId, 32), 'poa-salt-v1']);
}
export interface WebAuthnAuth {
  authenticatorData: string; clientDataJSON: string; challengeIndex: RawUintInput; typeIndex: RawUintInput; r: string; s: string;
}
const AUTH_TUPLE = 'tuple(bytes authenticatorData, bytes clientDataJSON, uint256 challengeIndex, uint256 typeIndex, bytes32 r, bytes32 s)';
export function packPasskeySignature(credentialId: string, auth: WebAuthnAuth): string {
  return hex(credentialId, 32) + ethers.utils.defaultAbiCoder.encode([AUTH_TUPLE], [[hex(auth.authenticatorData), hex(auth.clientDataJSON), requireRawUint(auth.challengeIndex), requireRawUint(auth.typeIndex), hex(auth.r, 32), hex(auth.s, 32)]]).slice(2);
}
export function unpackPasskeySignature(signature: string): { credentialId: string; auth: WebAuthnAuth } {
  hex(signature);
  if (signature.length < 66) throw new Error('Missing credential prefix');
  const credentialId = signature.slice(0, 66);
  const [decoded] = ethers.utils.defaultAbiCoder.decode([AUTH_TUPLE], '0x' + signature.slice(66));
  const result = { credentialId, auth: { authenticatorData: decoded[0] as string, clientDataJSON: decoded[1] as string, challengeIndex: decoded[2].toString() as string, typeIndex: decoded[3].toString() as string, r: decoded[4] as string, s: decoded[5] as string } };
  if (packPasskeySignature(result.credentialId, result.auth).toLowerCase() !== signature.toLowerCase()) throw new Error('Noncanonical signature tuple');
  return result;
}
