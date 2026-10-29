import { packPasskeySignature, registrationChallenge } from '@poa-box/core/accounts/codecs';
import type { RawUintInput } from '@poa-box/core/amounts';
import { getWebAuthnAssertion, PasskeyConfig } from './ceremony';
import { bytesHex, bytes32, computeCredentialId } from './utils';

export function computeRegistrationChallenge({ accountAddress, username, nonce, deadline, chainId, registryAddress }: {
  accountAddress: string; username: string; nonce: RawUintInput; deadline: RawUintInput; chainId: RawUintInput; registryAddress: string;
}): string { return registrationChallenge({ user: accountAddress, username, nonce, deadline, chainId, registryAddress }, 'passkey'); }
export async function signRegistrationChallenge(challengeHash: string, rawCredentialId: string, config: PasskeyConfig) {
  const auth = await getWebAuthnAssertion(challengeHash, rawCredentialId, config);
  return { authenticatorData: bytesHex(auth.authenticatorData), clientDataJSON: bytesHex(auth.clientDataJSON), challengeIndex: BigInt(auth.challengeIndex), typeIndex: BigInt(auth.typeIndex), r: bytes32(auth.r), s: bytes32(auth.s) };
}
export async function signUserOpHash(challengeHash: string, rawCredentialId: string, config: PasskeyConfig): Promise<string> {
  return packPasskeySignature(computeCredentialId(rawCredentialId), await signRegistrationChallenge(challengeHash, rawCredentialId, config));
}
