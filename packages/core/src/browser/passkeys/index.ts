export * from './utils';
export * from './ceremony';
export * from './sign';
export * from './readiness';
export * from './storage';
import { createPasskeyCredential, discoverPasskeyCredential, getWebAuthnAssertion, PasskeyConfig } from './ceremony';
import { signRegistrationChallenge, signUserOpHash } from './sign';

export function createPasskeyClient(config: PasskeyConfig) {
  return {
    create: (username: string) => createPasskeyCredential(username, config),
    discover: () => discoverPasskeyCredential(config),
    getAssertion: (hash: string, rawId: string) => getWebAuthnAssertion(hash, rawId, config),
    signUserOpHash: (hash: string, rawId: string) => signUserOpHash(hash, rawId, config),
    signRegistrationChallenge: (hash: string, rawId: string) => signRegistrationChallenge(hash, rawId, config),
  };
}
