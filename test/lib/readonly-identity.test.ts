/**
 * POP_READONLY structural read-only mode + identity-scoped reads without keys.
 *
 * The integration contract these pin:
 *   - POP_READONLY=1 means the process CANNOT sign or publish — enforced at
 *     the three places capability appears: createSigner (EOA txs),
 *     resolveSponsoredConfig (4337 userops), pinJson/pinFile (public IPFS).
 *     "Cannot sign" must be assertable, not aspirational.
 *   - Identity-scoped reads resolve WHO through --address > POP_ADDRESS >
 *     key-derivation. Requiring the signing key just to learn an address is
 *     what pushed integrators into handing keys to read-only processes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSigner, resolveIdentityAddress } from '../../src/lib/signer';
import { resolveSponsoredConfig } from '../../src/lib/sponsorship-config';
import { pinJson, pinFile } from '../../src/lib/ipfs';

const KEY = '0x' + '11'.repeat(32);
const KEY_ADDR = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'; // Wallet(0x11…11).address
const OTHER = '0x00000000000000000000000000000000000000A1';

const ENV = ['POP_READONLY', 'POP_ADDRESS', 'POP_PRIVATE_KEY', 'POP_ORG_ID', 'POP_HAT_ID', 'PIMLICO_API_KEY', 'POP_BUNDLER_URL'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.POP_DEFAULT_CHAIN = '100';
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('POP_READONLY=1 — the three capability choke points', () => {
  beforeEach(() => { process.env.POP_READONLY = '1'; });

  it('createSigner refuses even with a key configured', () => {
    process.env.POP_PRIVATE_KEY = KEY;
    expect(() => createSigner({ chainId: 100 })).toThrow(/POP_READONLY/);
  });

  it('sponsorship reports not-configured even with a full 4337 env', () => {
    process.env.POP_PRIVATE_KEY = KEY;
    process.env.POP_ORG_ID = '0x' + '22'.repeat(32);
    process.env.POP_HAT_ID = '1';
    process.env.PIMLICO_API_KEY = 'pk_test';
    expect(resolveSponsoredConfig()).toBeUndefined();
  });

  it('IPFS pinning refuses — pinning publishes publicly and irreversibly', async () => {
    await expect(pinJson('{"a":1}')).rejects.toThrow(/POP_READONLY/);
    await expect(pinFile(Buffer.from('x'))).rejects.toThrow(/POP_READONLY/);
  });

  it('other POP_READONLY values do not activate it', () => {
    process.env.POP_READONLY = 'true';
    process.env.POP_PRIVATE_KEY = KEY;
    expect(() => createSigner({ chainId: 100 })).not.toThrow();
  });
});

describe('resolveIdentityAddress precedence', () => {
  it('--address wins over everything, checksummed', () => {
    process.env.POP_ADDRESS = OTHER;
    process.env.POP_PRIVATE_KEY = KEY;
    const a = resolveIdentityAddress({ address: KEY_ADDR.toLowerCase() });
    expect(a).toBe(KEY_ADDR);
  });

  it('POP_ADDRESS beats key derivation', () => {
    process.env.POP_ADDRESS = OTHER;
    process.env.POP_PRIVATE_KEY = KEY;
    expect(resolveIdentityAddress({})?.toLowerCase()).toBe(OTHER.toLowerCase());
  });

  it('falls back to deriving from the key', () => {
    process.env.POP_PRIVATE_KEY = KEY;
    expect(resolveIdentityAddress({})).toBe(KEY_ADDR);
  });

  it('works under POP_READONLY with only an address — the whole point', () => {
    process.env.POP_READONLY = '1';
    process.env.POP_ADDRESS = OTHER;
    expect(resolveIdentityAddress({}, { required: true })?.toLowerCase()).toBe(OTHER.toLowerCase());
  });

  it('required with nothing configured names all three options', () => {
    expect(() => resolveIdentityAddress({}, { required: true, purpose: '--unvoted' }))
      .toThrow(/--address 0x.*POP_ADDRESS.*POP_PRIVATE_KEY/s);
  });

  it('optional with nothing configured returns null', () => {
    expect(resolveIdentityAddress({})).toBeNull();
  });

  it('garbage --address is a clear error, not a crash downstream', () => {
    expect(() => resolveIdentityAddress({ address: 'not-an-address' })).toThrow(/Invalid address/);
  });
});
