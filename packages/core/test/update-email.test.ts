import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import {
  poseidonCommit, domainHash, emailHash, buildAllowlist, treeFromDoc, assertRootMatches,
  proofForDomain, proofForEmailHash, parseEntriesFile, norm, LEAF_TYPES,
} from '../src/zkemail';
import { verifyAllowlistDocument, projectVerifiedAllowlistLeaves, buildAllowlistFromVerifiedLeaves, mergeVerifiedAllowlist } from '../src/email/allowlist';
import { buildEmailClaimCommand, buildCircuitInputHints, projectGroth16Proof, EMAIL_CIRCUIT_RECIPES,
  EMAIL_BASE_FIELD, EMAIL_SCALAR_FIELD, EmailCircuitVersion } from '../src/email/proof';
import { buildClaimRoleByDomain, buildClaimRoleByEmail } from '../src/tx/zkemail';
import { encodeIntent } from '../src/tx/intent';
import { readInviteStateFacts, projectInviteState, InviteStateFacts, InviteStateEvidence } from '../src/reads/zkemail';
import { knownFact, unknownFact, SourceRef, SourceSnapshot } from '../src/data/facts';
import { bytes32ToCidV0 } from '../src/encoding/cid';

const fixture = <T = any>(name: string): T => JSON.parse(readFileSync(join(__dirname, 'fixtures/core-update/email', name), 'utf8'));
const committed = fixture('committed.json');
const vector = fixture('proof.json');
const ORG = '0x' + '11'.repeat(32), OTHER_ORG = '0x' + '22'.repeat(32);
const A = '0x' + '12'.repeat(20), B = '0x' + '34'.repeat(20), MODULE = '0x' + '56'.repeat(20);
const ZERO = '0x' + '00'.repeat(32), ZERO_ADDRESS = '0x' + '00'.repeat(20), CID = '0x' + '99'.repeat(32);
const BIG = '29035862971903655586674243772344327311664727652070589302159213246545920';
const MAX = (2n ** 256n - 1n).toString();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const verify = (doc = committed) => verifyAllowlistDocument(doc, { orgId: ORG, root: committed.root });
const headerBytes = (text: string) => new TextEncoder().encode(text);
const hints = (version: EmailCircuitVersion, header: string, overrides = {}) => buildCircuitInputHints({
  version, emailHeader: headerBytes(header), fromEmail: 'a@example.com', dkimDomain: 'provider.net', claimer: A, ...overrides,
});
const simpleHeader = `from:a@example.com\r\nsubject:${buildEmailClaimCommand(A)}\r\n`;
function signals(version: EmailCircuitVersion) { return version === 'v1' ? ['9', '10', BigInt(A).toString(), '11'] : ['9', '10', BigInt(A).toString(), '11', '12']; }
function projection<V extends EmailCircuitVersion>(version: V) {
  return projectGroth16Proof({ version, proof: vector.proof, publicSignals: signals(version), claimer: A });
}

// Independent Solidity oracle: literal ABI encoding and double keccak, then OZ sorted pair hashing.
function solidityLeaf(kind: number, hash: string, ids: readonly string[]): string {
  return ethers.utils.keccak256(ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint8', 'bytes32', 'uint256[]'], [kind, hash, ids])));
}
function processProof(leaf: string, siblings: readonly string[]): string {
  return siblings.reduce((acc, sibling) => ethers.utils.keccak256(ethers.utils.concat([acc, sibling].sort())), leaf);
}

describe('EMAIL-HASH-LIMIT: bounded normalized UTF8 and frozen compatibility', () => {
  for (const [name, hash] of [['poseidonCommit', poseidonCommit], ['domainHash', domainHash], ['emailHash', emailHash]] as const) {
    it(`${name}: 192 accepted at frozen hash; 193 and distinct suffix collisions refused`, () => {
      expect(hash('a'.repeat(192))).toBe('0x0e8a91bec06173fcc7ca640082682b3ede56e9684b200a56b4920fc298dc219e');
      expect(hash('  ' + 'A'.repeat(192) + '  ')).toBe(hash('a'.repeat(192)));
      for (const tail of ['a', 'b']) expect(() => hash('a'.repeat(192) + tail)).toThrow(/192 bytes/);
      expect(() => hash('é'.repeat(96))).not.toThrow();
      expect(() => hash('é'.repeat(97))).toThrow(/192 bytes/);
    });
  }
  it('ASCII-only normalization and build-time non-ASCII restrictions remain unchanged', async () => {
    expect(norm('  İABC  ')).toBe('İabc');
    await expect(buildAllowlist({ orgId: ORG, entries: [{ type: 'domain', identifier: 'é.com', hatIds: ['1'] }] })).rejects.toThrow(/non-ASCII/);
  });
  for (const type of ['domain', 'email'] as const) {
    it(`${type}: build/parser reject overbound input before any tree can be produced`, async () => {
      const good = type === 'email' ? 'a'.repeat(190) + '@b' : 'a'.repeat(192);
      const entry = { type, identifier: good, hatIds: ['1'] };
      await expect(buildAllowlist({ orgId: ORG, entries: [entry] })).resolves.toHaveProperty('root');
      await expect(buildAllowlist({ orgId: ORG, entries: [{ ...entry, identifier: good + 'x' }] })).rejects.toThrow(/192 bytes/);
      expect(parseEntriesFile(JSON.stringify([entry]), 'fixture')).toHaveLength(1);
      expect(() => parseEntriesFile(JSON.stringify([{ ...entry, identifier: good + 'x' }]), 'fixture')).toThrow(/192 bytes/);
    });
  }
  it('domain proof lookup refuses truncating a long query', () => {
    expect(() => proofForDomain(treeFromDoc(committed), 'a'.repeat(193))).toThrow(/192 bytes/);
  });
  it('verified descriptors and merger additions enforce the same 192-byte bound', () => {
    const doc = clone(committed); doc.entries[1].identifier = 'a'.repeat(193);
    expect(() => verify(doc)).toThrow(/192 bytes/);
    expect(() => mergeVerifiedAllowlist({ orgId: ORG, currentRoot: ZERO,
      entries: [{ type: 'domain', identifier: 'a'.repeat(193), hatIds: ['1'] }] })).toThrow(/192 bytes/);
    expect(mergeVerifiedAllowlist({ orgId: ORG, currentRoot: ZERO,
      entries: [{ type: 'domain', identifier: 'a'.repeat(192), hatIds: ['1'] }] }).root).toMatch(/^0x[\da-f]{64}$/);
  });
  it('preserves the three circuit hash constants and ceremony root', async () => {
    const expected = [
      ['opacitylabs.com', '0x29e7dedcdb5e509c3f276fb5d689700f0eaaa74bfaa75259b4c545cd2241a5c2'],
      ['gmail.com', '0x14d46e073cbff5944a738ea295de6c7447606fa5a270571229d8a4b1e7ca77e5'],
      ['ku.edu', '0x256f370d0033263e95a6c486e2a0280c7843b2e0d586e92e6557382f776d6c58'],
    ];
    for (const [name, hash] of expected) expect(domainHash('  ' + name.toUpperCase() + '  ')).toBe(hash);
    const built = await buildAllowlist({ orgId: ORG, entries: expected.map(([identifier]) => ({ type: 'domain', identifier, hatIds: [BIG] })) });
    expect(built.root).toBe('0x1d5d75df3ee05a0a90c42f0fe423f3c063dedf3466378e45a8343bfef18ebc46');
  });
  it('existing builder keeps plaintext privacy and duplicate-role byte defaults', async () => {
    const built = await buildAllowlist({ orgId: ORG, entries: [{ type: 'email', identifier: ' Alice@Org.com ', hatIds: ['42', '0x2a'] }] });
    expect(built.doc.entries[0].identifier).toBe('alice@org.com');
    expect(built.doc.entries[0].hatIds).toEqual(['0x2a', '0x2a']);
    expect(built.root).toBe(solidityLeaf(1, committed.entries[0].emailHash, ['42', '42']));
  });
});

describe('EMAIL-LEAF-FORMAT / EMAIL-COMMITMENT / INVITE-DESCRIPTORS: verified leaf authority', () => {
  it('accepts private/domain leaves and verifies literal independent Solidity root/proof', () => {
    expect(committed.root).toBe('0xb1004de69d23ff09ee71f1634f4160f85fd9bad98d4fea94c63a82a98157d369');
    const value = verify();
    const leaf = projectVerifiedAllowlistLeaves(value)[0];
    expect(leaf).toEqual({ type: 'email', identifier: '', id: '0x2c380d632241cea8851db1d6ef6480c8326b1af38498c6096625943fe3a3165f', hatIds: ['42'] });
    const proof = proofForEmailHash(treeFromDoc(committed), leaf.id)!;
    expect(processProof(solidityLeaf(1, leaf.id, proof.hatIds), proof.proof)).toBe(committed.root);
    expect(proofForEmailHash(treeFromDoc(committed), domainHash('gmail.com'))).toBeNull();
  });
  it('rejects own matching root with uint256 discriminator despite canonical-looking label', () => {
    const wrong = StandardMerkleTree.of([[0, domainHash('gmail.com'), ['42']]], ['uint256', 'bytes32', 'uint256[]']);
    const doc = { ...committed, root: wrong.root, treeDump: wrong.dump() };
    expect(() => assertRootMatches(doc, wrong.root)).toThrow(/unsupported/);
  });
  it('deliberately accepts canonical legacy dump without leafTypes label', () => {
    const doc = clone(committed); delete doc.leafTypes;
    expect(() => verify(doc)).not.toThrow();
  });
  const corruptions: [string, (doc: any) => void][] = [
    ['missing dump', doc => delete doc.treeDump], ['wrong schema version', doc => doc.schema = 'poa.zkemail.allowlist/2'],
    ['wrong label', doc => doc.leafTypes[0] = 'uint256'], ['swapped document root', doc => doc.root = CID],
    ['swapped org', doc => doc.orgId = OTHER_ORG], ['missing org', doc => delete doc.orgId],
    ['missing descriptor', doc => doc.entries.pop()], ['duplicate descriptor', doc => doc.entries[1] = clone(doc.entries[0])],
    ['private hash mismatch', doc => doc.entries[0].emailHash = CID], ['private plaintext mismatch', doc => doc.entries[0].identifier = 'someone@else.com'],
    ['domain display mismatch', doc => doc.entries[1].identifier = 'else.com'], ['domain hash mismatch', doc => doc.entries[1].domainHash = CID],
    ['role grants mismatch', doc => doc.entries[1].hatIds = ['2', '17']], ['role order mismatch', doc => doc.entries[1].hatIds.reverse()],
    ['wrong kind hash', doc => doc.entries[1].emailHash = CID], ['unsafe role index metadata', doc => doc.entries[1].roleIndexes = [2 ** 53]],
    ['missing role-index metadata', doc => delete doc.entries[1].roleIndexes], ['hidden committed leaf', doc => doc.treeDump.values.pop()],
  ];
  for (const [name, corrupt] of corruptions) it(`refuses ${name} before display/merge`, () => {
    const doc = clone(committed); corrupt(doc); expect(() => verify(doc)).toThrow();
  });
  it('checks unsupported kind and empty grant arrays even when OZ own-root matches', () => {
    for (const row of [[2, CID, ['42']], [1, CID, []]]) {
      const tree = StandardMerkleTree.of([row], [...LEAF_TYPES]);
      expect(() => treeFromDoc({ ...committed, root: tree.root, treeDump: tree.dump() })).toThrow(/unsupported leaf/);
    }
  });
  it('validates the explicit expected root, not only document self consistency', () => {
    expect(() => verifyAllowlistDocument(committed, { orgId: ORG, root: CID })).toThrow(/mismatch/);
  });
  it('unchanged private leaf survives editing another identity without plaintext recovery', () => {
    const current = verify();
    const built = mergeVerifiedAllowlist({ orgId: ORG, currentRoot: committed.root, current,
      entries: [{ type: 'domain', identifier: 'gmail.com', hatIds: [BIG, '0x' + BigInt(BIG).toString(16), '0x10', '2', '0x2', MAX] }] });
    const privateLeaf = projectVerifiedAllowlistLeaves(built.verified).find(r => r.type === 'email')!;
    expect(privateLeaf).toEqual(current.leaves[0]);
    expect(built.doc.treeDump.values.find((v: any) => Number(v.value[0]) === 1).value).toEqual(committed.treeDump.values[0].value);
    const grant = proofForDomain(built.tree, 'gmail.com')!;
    expect(grant.hatIds).toEqual(['2', '16', BIG, MAX]);
    expect(processProof(solidityLeaf(0, domainHash('gmail.com'), grant.hatIds), grant.proof)).toBe(built.root);
  });
  it('strips old and new plaintext emails while retaining their hashes', async () => {
    const old = clone(committed); old.entries[0].identifier = 'Alice@Org.com';
    const built = mergeVerifiedAllowlist({ orgId: ORG, currentRoot: committed.root, current: verify(old),
      entries: [{ type: 'email', identifier: 'bob@org.com', hatIds: ['0x2'] }] });
    expect(built.doc.entries.filter(e => e.type === 'email').map(e => e.identifier)).toEqual(['', '']);
    expect(built.json).not.toContain('alice@'); expect(built.json).not.toContain('bob@');
    expect(proofForEmailHash(built.tree, emailHash('bob@org.com'))).not.toBeNull();
    const original = await buildAllowlist({ orgId: ORG, entries: [{ type: 'email', identifier: 'bob@org.com', hatIds: ['2'] }] });
    expect(original.json).toContain('bob@org.com');
  });
  it('republishes exact existing commitment order, including noncanonical duplicate roles', async () => {
    const old = await buildAllowlist({ orgId: ORG, entries: [{ type: 'domain', identifier: 'gmail.com', hatIds: ['2', '2'] }] });
    const rebuilt = buildAllowlistFromVerifiedLeaves(verifyAllowlistDocument(old.doc, { orgId: ORG, root: old.root }));
    expect(rebuilt.root).toBe(old.root); expect(rebuilt.doc.entries[0].hatIds).toEqual(['0x2', '0x2']);
  });
  it('SETTINGS-UNAVAILABLE-BASE: positive unreadable/unknown base refuses; known zero permits a new list', () => {
    const entries = [{ type: 'domain' as const, identifier: 'new.org', hatIds: ['1'] }];
    for (const currentRoot of [committed.root, undefined, null, '0x0']) expect(() => mergeVerifiedAllowlist({ orgId: ORG, currentRoot: currentRoot as string, entries })).toThrow();
    expect(mergeVerifiedAllowlist({ orgId: ORG, currentRoot: ZERO, entries }).doc.entries).toHaveLength(1);
    expect(() => mergeVerifiedAllowlist({ orgId: OTHER_ORG, currentRoot: committed.root, current: verify(), entries })).toThrow(/scope/);
    expect(() => mergeVerifiedAllowlist({ orgId: ORG, currentRoot: ZERO, current: verify(), entries })).toThrow(/scope/);
  });
  it('verified tokens are immutable and structurally forged objects cannot enter the merger/projector', () => {
    const value = verify(); expect(Object.isFrozen(value.leaves[0].hatIds)).toBe(true);
    expect(() => (value.leaves[0].hatIds as string[]).push('99')).toThrow();
    expect(() => projectVerifiedAllowlistLeaves({ ...value } as any)).toThrow(/verified/);
    expect(() => mergeVerifiedAllowlist({ orgId: ORG, currentRoot: committed.root, current: { ...value } as any, entries: [] })).toThrow(/verified/);
  });
  for (const hat of ['-1', '1.5', (2n ** 256n).toString(), 2 ** 53]) it(`refuses invalid new raw uint ${hat}`, () => {
    expect(() => mergeVerifiedAllowlist({ orgId: ORG, currentRoot: ZERO, entries: [{ type: 'domain', identifier: 'new.org', hatIds: [hat] }] })).toThrow();
  });
});

describe('EMAIL-PROOF / EMAIL-PROOF-SCOPE: pure versioned recipe, signed hints and ABI binding', () => {
  it('pins literal current circuit dimensions, named signals and exact command', () => {
    expect(EMAIL_CIRCUIT_RECIPES.v1.publicSignals).toEqual(['pubkeyHash', 'emailNullifier', 'claimerAddress', 'fromDomainHash']);
    expect(EMAIL_CIRCUIT_RECIPES.v2.publicSignals).toEqual(['pubkeyHash', 'emailNullifier', 'claimerAddress', 'emailHash', 'fromDomainHash']);
    expect(EMAIL_CIRCUIT_RECIPES.v2).toMatchObject({ maxHeadersLength: 1024, fromWindow: 256, identifierBytes: 192, rsaChunkBits: 121, rsaChunks: 17 });
    expect(buildEmailClaimCommand(A)).toBe(`Claim POP role for ${A}`);
    for (const bad of ['', ZERO_ADDRESS, '0x123', 'bad', A + '0']) expect(() => buildEmailClaimCommand(bad)).toThrow(/claimer/);
  });
  for (const version of ['v1', 'v2'] as const) {
    for (const length of [1023, 1024, 1025]) it(`${version}: signed header boundary ${length}`, () => {
      const header = simpleHeader.padEnd(length, 'x');
      if (length > 1024) expect(() => hints(version, header)).toThrow(/1024/);
      else expect(hints(version, header)).toMatchObject({ commandIndex: '28', fromWindowIndex: '0', emailIndexInWindow: '5', atIndex: '1' });
    });
    for (const end of [255, 256, 257]) it(`${version}: From address ends at byte ${end} of its window`, () => {
      const header = 'from:' + ' '.repeat(end - 5 - 'a@example.com'.length) + 'a@example.com' + `\r\nsubject:${buildEmailClaimCommand(A)}\r\n`;
      if (end === 257) expect(() => hints(version, header)).toThrow(/256-byte/);
      else expect(Number(hints(version, header).emailIndexInWindow) + 'a@example.com'.length).toBe(end);
    });
    it(`${version}: distinct provider DKIM domain cannot replace proven From-domain identity`, () => {
      const result = hints(version, simpleHeader);
      expect(result.fromDomain).toBe('example.com'); expect(result.dkimDomain).toBe('provider.net');
      expect(result.fromDomainHash).toBe(domainHash('example.com')); expect(result.fromDomainHash).not.toBe(domainHash('provider.net'));
      expect(result.emailHash).toBe(emailHash('a@example.com'));
    });
    it(`${version}: CRLF anchor yields exact indices and ignores address in a later To field`, () => {
      const result = hints(version, 'to:a@example.com\r\n' + simpleHeader);
      expect(result.fromWindowIndex).toBe('16'); expect(result.emailIndexInWindow).toBe('7');
      expect(() => hints(version, `from:other@example.com\r\nto:a@example.com\r\nsubject:${buildEmailClaimCommand(A)}\r\n`)).toThrow(/From/);
      expect(() => hints(version, `x-from:a@example.com\r\nsubject:${buildEmailClaimCommand(A)}\r\n`)).toThrow(/From/);
    });
    it(`${version}: exact full command binds requested claimer before proof engine`, () => {
      expect(() => hints(version, simpleHeader.replace(A, B))).toThrow(/claimer/);
      expect(() => hints(version, simpleHeader.replace(A, A + 'f'))).toThrow(/malformed/);
      expect(() => hints(version, simpleHeader.replace(A, A.slice(0, -1) + 'g'))).toThrow(/malformed/);
      expect(() => hints(version, simpleHeader.replace('Claim', 'claim'))).toThrow(/command/);
    });
    for (const later of [A, B]) {
      for (const location of ['subject', 'signed X-Original-Subject']) {
        it(`${version}: first command remains bound with ${later === A ? 'same' : 'different'} later command in ${location}`, () => {
          const command = buildEmailClaimCommand(later);
          const header = location === 'subject'
            ? simpleHeader.replace('\r\nsubject:', '\r\nsubject:Re: ').replace(/\r\n$/, ` (was: ${command})\r\n`)
            : simpleHeader + `x-original-subject:${command}\r\n`;
          const result = hints(version, header);
          expect(result).toEqual({ ...hints(version, simpleHeader), commandIndex: String(header.indexOf(buildEmailClaimCommand(A))) });
          expect(header.lastIndexOf('Claim POP role for 0x')).toBeGreaterThan(Number(result.commandIndex));
        });
      }
    }
    for (const first of [B, A + 'f', A.slice(0, -1) + 'g']) {
      it(`${version}: a later correct command cannot rescue ${first === B ? 'wrong' : 'malformed'} first command ${first}`, () => {
        const header = simpleHeader.replace(A, first) + `x-original-subject:${buildEmailClaimCommand(A)}\r\n`;
        expect(() => hints(version, header)).toThrow(/claimer mismatch or malformed/);
      });
    }
    it(`${version}: cannot search unsigned SHA/zero padding for the command`, () => {
      expect(() => hints(version, simpleHeader, { signedHeaderLength: 18 })).toThrow(/command/);
    });
    it(`${version}: From-address commitment is bounded at 192/193 bytes`, () => {
      for (const length of [192, 193]) {
        const fromEmail = 'a'.repeat(length - '@example.com'.length) + '@example.com';
        const header = `from:${fromEmail}\r\nsubject:${buildEmailClaimCommand(A)}\r\n`;
        if (length === 192) expect(() => hints(version, header, { fromEmail })).not.toThrow();
        else expect(() => hints(version, header, { fromEmail })).toThrow(/192 bytes/);
      }
    });
    it(`${version}: projection swaps G2 pairs and selects literal signal positions`, () => {
      const result = projection(version);
      expect(result.proof).toMatchObject(vector.expected);
      expect(result.proof.pubkeyHash).toBe('0x' + '0'.repeat(63) + '9');
      expect(result.proof.emailNullifier).toBe('0x' + '0'.repeat(63) + 'a');
      expect(result.proof.fromDomainHash).toBe('0x' + '0'.repeat(63) + (version === 'v1' ? 'b' : 'c'));
      if (version === 'v2') expect((result.proof as any).emailHash).toBe('0x' + '0'.repeat(63) + 'b');
      else expect('emailHash' in result.proof).toBe(false);
      expect(() => projectGroth16Proof({ version, proof: vector.proof, publicSignals: signals(version), claimer: B })).toThrow(/claimer/);
      expect(() => projectGroth16Proof({ version, proof: vector.proof, publicSignals: signals(version === 'v1' ? 'v2' : 'v1'), claimer: A })).toThrow(/signals/);
    });
  }
  it('accepts uppercase address digits in a numeric-equivalent signed command', () => {
    const upper = '0x' + 'AB'.repeat(20);
    expect(hints('v1', simpleHeader.replace(A, upper), { claimer: upper.toLowerCase() }).commandIndex).toBe('28');
  });
  it('canonicalizes an uppercase address prefix to the circuit literal 0x', () => {
    const address = '0X' + 'AB'.repeat(20);
    const command = buildEmailClaimCommand(address);
    expect(command).toBe('Claim POP role for 0x' + 'AB'.repeat(20));
    expect(hints('v1', simpleHeader.replace(buildEmailClaimCommand(A), command), { claimer: address }).commandIndex).toBe('28');
  });
  it('rejects From/recipe/byte/missing signing-domain errors before engine use', () => {
    expect(() => hints('unknown' as any, simpleHeader)).toThrow(/recipe/);
    expect(() => hints('v1', simpleHeader + 'from:a@example.com\r\n')).toThrow(/one canonical/);
    expect(() => hints('v1', simpleHeader, { fromEmail: 'a@@example.com' })).toThrow(/Invalid From/);
    expect(() => hints('v1', simpleHeader, { dkimDomain: '' })).toThrow(/DKIM/);
    expect(() => buildCircuitInputHints({ version: 'v1', emailHeader: ['256'], fromEmail: 'a@example.com', dkimDomain: 'example.com', claimer: A })).toThrow(/invalid bytes/);
    expect(() => buildCircuitInputHints({ version: 'v1', emailHeader: [-1], fromEmail: 'a@example.com', dkimDomain: 'example.com', claimer: A })).toThrow();
  });
  const proofErrors: [string, (proof: any, pubSignals: any[]) => void][] = [
    ['A shape', p => p.pi_a.pop()], ['B shape', p => p.pi_b[0].push('5')], ['C shape', p => p.pi_c = null],
    ['projective A', p => p.pi_a[2] = '2'], ['projective B', p => p.pi_b[2] = ['0', '1']],
    ['base-field bound', p => p.pi_a[0] = EMAIL_BASE_FIELD], ['negative coordinate', p => p.pi_c[0] = '-1'],
    ['unsafe Number', p => p.pi_a[0] = 2 ** 53], ['fractional coordinate', p => p.pi_a[0] = '1.1'],
    ['signal-field bound', (_, s) => s[0] = EMAIL_SCALAR_FIELD], ['negative signal', (_, s) => s[1] = '-1'],
    ['wrong protocol', p => p.protocol = 'plonk'], ['wrong curve', p => p.curve = 'bls12381'],
  ];
  for (const [name, corrupt] of proofErrors) it(`refuses ${name} before intent`, () => {
    const p = clone(vector.proof), s = signals('v1'); corrupt(p, s);
    expect(() => projectGroth16Proof({ version: 'v1', proof: p, publicSignals: s, claimer: A })).toThrow();
  });
  it('encodes exact v1/v2 current ABI tuples using a separately declared contract oracle', () => {
    const common = ['uint256[2] pA', 'uint256[2][2] pB', 'uint256[2] pC', 'bytes32 pubkeyHash', 'bytes32 emailNullifier'];
    const oracle = new ethers.utils.Interface([
      `function claimRoleByDomain((${[...common, 'bytes32 fromDomainHash'].join(',')}) proof,address claimer,uint256[] hatIds,bytes32[] merkleProof)`,
      `function claimRoleByEmail((${[...common, 'bytes32 emailHash', 'bytes32 fromDomainHash'].join(',')}) proof,address claimer,uint256[] hatIds,bytes32[] merkleProof)`,
    ]);
    const domain = projection('v1'), email = projection('v2');
    const base = { zkEmailInvitesAddress: MODULE, claimer: A, hatIds: [BIG, '0x2', '2'], merkleProof: [CID] };
    const intents = [buildClaimRoleByDomain({ ...base, proof: domain }), buildClaimRoleByEmail({ ...base, proof: email })];
    for (const [index, intent] of intents.entries()) {
      const b32 = (s: number) => ethers.utils.hexZeroPad(ethers.utils.hexlify(s), 32);
      const proof = { ...vector.expected, pubkeyHash: b32(9), emailNullifier: b32(10), fromDomainHash: b32(index === 0 ? 11 : 12), ...(index === 1 ? { emailHash: b32(11) } : {}) };
      expect(encodeIntent(intent).data).toBe(oracle.encodeFunctionData(intent.method, [proof, A, [BIG, '2', '2'], [CID]]));
      expect(intent.args[2]).toEqual([BIG, '2', '2']); expect(encodeIntent(intent).value).toBe('0');
    }
    expect(() => buildClaimRoleByEmail({ ...base, proof: domain as any })).toThrow(/recipe/);
    expect(() => buildClaimRoleByDomain({ ...base, proof: domain, claimer: B })).toThrow(/claimer/);
    expect(() => buildClaimRoleByDomain({ ...base, proof: { ...domain } as any })).toThrow(/recipe/);
    expect(() => buildClaimRoleByDomain({ ...base, proof: domain, hatIds: [] })).toThrow(/role/);
    expect(() => buildClaimRoleByDomain({ ...base, proof: domain, merkleProof: ['0x1'] })).toThrow(/merkle/);
    expect(Object.isFrozen(domain.proof.pB[0])).toBe(true);
  });
});

const scope = { chainId: 100, orgId: ORG, contract: MODULE };
const indexSource: SourceRef = { ...scope, endpoint: 'mock://graph', method: 'FetchZkEmailModule', indexed: true, snapshot: 'latest', observedAt: 1000 };
const liveSource: SourceRef = { ...scope, endpoint: 'mock://rpc', method: 'invite wiring @ block 10', indexed: false, snapshot: 'pinned', block: { number: '10' }, observedAt: 1000 };
function indexedResponse(overrides: any = {}) {
  return { organization: { id: ORG, zkEmailInvites: { id: MODULE, activeRoot: committed.root, activeAllowlistCid: bytes32ToCidV0(CID),
    executor: A, domainVerifier: A, emailVerifier: A, accountRegistry: A, universalFactory: ZERO_ADDRESS,
    dkimRegistry: { id: A, keys: [] }, activeAllowlist: { root: committed.root, entries: [] }, ...overrides } } };
}
function liveFacts(): InviteStateFacts {
  return { root: knownFact(committed.root), cidDigest: knownFact(CID), entries: unknownFact('NOT_REQUIRED_FOR_LIVE'),
    executor: knownFact(A), domainVerifier: knownFact(A), emailVerifier: knownFact(A), dkimRegistry: knownFact(A),
    accountRegistry: knownFact(ZERO_ADDRESS), universalFactory: knownFact(ZERO_ADDRESS), authorityReady: knownFact(true), authorityMatches: knownFact(true),
    minterAuthorized: knownFact(true), dkimKeyValid: knownFact(true), circuitVersion: knownFact('v1'), keyVersion: knownFact('ceremony-v1'), budgetAvailable: knownFact(false) };
}
function liveSnapshot(data = liveFacts()): SourceSnapshot<InviteStateFacts> {
  return { source: clone(liveSource), data, coverage: { status: 'complete', receivedKeys: [MODULE], missingIds: [], failedIds: [], issues: [] } };
}
async function readIndex(response = indexedResponse(), readAuthoritative?: () => Promise<SourceSnapshot<InviteStateFacts>>) {
  return readInviteStateFacts({ scope, source: indexSource, query: vi.fn().mockResolvedValue(response), readAuthoritative });
}
function project(evidence: InviteStateEvidence, overrides = {}) {
  return projectInviteState({ scope, evidence, document: verify(), documentCidDigest: CID, version: 'v1', keyVersion: 'ceremony-v1', ...overrides });
}

describe('INVITE-READ-STATE / EMAIL-DEPLOYMENT: explicit source and action truth', () => {
  const indexCases: [string, () => any][] = [
    ['null root', () => indexedResponse({ activeRoot: null })], ['missing root', () => indexedResponse({ activeRoot: undefined })],
    ['wrong module', () => indexedResponse({ id: B })], ['mismatched list', () => indexedResponse({ activeAllowlist: { root: CID, entries: [] } })],
    ['capped entries', () => indexedResponse({ activeAllowlist: { root: committed.root, entries: Array(1000).fill({}) } })],
    ['capped DKIM keys', () => indexedResponse({ dkimRegistry: { id: A, keys: Array(1000).fill({}) } })],
    ['missing entry array', () => indexedResponse({ activeAllowlist: { root: committed.root } })],
    ['empty positive-root list', () => indexedResponse()],
  ];
  for (const [name, input] of indexCases) it(`${name}: never becomes known dormant or ready from index alone`, async () => {
    const evidence = await readIndex(input()); const result = project(evidence);
    expect(result.lifecycle.state).toBe('unknown'); expect(result.action.status).toBe('blocked'); expect(result.indexedEntries.state).toBe('unknown');
  });
  it('graph failure is unavailable evidence; query variables preserve exact scope', async () => {
    const query = vi.fn().mockRejectedValue(new Error('offline failure'));
    const evidence = await readInviteStateFacts({ scope, source: indexSource, query });
    expect(evidence.indexed.coverage.status).toBe('unavailable'); expect(evidence.indexed.data.root.state).toBe('unknown');
    expect(query).toHaveBeenCalledOnce(); expect(query.mock.calls[0][1]).toEqual({ orgId: ORG }); expect(query.mock.calls[0][2]).toBe(100);
    expect(project(evidence).lifecycle.state).toBe('unknown');
  });
  it('cannot mislabel an unpinned graph document or wrong source scope before querying', async () => {
    const query = vi.fn().mockResolvedValue(indexedResponse());
    for (const source of [{ ...indexSource, snapshot: 'pinned' as const, block: { number: '10' } },
      { ...indexSource, block: { number: '10' } }, { ...indexSource, chainId: 42161 }, { ...indexSource, endpoint: '' }]) {
      await expect(readInviteStateFacts({ scope, source, query })).rejects.toThrow();
    }
    expect(query).not.toHaveBeenCalled();
  });
  it('authoritative known zero is dormant even when index wrongly advertises an active root', async () => {
    const data = liveFacts(); data.root = knownFact(ZERO); data.cidDigest = knownFact(ZERO);
    const evidence = await readIndex(indexedResponse(), async () => liveSnapshot(data));
    const result = project(evidence); expect(result.lifecycle).toMatchObject({ state: 'known', value: 'dormant' });
    expect(result.action).toMatchObject({ status: 'blocked', codes: expect.arrayContaining(['ALLOWLIST_DORMANT']) });
  });
  it('indexed grants preserve exact raw IDs while missing/unsafe/mismatched fields stay unknown', async () => {
    const row = { index: '0', entryType: 'domain', identifier: 'gmail.com', identifierHash: domainHash('gmail.com'), hatIds: [BIG], roleIndexes: [] };
    const good = await readIndex(indexedResponse({ activeAllowlist: { root: committed.root, entries: [row] } }));
    expect(project(good).indexedEntries).toMatchObject({ state: 'known', value: [{ index: 0, hatIds: [BIG] }] });
    for (const change of [{ hatIds: undefined }, { hatIds: null }, { hatIds: [] }, { roleIndexes: null }, { index: '9007199254740993' },
      { identifierHash: CID }, { identifier: 'wrong.example' }, { identifierHash: null }, { roleIndexes: [2 ** 53] }]) {
      const evidence = await readIndex(indexedResponse({ activeAllowlist: { root: committed.root, entries: [{ ...row, ...change }] } }));
      expect(project(evidence).indexedEntries.state).toBe('unknown'); expect(evidence.indexed.coverage.status).toBe('incomplete');
    }
    const duplicate = await readIndex(indexedResponse({ activeAllowlist: { root: committed.root, entries: [row, row] } }));
    expect(project(duplicate).indexedEntries.state).toBe('unknown');
  });
  it('missing enrollment factory/account registry leaves existing-account bare claim ready', async () => {
    const evidence = await readIndex(indexedResponse(), async () => liveSnapshot());
    expect(project(evidence).action.status).toBe('ready');
    expect(project(evidence, { enrollment: true }).action).toMatchObject({ status: 'blocked', codes: expect.arrayContaining(['FACTORY_UNSET', 'ACCOUNT_REGISTRY_UNSET']) });
    expect(project(evidence, { sponsored: true }).action).toMatchObject({ status: 'blocked', codes: expect.arrayContaining(['BUDGET_UNAVAILABLE']) });
  });
  it('capped index can be replaced only by complete live evidence and a verified full document', async () => {
    const evidence = await readIndex(indexedResponse({ activeAllowlist: { root: committed.root, entries: Array(1000).fill({}) } }), async () => liveSnapshot());
    const result = project(evidence); expect(result.indexedEntries.state).toBe('unknown'); expect(result.action.status).toBe('ready');
    expect(project(evidence, { document: undefined }).action.status).toBe('blocked');
  });
  for (const [field, bad] of [['authorityReady', false], ['authorityMatches', false], ['minterAuthorized', false], ['dkimKeyValid', false],
    ['executor', ZERO_ADDRESS], ['domainVerifier', ZERO_ADDRESS], ['dkimRegistry', ZERO_ADDRESS], ['circuitVersion', 'v2'], ['keyVersion', 'stale-key']] as const) {
    it(`live ${field}=${bad} blocks affected action`, async () => {
      const data = liveFacts(); (data as any)[field] = knownFact(bad);
      const evidence = await readIndex(indexedResponse(), async () => liveSnapshot(data));
      expect(project(evidence).action.status).toBe('blocked');
    });
  }
  it('an email action needs its own v2 verifier/key and does not depend on domain verifier', async () => {
    const data = liveFacts(); data.domainVerifier = knownFact(ZERO_ADDRESS); data.circuitVersion = knownFact('v2'); data.keyVersion = knownFact('ceremony-v2');
    const evidence = await readIndex(indexedResponse(), async () => liveSnapshot(data));
    expect(project(evidence, { version: 'v2', keyVersion: 'ceremony-v2' }).action.status).toBe('ready');
    data.emailVerifier = knownFact(ZERO_ADDRESS);
    expect(project(evidence, { version: 'v2', keyVersion: 'ceremony-v2' }).action.status).toBe('blocked');
  });
  it('wrong org/chain/contract, stale, partial or indexed authority cannot authorize proof/sign', async () => {
    for (const mutate of [
      (s: SourceSnapshot<InviteStateFacts>) => s.source.chainId = 42161,
      (s: SourceSnapshot<InviteStateFacts>) => s.source.orgId = OTHER_ORG,
      (s: SourceSnapshot<InviteStateFacts>) => s.source.contract = B,
      (s: SourceSnapshot<InviteStateFacts>) => s.source.indexed = true,
      (s: SourceSnapshot<InviteStateFacts>) => s.coverage.status = 'incomplete',
      (s: SourceSnapshot<InviteStateFacts>) => s.source.observedAt = 999,
      (s: SourceSnapshot<InviteStateFacts>) => s.source.snapshot = 'unknown',
      (s: SourceSnapshot<InviteStateFacts>) => s.data.root = unknownFact('RPC_MISSING'),
      (s: SourceSnapshot<InviteStateFacts>) => s.data.minterAuthorized = unknownFact('RPC_FAILED'),
      (s: SourceSnapshot<InviteStateFacts>) => s.data.root = knownFact(committed.root, { ...liveSource, indexed: true }),
      (s: SourceSnapshot<InviteStateFacts>) => s.data.root = knownFact(committed.root, { ...liveSource, block: { number: '9' } }),
      (s: SourceSnapshot<InviteStateFacts>) => s.data.dkimKeyValid = knownFact(true, { ...liveSource, observedAt: 999 }),
    ]) {
      const live = liveSnapshot(); mutate(live); const evidence = await readIndex(indexedResponse(), async () => live);
      expect(project(evidence, { freshness: { nowSeconds: 1000, maxAgeSeconds: 0 } }).action.status).toBe('blocked');
    }
  });
  it('exact current root/CID/key binding refuses a swapped document or CID even with valid wiring', async () => {
    const evidence = await readIndex(indexedResponse(), async () => liveSnapshot());
    expect(project(evidence, { documentCidDigest: ZERO }).action.status).toBe('blocked');
    expect(project(evidence, { document: { ...verify() } }).action.status).toBe('blocked');
    const data = liveFacts(); data.root = knownFact(CID);
    const swapped = await readIndex(indexedResponse(), async () => liveSnapshot(data));
    expect(project(swapped).action.status).toBe('blocked');
  });
  it('authoritative callback failure is propagated rather than converted to empty success', async () => {
    await expect(readIndex(indexedResponse(), async () => { throw new Error('RPC failed'); })).rejects.toThrow(/RPC failed/);
  });
});
