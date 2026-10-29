import { ethers } from 'ethers';
import { PasskeyAccountAbi } from '@poa-box/core/abis/PasskeyAccount';
import { PasskeyAccountFactoryAbi } from '@poa-box/core/abis/PasskeyAccountFactory';
import { computeCredentialId, validateP256Coordinates } from './utils';

/** Public creation output sufficient to predict an address. Prediction cannot
 * require the accountAddress that it is about to compute. */
export interface PublicCredentialKeys {
  credentialId: string; rawCredentialId?: string; publicKeyX: string; publicKeyY: string; salt: string | bigint;
}
export type CredentialPredictionInput = PublicCredentialKeys;
export interface CredentialHint extends Omit<PublicCredentialKeys, 'publicKeyX' | 'publicKeyY'> {
  accountAddress: string; publicKeyX?: string; publicKeyY?: string;
  credentialChainId?: number; [key: string]: unknown;
}
type CredentialKeyInput = Pick<CredentialHint, 'credentialId' | 'rawCredentialId' | 'publicKeyX' | 'publicKeyY' | 'salt'>;
export interface AccountReadClient {
  getChainId(): Promise<number>;
  /** viem maps an observed eth_getCode "0x" to undefined. Read failures reject. */
  getBytecode(input: { address: string }): Promise<string | undefined>;
  readContract(input: { address: string; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<unknown>;
}
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const hasCode = (value: unknown) => typeof value === 'string' && /^0x(?:[\da-f]{2})+$/i.test(value);
const unavailable = () => new Error('We couldn’t verify this account on the selected network. Please try signing in again.');
/** Key shape validation is not authentication, and a local saved address never
 * establishes ownership. The host must resolve identity with a fresh ceremony. */
export function validateCredentialKeys<T extends CredentialKeyInput>(credential: T): T & { publicKeyX: string; publicKeyY: string } {
  try {
    validateP256Coordinates(credential.publicKeyX!, credential.publicKeyY!);
    if (credential.rawCredentialId && computeCredentialId(credential.rawCredentialId).toLowerCase() !== credential.credentialId?.toLowerCase()) throw unavailable();
  } catch { throw unavailable(); }
  return credential as T & { publicKeyX: string; publicKeyY: string };
}
/** Only the observed credential source can restore missing public keys. Outage
 * never means absence. Returned public pointers do not authorize an identity. */
export async function restoreCredentialKeys<T extends CredentialHint>(credential: T, { clientForChain, guard = () => {} }: {
  clientForChain(chainId: number): AccountReadClient | undefined | null; guard?: () => void;
}) {
  guard();
  if (credential.publicKeyX && credential.publicKeyY) return validateCredentialKeys(credential);
  if (!address(credential.accountAddress) || !Number.isSafeInteger(credential.credentialChainId) || credential.credentialChainId! <= 0) throw unavailable();
  const client = clientForChain(credential.credentialChainId!);
  if (!client || await client.getChainId() !== credential.credentialChainId) throw unavailable();
  guard();
  if (!hasCode(await client.getBytecode({ address: credential.accountAddress }))) throw unavailable();
  guard();
  const stored = await client.readContract({ address: credential.accountAddress, abi: PasskeyAccountAbi, functionName: 'getCredential', args: [credential.credentialId] }) as { active?: boolean; publicKeyX?: string; publicKeyY?: string };
  guard();
  if (stored?.active !== true) throw unavailable();
  return validateCredentialKeys({ ...credential, publicKeyX: stored.publicKeyX, publicKeyY: stored.publicKeyY });
}
const credentialArgs = (credential: CredentialKeyInput) => {
  const key = validateCredentialKeys(credential);
  return [key.credentialId, key.publicKeyX, key.publicKeyY, BigInt(key.salt)] as const;
};
export async function computeCounterfactualAddress(publicClient: Pick<AccountReadClient, 'readContract'>, factoryAddress: string, credential: CredentialPredictionInput): Promise<string> {
  if (!address(factoryAddress)) throw unavailable();
  const expected = await publicClient.readContract({ address: factoryAddress, abi: PasskeyAccountFactoryAbi, functionName: 'getAddress', args: credentialArgs(credential) });
  if (!address(expected)) throw unavailable();
  return expected;
}
export async function resolveAccountDeployment({ credential, factoryAddress, publicClient, chainId, guard = () => {} }: {
  credential: CredentialHint; factoryAddress: string; publicClient: AccountReadClient; chainId: number; guard?: () => void;
}) {
  guard();
  if (!address(credential?.accountAddress) || !Number.isSafeInteger(chainId) || chainId <= 0 || !publicClient || await publicClient.getChainId() !== chainId) throw unavailable();
  guard();
  const bytecode = await publicClient.getBytecode({ address: credential.accountAddress });
  guard();
  if (hasCode(bytecode)) return { status: 'deployed' as const, initCode: '0x' };
  // Both values represent an observed empty result from supported clients;
  // a rejected read still propagates, while null and malformed values fail closed.
  if (bytecode !== undefined && bytecode !== '0x') throw unavailable();
  const args = credentialArgs(credential);
  if (!address(factoryAddress) || !hasCode(await publicClient.getBytecode({ address: factoryAddress }))) throw unavailable();
  guard();
  const expected = await publicClient.readContract({ address: factoryAddress, abi: PasskeyAccountFactoryAbi, functionName: 'getAddress', args });
  guard();
  if (!address(expected) || expected.toLowerCase() !== credential.accountAddress.toLowerCase()) throw unavailable();
  const encoded = new ethers.utils.Interface(PasskeyAccountFactoryAbi).encodeFunctionData('createAccount', args);
  return { status: 'deployable' as const, initCode: factoryAddress + encoded.slice(2) };
}
