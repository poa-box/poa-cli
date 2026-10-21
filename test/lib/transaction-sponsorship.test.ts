import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { resolveTransactionSponsorship } from '../../src/lib/tx';
const selected = new ethers.Wallet('0x' + '11'.repeat(32)), environmentWallet = new ethers.Wallet('0x' + '22'.repeat(32));
let saved: NodeJS.ProcessEnv;
beforeEach(() => { saved = { ...process.env }; delete process.env.POP_READONLY; process.env.POP_PRIVATE_KEY = environmentWallet.privateKey;
  process.env.POP_ORG_ID = '0x' + '33'.repeat(32); process.env.POP_HAT_ID = '9'; process.env.POP_BUNDLER_URL = 'http://offline.invalid'; });
afterEach(() => { process.env = saved; });
describe('CLI authorized sponsorship account', () => {
  it('an explicit Wallet signer overrides the environment wallet for sponsored signing too', () => {
    const config = resolveTransactionSponsorship(selected)!;
    expect(new ethers.Wallet(config.privateKey).address).toBe(selected.address); expect(config.hatId).toBe(9n);
  });
  it('an explicit Wallet signer can use configured routing without an environment signing key', () => {
    delete process.env.POP_PRIVATE_KEY;
    expect(resolveTransactionSponsorship(selected)?.privateKey).toBe(selected.privateKey);
  });
  it('explicit sponsorship credentials are retained for the core equality check', () => {
    const explicit = { privateKey: environmentWallet.privateKey as `0x${string}`, orgId: process.env.POP_ORG_ID as `0x${string}`, hatId: 9n };
    expect(resolveTransactionSponsorship(selected, { sponsored: explicit })).toBe(explicit);
  });
  it('read-only mode never auto-configures sponsorship even for an exportable Wallet', () => {
    process.env.POP_READONLY = '1'; expect(resolveTransactionSponsorship(selected)).toBeUndefined();
  });
});
