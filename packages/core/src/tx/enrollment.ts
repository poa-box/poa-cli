/** Shared pure codecs for atomic enrollment. Chain/registry challenge selection is host-owned. */
import { ethers } from 'ethers';
import { RawUintInput, requireRawUint } from '../amounts';
import { WebAuthnAuth, packPasskeySignature, unpackPasskeySignature } from '../accounts/codecs';
import { requireValidUsername } from '../validation';

export interface PasskeyEnrollment {
  credentialId: string;
  publicKeyX: string;
  publicKeyY: string;
  salt: RawUintInput;
}
export interface PasskeyRegistrationArgs {
  passkey: PasskeyEnrollment;
  username: string;
  deadline: RawUintInput;
  nonce: RawUintInput;
  auth: WebAuthnAuth;
}

/** Validates/copies values only; does not verify a WebAuthn assertion or derive an account. */
export function passkeyRegistrationArgs(a: PasskeyRegistrationArgs): unknown[] {
  if (typeof a.username !== 'string') throw new Error('Invalid username');
  const p = a.passkey;
  for (const value of [p.credentialId, p.publicKeyX, p.publicKeyY]) {
    if (typeof value !== 'string' || !ethers.utils.isHexString(value, 32)) throw new Error('Invalid passkey bytes32');
  }
  // Reuse the public WebAuthn codec rather than maintaining a second tuple validator.
  const { auth } = unpackPasskeySignature(packPasskeySignature(p.credentialId, a.auth));
  return [[p.credentialId, p.publicKeyX, p.publicKeyY, requireRawUint(p.salt)], requireValidUsername(a.username),
    requireRawUint(a.deadline), requireRawUint(a.nonce),
    [auth.authenticatorData, auth.clientDataJSON, auth.challengeIndex, auth.typeIndex, auth.r, auth.s]];
}
