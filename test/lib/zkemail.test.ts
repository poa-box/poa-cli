import { describe, it, expect } from 'vitest';
import {
  norm,
  isPrintableAscii,
  domainHash,
  emailHash,
  buildAllowlist,
  treeFromDoc,
  assertRootMatches,
  proofForDomain,
  proofForEmailHash,
  summarize,
  parseEntriesFile,
  dkimSeededFromIndex,
  ALLOWLIST_SCHEMA,
  LEAF_TYPES,
} from '../../src/lib/zkemail';
import { CliError } from '../../src/lib/errors';

/**
 * CIRCUIT CONFORMANCE VECTORS — do not "fix" these to match the code.
 *
 * These three Poseidon commitments are production constants copied verbatim from the
 * contracts repo's script/zkemail/CeremonyDeployTest6Gnosis.s.sol
 * (OPACITYLABS_POSEIDON / GMAIL_POSEIDON / KU_POSEIDON). They are the circuit's
 * `fromDomainHash` signal for those domains and the PoaDKIMRegistry keys.
 *
 * CEREMONY_ROOT is the OZ StandardMerkleTree root over those three domain leaves granting
 * TEST6_MEMBER_HAT, and was verified to equal the live `merkleRoot()` of the deployed
 * ZkEmailInvites proxy 0xADAf24f05EE0D647A7c2AF5cAD0F377F1B159FD2 on Gnosis.
 *
 * If any of these fail, the CLI would publish allowlists that are silently unclaimable —
 * the leaf the contract recomputes at claim time would never match the committed root.
 */
const OPACITYLABS_POSEIDON = '0x29e7dedcdb5e509c3f276fb5d689700f0eaaa74bfaa75259b4c545cd2241a5c2';
const GMAIL_POSEIDON = '0x14d46e073cbff5944a738ea295de6c7447606fa5a270571229d8a4b1e7ca77e5';
const KU_POSEIDON = '0x256f370d0033263e95a6c486e2a0280c7843b2e0d586e92e6557382f776d6c58';
const TEST6_MEMBER_HAT = '29035862971903655586674243772344327311664727652070589302159213246545920';
const CEREMONY_ROOT = '0x1d5d75df3ee05a0a90c42f0fe423f3c063dedf3466378e45a8343bfef18ebc46';

const ORG = '0x1111111111111111111111111111111111111111111111111111111111111111';

describe('poseidon commitment — circuit conformance', () => {
  it('reproduces the production domain hashes from CeremonyDeployTest6Gnosis.s.sol', async () => {
    expect((await domainHash('opacitylabs.com')).toLowerCase()).toBe(OPACITYLABS_POSEIDON);
    expect((await domainHash('gmail.com')).toLowerCase()).toBe(GMAIL_POSEIDON);
    expect((await domainHash('ku.edu')).toLowerCase()).toBe(KU_POSEIDON);
  });

  it('is ASCII-case-insensitive and whitespace-tolerant, matching the circuit ToLower', async () => {
    expect((await domainHash('GMAIL.COM')).toLowerCase()).toBe(GMAIL_POSEIDON);
    expect((await domainHash('  Gmail.Com  ')).toLowerCase()).toBe(GMAIL_POSEIDON);
  });

  it('uses the same commitment for domain and email ids', async () => {
    expect(await emailHash('gmail.com')).toBe(await domainHash('gmail.com'));
  });

  it('returns 0x-prefixed, zero-padded bytes32', async () => {
    const h = await domainHash('ku.edu');
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('norm', () => {
  it('lowercases only ASCII A-Z, leaving non-ASCII untouched', () => {
    // JS toLowerCase() would turn 'İ' into 'i̇', producing a leaf the contract cannot rebuild.
    expect(norm('ABC')).toBe('abc');
    expect(norm('  MiXeD.CoM  ')).toBe('mixed.com');
    expect(norm('İ')).toBe('İ');
  });

  it('coerces nullish to empty string', () => {
    expect(norm(null)).toBe('');
    expect(norm(undefined)).toBe('');
  });
});

describe('isPrintableAscii', () => {
  it('accepts plain identifiers and rejects non-ASCII', () => {
    expect(isPrintableAscii('anthropic.com')).toBe(true);
    expect(isPrintableAscii('alice@org.com')).toBe(true);
    expect(isPrintableAscii('exämple.com')).toBe(false);
    expect(isPrintableAscii('')).toBe(false);
  });
});

describe('buildAllowlist — merkle root conformance', () => {
  it('reproduces the live on-chain ceremony root for the three Test6 domains', async () => {
    const { root } = await buildAllowlist({
      orgId: ORG,
      entries: [
        { type: 'domain', identifier: 'opacitylabs.com', hatIds: [TEST6_MEMBER_HAT] },
        { type: 'domain', identifier: 'gmail.com', hatIds: [TEST6_MEMBER_HAT] },
        { type: 'domain', identifier: 'ku.edu', hatIds: [TEST6_MEMBER_HAT] },
      ],
    });
    expect(root.toLowerCase()).toBe(CEREMONY_ROOT);
  });

  it('is order-independent (StandardMerkleTree sorts leaves)', async () => {
    const { root } = await buildAllowlist({
      orgId: ORG,
      entries: [
        { type: 'domain', identifier: 'ku.edu', hatIds: [TEST6_MEMBER_HAT] },
        { type: 'domain', identifier: 'opacitylabs.com', hatIds: [TEST6_MEMBER_HAT] },
        { type: 'domain', identifier: 'gmail.com', hatIds: [TEST6_MEMBER_HAT] },
      ],
    });
    expect(root.toLowerCase()).toBe(CEREMONY_ROOT);
  });

  it('emits the frontend doc shape', async () => {
    const { doc } = await buildAllowlist({
      orgId: ORG,
      entries: [
        { type: 'domain', identifier: 'gmail.com', hatIds: [TEST6_MEMBER_HAT], roleIndexes: [0] },
        { type: 'email', identifier: 'Alice@Org.com', hatIds: ['0x2a'], roleIndexes: [1] },
      ],
    });
    expect(doc.schema).toBe(ALLOWLIST_SCHEMA);
    expect(doc.orgId).toBe(ORG);
    expect(doc.leafTypes).toEqual([...LEAF_TYPES]);
    expect(doc.treeDump).toBeTruthy();

    const domainEntry = doc.entries.find((e) => e.type === 'domain')!;
    expect(domainEntry.domainHash?.toLowerCase()).toBe(GMAIL_POSEIDON);
    expect(domainEntry.emailHash).toBeUndefined();

    const emailEntry = doc.entries.find((e) => e.type === 'email')!;
    // identifier is canonicalized to exactly what was hashed
    expect(emailEntry.identifier).toBe('alice@org.com');
    expect(emailEntry.emailHash).toBe(await emailHash('alice@org.com'));
    expect(emailEntry.domainHash).toBeUndefined();
    expect(emailEntry.hatIds).toEqual(['0x2a']);
    expect(emailEntry.roleIndexes).toEqual([1]);
  });

  it('sorts hat IDs ascending so leaf encoding is deterministic', async () => {
    const a = await buildAllowlist({
      orgId: ORG,
      entries: [{ type: 'domain', identifier: 'gmail.com', hatIds: ['0x10', '0x2'] }],
    });
    const b = await buildAllowlist({
      orgId: ORG,
      entries: [{ type: 'domain', identifier: 'gmail.com', hatIds: ['0x2', '0x10'] }],
    });
    expect(a.root).toBe(b.root);
    expect(a.doc.entries[0].hatIds).toEqual(['0x2', '0x10']);
  });

  it('rejects non-ASCII identifiers rather than building an unclaimable leaf', async () => {
    await expect(
      buildAllowlist({ orgId: ORG, entries: [{ type: 'domain', identifier: 'exämple.com', hatIds: ['0x1'] }] })
    ).rejects.toThrow(CliError);
  });

  it('rejects an email entry with no @, and a domain entry that looks like an email', async () => {
    await expect(
      buildAllowlist({ orgId: ORG, entries: [{ type: 'email', identifier: 'nope.com', hatIds: ['0x1'] }] })
    ).rejects.toThrow(/not an email address/);
    await expect(
      buildAllowlist({ orgId: ORG, entries: [{ type: 'domain', identifier: 'a@b.com', hatIds: ['0x1'] }] })
    ).rejects.toThrow(/looks like an email address/);
  });

  it('rejects entries with no hats, an unknown type, and an empty list', async () => {
    await expect(
      buildAllowlist({ orgId: ORG, entries: [{ type: 'domain', identifier: 'gmail.com', hatIds: [] }] })
    ).rejects.toThrow(/grants no hat IDs/);
    await expect(
      buildAllowlist({ orgId: ORG, entries: [{ type: 'bogus' as any, identifier: 'gmail.com', hatIds: ['0x1'] }] })
    ).rejects.toThrow(/must be "domain" or "email"/);
    await expect(buildAllowlist({ orgId: ORG, entries: [] })).rejects.toThrow(/at least one entry/);
  });
});

describe('proofs', () => {
  it('round-trips a domain proof through the dumped tree', async () => {
    const { doc, root } = await buildAllowlist({
      orgId: ORG,
      entries: [
        { type: 'domain', identifier: 'gmail.com', hatIds: [TEST6_MEMBER_HAT] },
        { type: 'domain', identifier: 'ku.edu', hatIds: [TEST6_MEMBER_HAT] },
      ],
    });
    const tree = treeFromDoc(doc);
    expect(tree.root).toBe(root);

    const found = await proofForDomain(tree, 'GMAIL.COM');
    expect(found).not.toBeNull();
    expect(found!.hatIds).toEqual([TEST6_MEMBER_HAT]);
    expect(Array.isArray(found!.proof)).toBe(true);

    expect(await proofForDomain(tree, 'not-invited.com')).toBeNull();
  });

  it('finds a specific-address entry by emailHash', async () => {
    const { doc } = await buildAllowlist({
      orgId: ORG,
      entries: [
        { type: 'email', identifier: 'alice@org.com', hatIds: ['0x2a'] },
        { type: 'domain', identifier: 'gmail.com', hatIds: ['0x2a'] },
      ],
    });
    const tree = treeFromDoc(doc);
    const eh = await emailHash('alice@org.com');

    const found = proofForEmailHash(tree, eh.toUpperCase());
    expect(found).not.toBeNull();
    expect(found!.hatIds).toEqual(['42']);

    // A domain leaf with the same id must not satisfy an email lookup (kind is part of the leaf).
    expect(proofForEmailHash(tree, await domainHash('gmail.com'))).toBeNull();
  });
});

describe('assertRootMatches', () => {
  it('accepts a matching root and rejects a swapped CID', async () => {
    const { doc, root } = await buildAllowlist({
      orgId: ORG,
      entries: [{ type: 'domain', identifier: 'gmail.com', hatIds: ['0x1'] }],
    });
    expect(() => assertRootMatches(doc, root.toUpperCase())).not.toThrow();
    expect(() => assertRootMatches(doc, '0x' + '00'.repeat(32))).toThrow(/does not match the active on-chain root/);
  });

  it('names what the expected root is, so the propose path does not claim it is on-chain', async () => {
    const { doc } = await buildAllowlist({
      orgId: ORG,
      entries: [{ type: 'domain', identifier: 'gmail.com', hatIds: ['0x1'] }],
    });
    expect(() => assertRootMatches(doc, '0x' + '00'.repeat(32), 'root you are proposing (--root)'))
      .toThrow(/does not match the root you are proposing/);
  });

  it('rejects a doc with no tree dump', () => {
    expect(() => treeFromDoc({ entries: [] })).toThrow(/missing its merkle tree dump/);
  });
});

describe('summarize', () => {
  it('splits domains from specific addresses', async () => {
    const { doc } = await buildAllowlist({
      orgId: ORG,
      entries: [
        { type: 'domain', identifier: 'gmail.com', hatIds: ['0x1'] },
        { type: 'email', identifier: 'alice@org.com', hatIds: ['0x1'] },
      ],
    });
    expect(summarize(doc)).toEqual({ domains: ['gmail.com'], emails: ['alice@org.com'] });
  });

  it('tolerates a doc with no entries', () => {
    expect(summarize({})).toEqual({ domains: [], emails: [] });
  });
});

describe('parseEntriesFile', () => {
  it('accepts a bare array and a full allowlist doc', () => {
    const arr = '[{"type":"domain","identifier":"a.com","hatIds":["0x1"]}]';
    expect(parseEntriesFile(arr, 'f.json')).toHaveLength(1);

    const docJson = JSON.stringify({ entries: [{ type: 'email', identifier: 'a@b.com', hatIds: ['0x1'], roleIndexes: [2] }] });
    const parsed = parseEntriesFile(docJson, 'f.json');
    expect(parsed[0].type).toBe('email');
    expect(parsed[0].roleIndexes).toEqual([2]);
  });

  it('reports actionable errors for malformed input', () => {
    expect(() => parseEntriesFile('{oops', 'f.json')).toThrow(/not valid JSON/);
    expect(() => parseEntriesFile('{"nope":1}', 'f.json')).toThrow(/must be a JSON array/);
    expect(() => parseEntriesFile('[{"identifier":"a.com"}]', 'f.json')).toThrow(/no hatIds array/);
  });
});

describe('dkimSeededFromIndex — reproduces isKeyHashValid', () => {
  const DOMAIN = '0x14d46e073cbff5944a738ea295de6c7447606fa5a270571229d8a4b1e7ca77e5';
  const OTHER = '0x256f370d0033263e95a6c486e2a0280c7843b2e0d586e92e6557382f776d6c58';
  // PoaDKIMRegistry.NO_EXPIRY = type(uint256).max, the value a permanent key actually carries.
  const NO_EXPIRY = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  const NOW = 1_800_000_000;

  const key = (over: Partial<any> = {}) => ({
    domainHash: DOMAIN, keyHash: '0xaa', valid: true, validUntil: NO_EXPIRY, ...over,
  });

  it('a permanent key (NO_EXPIRY) is seeded — and 2^256-1 must not overflow', () => {
    expect(dkimSeededFromIndex({ keys: [key()] }, DOMAIN, NOW)).toBe(true);
  });

  it('validUntil 0 means REVOKED, never "permanent"', () => {
    // The inverse reading marks every revoked key as permanently valid.
    expect(dkimSeededFromIndex({ keys: [key({ validUntil: '0' })] }, DOMAIN, NOW)).toBe(false);
  });

  it('a time-bounded key is usable before its cutoff and not after', () => {
    expect(dkimSeededFromIndex({ keys: [key({ validUntil: String(NOW + 1000) })] }, DOMAIN, NOW)).toBe(true);
    // Nothing is emitted when an expiry lapses, so `valid` stays true on the index while the
    // contract has already started rejecting it — this is the case `valid` alone gets wrong.
    expect(dkimSeededFromIndex({ keys: [key({ validUntil: String(NOW - 1) })] }, DOMAIN, NOW)).toBe(false);
  });

  it('respects the indexed valid flag', () => {
    expect(dkimSeededFromIndex({ keys: [key({ valid: false })] }, DOMAIN, NOW)).toBe(false);
  });

  it('only matches the requested domain, case-insensitively', () => {
    expect(dkimSeededFromIndex({ keys: [key({ domainHash: OTHER })] }, DOMAIN, NOW)).toBe(false);
    expect(dkimSeededFromIndex({ keys: [key({ domainHash: DOMAIN.toUpperCase() })] }, DOMAIN, NOW)).toBe(true);
  });

  it('one usable key among revoked/expired siblings is enough (rotation)', () => {
    const keys = [
      key({ keyHash: '0x01', validUntil: '0' }),
      key({ keyHash: '0x02', valid: false }),
      key({ keyHash: '0x03', validUntil: String(NOW + 5) }),
    ];
    expect(dkimSeededFromIndex({ keys }, DOMAIN, NOW)).toBe(true);
  });

  it('distinguishes "registry not indexed" (null) from "no key" (false)', () => {
    // Rendering an unindexed registry as "not seeded" would tell every user on that chain
    // their working invite is broken.
    expect(dkimSeededFromIndex(null, DOMAIN, NOW)).toBeNull();
    expect(dkimSeededFromIndex(undefined, DOMAIN, NOW)).toBeNull();
    expect(dkimSeededFromIndex({ keys: [] }, DOMAIN, NOW)).toBe(false);
    expect(dkimSeededFromIndex({}, DOMAIN, NOW)).toBe(false);
  });

  it('skips an unparseable validUntil rather than throwing', () => {
    expect(dkimSeededFromIndex({ keys: [key({ validUntil: 'nonsense' })] }, DOMAIN, NOW)).toBe(false);
  });
});
