import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { ethers } from 'ethers';
import { encodeFunctionData, parseAbi, hashTypedData, encodeAbiParameters, keccak256 } from 'viem';
import { buildRegisterAndQuickJoin, buildRegisterAndQuickJoinWithPasskey } from '../src/tx/user';
import { buildRegisterAndClaimByDomainWithPasskey, buildRegisterAndClaimByEmailWithPasskey } from '../src/tx/zkemail';
import { encodeIntent } from '../src/tx/intent';
import { registrationChallenge } from '../src/accounts/codecs';
import { projectGroth16Proof } from '../src/email/proof';
import { replaceVerifiedAllowlist, verifyAllowlistDocument, buildAllowlistFromVerifiedLeaves } from '../src/email/allowlist';
import { domainHash, emailHash } from '../src/zkemail';

const A = '0x' + '12'.repeat(20), TARGET = '0x' + '34'.repeat(20), ORG = '0x' + '11'.repeat(32);
const b32 = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const big = 2n ** 180n + 17n;
const passkey = { credentialId: b32(71), publicKeyX: b32(81), publicKeyY: b32(91), salt: (big + 1n).toString() };
const auth = { authenticatorData: '0x123456', clientDataJSON: '0x7b7d', challengeIndex: '9007199254740993', typeIndex: 7,
  r: b32(3), s: b32(4) };
const registration = { passkey, username: 'alice_2', deadline: big.toString(), nonce: (big + 2n).toString(), auth };
const eoa = { quickJoinAddress: TARGET, user: A, username: registration.username, deadline: registration.deadline, nonce: registration.nonce, signature: '0x12345678' };
// Handwritten, independent signatures: not derived from the builder's ABI or argument tuples.
const pk = '(bytes32,bytes32,bytes32,uint256)', wa = '(bytes,bytes,uint256,uint256,bytes32,bytes32)';
const v1 = '(uint256[2],uint256[2][2],uint256[2],bytes32,bytes32,bytes32)';
const v2 = '(uint256[2],uint256[2][2],uint256[2],bytes32,bytes32,bytes32,bytes32)';
const signatures = [
  'function registerAndQuickJoin(address,string,uint256,uint256,bytes)',
  `function registerAndQuickJoinWithPasskey(${pk},string,uint256,uint256,${wa})`,
  `function registerAndClaimByDomainWithPasskey(${pk},string,uint256,uint256,${wa},${v1},uint256[],bytes32[])`,
  `function registerAndClaimByEmailWithPasskey(${pk},string,uint256,uint256,${wa},${v2},uint256[],bytes32[])`,
];
const regValues = [[passkey.credentialId, passkey.publicKeyX, passkey.publicKeyY, BigInt(passkey.salt)], 'alice_2', big, big + 2n,
  [auth.authenticatorData, auth.clientDataJSON, 9007199254740993n, 7n, auth.r, auth.s]];
const hats = [(big + 90n).toString(), '2', (big + 3n).toString()];
const merkleProof = [b32(77), b32(88)];
const rawProof = { pi_a: [big, big + 1n, 1n], pi_b: [[big + 2n, big + 3n], [big + 4n, big + 5n], [1n, 0n]], pi_c: [big + 6n, big + 7n, 1n] };
const proof = <V extends 'v1' | 'v2'>(version: V) => projectGroth16Proof({ version, proof: rawProof,
  publicSignals: version === 'v1' ? [9n, 10n, BigInt(A), 11n] : [9n, 10n, BigInt(A), 12n, 11n], claimer: A });
const emailArgs = <V extends 'v1' | 'v2'>(version: V) => ({ ...registration, zkEmailInvitesAddress: TARGET, claimer: A, proof: proof(version), hatIds: hats, merkleProof });
const encoded = (signature: string, functionName: string, args: unknown[]) => encodeFunctionData({ abi: parseAbi([signature]), functionName, args } as any).toLowerCase();

describe('MI-ATOMIC-ENROLLMENT: exact atomic current-ABI intents', () => {
  it('pins RegisterPasskeyAccount primary type independently, including exact registry/chain/nonce/deadline', () => {
    const input = { user: A, username: 'alice_2', nonce: big + 2n, deadline: big, chainId: 100, registryAddress: TARGET };
    const expected = hashTypedData({ domain: { name: 'UniversalAccountRegistry', version: '1', chainId: 100, verifyingContract: TARGET },
      primaryType: 'RegisterPasskeyAccount', types: { RegisterPasskeyAccount: [
        { name: 'user', type: 'address' }, { name: 'username', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
      ] }, message: { user: A, username: 'alice_2', nonce: big + 2n, deadline: big } } as any);
    expect(registrationChallenge(input, 'passkey')).toBe(expected);
    expect(registrationChallenge(input, 'eoa')).not.toBe(expected);
    expect(registrationChallenge({ ...input, chainId: 42161 })).not.toBe(expected);
  });
  it('EOA intent matches independent calldata and selector 0x7109c53a', () => {
    const intent = buildRegisterAndQuickJoin(eoa), data = encodeIntent(intent).data;
    expect(data.slice(0, 10)).toBe('0x7109c53a');
    expect(data).toBe(encoded(signatures[0], 'registerAndQuickJoin', [A, 'alice_2', big, big + 2n, eoa.signature]));
    expect(intent.to.toLowerCase()).toBe(TARGET);
  });
  it('passkey join preserves named enrollment and WebAuthn values in one intent', () => {
    const data = encodeIntent(buildRegisterAndQuickJoinWithPasskey({ ...registration, quickJoinAddress: TARGET })).data;
    expect(data.slice(0, 10)).toBe('0x5f26a7c8');
    expect(data).toBe(encoded(signatures[1], 'registerAndQuickJoinWithPasskey', regValues));
  });
  it.each([['v1', 'registerAndClaimByDomainWithPasskey', '0x6108482e', buildRegisterAndClaimByDomainWithPasskey],
    ['v2', 'registerAndClaimByEmailWithPasskey', '0x998dc9d6', buildRegisterAndClaimByEmailWithPasskey]] as const)(
    '%s claim preserves large salt/nonce/G2 swap and exact leaf order', (version, method, selector, builder) => {
      const args = emailArgs(version), intent = builder(args as any), data = encodeIntent(intent).data;
      const proofValues = [[big, big + 1n], [[big + 3n, big + 2n], [big + 5n, big + 4n]], [big + 6n, big + 7n], b32(9), b32(10),
        ...(version === 'v2' ? [b32(12)] : []), b32(11)];
      expect(data.slice(0, 10)).toBe(selector);
      expect(data).toBe(encoded(signatures[version === 'v1' ? 2 : 3], method, [...regValues, proofValues, hats.map(BigInt), merkleProof]));
      const decoded = new ethers.utils.Interface(intent.abi).decodeFunctionData(method, data);
      expect(decoded[6].map(String)).toEqual(hats);
      expect(decoded[5].pB.map((row: any[]) => row.map(String))).toEqual([[String(big + 3n), String(big + 2n)], [String(big + 5n), String(big + 4n)]]);
      // Defensive copies: host form edits after review cannot alter the produced calldata.
      args.hatIds = ['1']; args.merkleProof = [];
      expect(encodeIntent(intent).data).toBe(data);
    });
  it.each([{ nonce: -1 }, { nonce: Number.MAX_SAFE_INTEGER + 1 }, { deadline: '1e10' }, { deadline: 2n ** 256n },
    { username: 'ab' }, { username: 'has space' }, { username: 123 }])('all atomic paths reject malformed common registration inputs %#', change => {
    expect(() => buildRegisterAndQuickJoin({ ...eoa, ...change } as any)).toThrow();
    expect(() => buildRegisterAndQuickJoinWithPasskey({ ...registration, quickJoinAddress: TARGET, ...change } as any)).toThrow();
    expect(() => buildRegisterAndClaimByDomainWithPasskey({ ...emailArgs('v1'), ...change } as any)).toThrow();
    expect(() => buildRegisterAndClaimByEmailWithPasskey({ ...emailArgs('v2'), ...change } as any)).toThrow();
  });
  it.each([{ passkey: { ...passkey, salt: Number.MAX_SAFE_INTEGER + 1 } }, { passkey: { ...passkey, publicKeyX: '0x11' } },
    { passkey: { ...passkey, credentialId: 'bad' } }, { auth: { ...auth, challengeIndex: -1 } }, { auth: { ...auth, s: '0x12' } },
    { auth: { ...auth, authenticatorData: '0x1' } }])('passkey paths reuse strict codecs for %j', change => {
    expect(() => buildRegisterAndQuickJoinWithPasskey({ ...registration, quickJoinAddress: TARGET, ...change } as any)).toThrow();
    expect(() => buildRegisterAndClaimByDomainWithPasskey({ ...emailArgs('v1'), ...change } as any)).toThrow();
    expect(() => buildRegisterAndClaimByEmailWithPasskey({ ...emailArgs('v2'), ...change } as any)).toThrow();
  });
  it('refuses forged/wrong-recipe/wrong-claimer proofs and invalid targets/signature/grants', () => {
    const a = emailArgs('v1');
    for (const change of [{ proof: { ...a.proof } }, { proof: proof('v2') }, { claimer: TARGET }, { hatIds: [Number.MAX_SAFE_INTEGER + 1] },
      { hatIds: [] }, { hatIds: Array(1) }, { merkleProof: Array(1) }, { merkleProof: ['0x12'] }, { zkEmailInvitesAddress: ethers.constants.AddressZero }]) {
      expect(() => buildRegisterAndClaimByDomainWithPasskey({ ...a, ...change } as any)).toThrow();
    }
    for (const change of [{ signature: '0x1' }, { signature: '0x' }, { user: ethers.constants.AddressZero }, { quickJoinAddress: 'bad' }])
      expect(() => buildRegisterAndQuickJoin({ ...eoa, ...change })).toThrow();
  });
});

const committed = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/core-update/email/committed.json'), 'utf8'));
const base = () => verifyAllowlistDocument(committed, { orgId: ORG, root: committed.root });
const replacement = (current = base()) => ({ orgId: ORG, currentRoot: committed.root, current,
  retained: current.leaves.map(leaf => ({ leaf })) });
const leafHash = (type: number, id: string, hats: readonly string[]) => keccak256(keccak256(encodeAbiParameters(
  [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'uint256[]' }], [type, id as `0x${string}`, hats.map(BigInt)])));

describe('MI-PRIVATE-ALLOWLIST-REPLACEMENT: reviewed edits with exact source authority', () => {
  it('unchanged selection retains the root and canonical republish bytes without recovering plaintext', () => {
    const args = replacement(), built = replaceVerifiedAllowlist(args);
    expect(built.root).toBe(committed.root);
    expect(built.json).toBe(buildAllowlistFromVerifiedLeaves(args.current).json);
    expect(built.json).not.toContain('alice@');
    expect(Object.isFrozen(args.current.leaves[0])).toBe(true);
  });
  it('removes a subset while retaining an unseen private commitment', () => {
    const args = replacement(); args.retained = args.retained.filter(r => r.leaf.type === 'email');
    const built = replaceVerifiedAllowlist(args), old = args.retained[0].leaf;
    expect(built.verified.leaves).toEqual([old]);
    expect(built.root).toBe(leafHash(1, old.id, old.hatIds));
  });
  it('reassigns private grants, preserves untouched nonascending leaf order, and sorts only authored grants', () => {
    const args = replacement();
    const built = replaceVerifiedAllowlist({ ...args, retained: [{ leaf: args.current.leaves[0], hatIds: [big.toString(), '2'] }] });
    expect(built.root).toBe(leafHash(1, args.current.leaves[0].id, ['2', big.toString()]));
    const unsorted = replaceVerifiedAllowlist({ ...args, retained: [{ leaf: args.current.leaves[1], hatIds: ['16', '2'] }] });
    // Verify a historical nonascending commitment independently rather than relying on authored sorting.
    const doc = structuredClone(committed); doc.entries[1].hatIds.reverse();
    const tree = StandardMerkleTree.of([[0, domainHash('gmail.com'), ['16', '2']]], ['uint8', 'bytes32', 'uint256[]']);
    doc.entries = [doc.entries[1]]; doc.root = tree.root; doc.treeDump = tree.dump();
    const old = verifyAllowlistDocument(doc, { orgId: ORG, root: tree.root });
    expect(replaceVerifiedAllowlist({ orgId: ORG, currentRoot: tree.root, current: old, retained: old.leaves.map(leaf => ({ leaf })) }).root).toBe(tree.root);
    expect(unsorted.root).not.toBe(tree.root);
    expect(args.current.leaves[0].hatIds).toEqual(['42']);
  });
  it('adds normalized public/private identities with deterministic encoding and no private plaintext', () => {
    const args = replacement(), additions = [
      { type: 'domain' as const, identifier: ' New.Example ', hatIds: [big.toString(), '2'] },
      { type: 'email' as const, identifier: ' New@Example.com ', hatIds: ['3'] },
    ];
    const built = replaceVerifiedAllowlist({ ...args, additions });
    expect(replaceVerifiedAllowlist({ ...args, additions }).json).toBe(built.json);
    expect(built.doc.entries.find(e => e.domainHash === domainHash('new.example'))).toMatchObject({ identifier: 'new.example', hatIds: ['0x2', '0x' + big.toString(16)], roleIndexes: [] });
    expect(built.doc.entries.find(e => e.emailHash === emailHash('new@example.com'))).toMatchObject({ identifier: '', hatIds: ['0x3'] });
    expect(built.json.toLowerCase()).not.toContain('new@example.com');
    expect(verifyAllowlistDocument(built.doc, { orgId: ORG, root: built.root }).root).toBe(built.root);
  });
  it('rejects arbitrary/copied/other-source private handles, wrong org/root and forged bases', () => {
    const args = replacement();
    for (const leaf of [{ ...args.current.leaves[0], id: b32(999) }, { ...args.current.leaves[0] }, base().leaves[0]])
      expect(() => replaceVerifiedAllowlist({ ...args, retained: [{ leaf }] })).toThrow(/verified source/);
    for (const change of [{ orgId: b32(123) }, { currentRoot: b32(123) }, { current: { ...args.current } }])
      expect(() => replaceVerifiedAllowlist({ ...args, ...change } as any)).toThrow();
    expect(() => replaceVerifiedAllowlist({ ...args, additions: [{ type: 'email', identifier: '', emailHash: b32(999), hatIds: ['1'] }] } as any)).toThrow();
  });
  it('rejects duplicate identities/selections, empty final lists, invalid additions and unsafe/duplicate grants', () => {
    const args = replacement();
    expect(() => replaceVerifiedAllowlist({ ...args, retained: [args.retained[0], args.retained[0]] })).toThrow(/Duplicate/);
    expect(() => replaceVerifiedAllowlist({ ...args, additions: [{ type: 'domain', identifier: 'GMAIL.COM', hatIds: ['1'] }] })).toThrow(/Duplicate/);
    expect(() => replaceVerifiedAllowlist({ ...args, retained: [] })).toThrow(/at least one/);
    for (const hatIds of [[], ['2', '0x2'], [-1], [Number.MAX_SAFE_INTEGER + 1], ['1e3'], [2n ** 256n], null, Array(1)]) {
      expect(() => replaceVerifiedAllowlist({ ...args, retained: [{ leaf: args.current.leaves[0], hatIds }] } as any)).toThrow();
      expect(() => replaceVerifiedAllowlist({ ...args, additions: [{ type: 'email', identifier: 'new@example.com', hatIds }] } as any)).toThrow();
    }
    for (const entry of [{ type: 'domain', identifier: 'é.com', hatIds: ['1'] }, { type: 'domain', identifier: 'a'.repeat(193), hatIds: ['1'] },
      { type: 'domain', identifier: 'bad@example.com', hatIds: ['1'] }, { type: 'email', identifier: 'bad', hatIds: ['1'] },
      { type: 'domain', identifier: 'new.com', hatIds: ['1'], roleIndexes: [Number.MAX_SAFE_INTEGER + 1] }])
      expect(() => replaceVerifiedAllowlist({ ...args, additions: [entry] } as any)).toThrow();
  });
});

describe('new/extended public browser leaves', () => {
  it.each(['tx/user', 'tx/zkemail', 'email/allowlist', 'authority/indexed-cap', 'governance/role-planning'])('%s browser bundle excludes Node/optional executors', async leaf => {
    const result = await build({ entryPoints: [resolve(__dirname, `../src/${leaf}.ts`)], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
    expect(Object.keys(result.metafile!.inputs).filter(path => /\/execute\/|\/viem\/|\/permissionless\/|src\/index\.ts/.test(path))).toEqual([]);
    expect(result.outputFiles[0].text.length).toBeGreaterThan(0);
  });
});
