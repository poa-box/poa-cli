import { createPasskeyCredential, computeCounterfactualAddress, restoreCredentialKeys,
  type AccountReadClient, type PublicCredentialKeys, type CredentialHint } from '../../../src/browser/passkeys';

/** Compiled by public-types.test.ts without casts, fabricated addresses, or any. */
export async function createThenPredict(client: AccountReadClient) {
  const created = await createPasskeyCredential('synthetic-user', { rpId: 'example.test', origin: 'https://example.test' });
  const publicKeys: PublicCredentialKeys = created;
  return computeCounterfactualAddress(client, '0x1111111111111111111111111111111111111111', publicKeys);
}
export async function restoreExistingAccount(client: AccountReadClient, hint: CredentialHint) {
  return restoreCredentialKeys(hint, { clientForChain: () => client });
}
