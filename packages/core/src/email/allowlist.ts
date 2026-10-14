/** Verified commitments, independent of plaintext recovery, storage and upload policy. */
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import {
  ALLOWLIST_SCHEMA, LEAF_TYPES, AllowlistDoc, AllowlistInputEntry, EntryType,
  assertRootMatches, domainHash, emailHash, isPrintableAscii, norm, requireAllowlistUint,
} from '../zkemail';

const verifiedBrand: unique symbol = Symbol('VerifiedAllowlist');
const verified = new WeakSet<object>();
const bytes32 = (value: unknown): string => {
  if (typeof value !== 'string' || !/^0x[\da-f]{64}$/i.test(value)) throw new Error('Expected bytes32');
  return value.toLowerCase();
};
const zero = '0x' + '00'.repeat(32);

export interface VerifiedAllowlistLeaf {
  readonly type: EntryType;
  readonly id: string;
  /** Exact committed order; never sort an existing leaf while verifying it. */
  readonly hatIds: readonly string[];
  /** Verified domain name. Email identifiers are always blank. */
  readonly identifier: string;
}
export interface VerifiedAllowlist {
  readonly [verifiedBrand]: true;
  readonly orgId: string;
  readonly root: string;
  readonly leaves: readonly VerifiedAllowlistLeaf[];
}
export interface AllowlistScope { orgId: string; root: string }

function checkVerified(value: VerifiedAllowlist): void {
  if (!value || !verified.has(value)) throw new Error('A verified allowlist is required');
}
function leafKey(type: EntryType, id: string, hats: readonly string[]): string {
  return JSON.stringify([type, id, hats]);
}
function identifierHash(type: EntryType, identifier: string): string {
  if (!isPrintableAscii(identifier) || (type === 'email' ? !identifier.includes('@') : identifier.includes('@'))) {
    throw new Error('Invalid allowlist identifier');
  }
  return type === 'domain' ? domainHash(identifier) : emailHash(identifier);
}

/** Require the expected org/root and a one-to-one descriptor binding to every actual leaf. */
export function verifyAllowlistDocument(doc: unknown, expected: AllowlistScope): VerifiedAllowlist {
  const orgId = bytes32(expected.orgId), root = bytes32(expected.root);
  const input = doc as AllowlistDoc;
  if (!input || input.schema !== ALLOWLIST_SCHEMA || bytes32(input.orgId) !== orgId || bytes32(input.root) !== root) {
    throw new Error('Allowlist schema, org or root mismatch');
  }
  const tree = assertRootMatches(input, root);
  const pending = new Map<string, VerifiedAllowlistLeaf[]>();
  const leaves: VerifiedAllowlistLeaf[] = [];
  for (const [, value] of tree.entries()) {
    const type: EntryType = requireAllowlistUint(value[0]) === '0' ? 'domain' : 'email';
    const id = bytes32(value[1]);
    const hatIds = value[2].map(requireAllowlistUint);
    const leaf = { type, id, hatIds, identifier: '' };
    const key = leafKey(type, id, hatIds);
    pending.set(key, [...(pending.get(key) ?? []), leaf]);
    leaves.push(leaf);
  }
  if (!Array.isArray(input.entries) || input.entries.length !== leaves.length) throw new Error('Allowlist descriptors are incomplete');
  for (const entry of input.entries) {
    if (!entry || !['domain', 'email'].includes(entry.type) || typeof entry.identifier !== 'string'
      || !Array.isArray(entry.hatIds) || !Array.isArray(entry.roleIndexes)
      || entry.roleIndexes.some(i => !Number.isSafeInteger(i) || i < 0)) throw new Error('Invalid allowlist descriptor');
    const hash = entry.type === 'domain' ? entry.domainHash : entry.emailHash;
    if ((entry.type === 'domain' ? entry.emailHash : entry.domainHash) !== undefined) throw new Error('Descriptor hash kind mismatch');
    const id = bytes32(hash);
    const name = norm(entry.identifier);
    if (entry.type === 'domain' || name !== '') {
      if (identifierHash(entry.type, entry.identifier) !== id) throw new Error('Descriptor identifier hash mismatch');
    }
    const key = leafKey(entry.type, id, entry.hatIds.map(requireAllowlistUint));
    const leaf = pending.get(key)?.shift();
    if (!leaf) throw new Error('Descriptor grants do not match a committed leaf');
    // roleIndexes are syntactically checked metadata, not committed role authority. Never project them.
    if (entry.type === 'domain') (leaf as { identifier: string }).identifier = name;
  }
  if (leaves.length === 0 || [...pending.values()].some(rows => rows.length)) throw new Error('Allowlist descriptors are incomplete');
  for (const leaf of leaves) { Object.freeze(leaf.hatIds); Object.freeze(leaf); }
  const result = Object.freeze({ [verifiedBrand]: true as const, orgId, root, leaves: Object.freeze(leaves) });
  verified.add(result);
  return result;
}

/** Frozen leaf authority only. Plaintext email and uncommitted role-index hints are excluded. */
export function projectVerifiedAllowlistLeaves(value: VerifiedAllowlist): readonly VerifiedAllowlistLeaf[] {
  checkVerified(value);
  return value.leaves;
}

export interface BuiltVerifiedAllowlist {
  doc: AllowlistDoc;
  json: string;
  root: string;
  tree: StandardMerkleTree<any[]>;
  verified: VerifiedAllowlist;
}

function buildRows(orgId: string, rows: readonly VerifiedAllowlistLeaf[]): BuiltVerifiedAllowlist {
  if (!rows.length) throw new Error('Allowlist must contain at least one entry');
  const tree = StandardMerkleTree.of(rows.map(r => [r.type === 'domain' ? 0 : 1, r.id, [...r.hatIds]]), [...LEAF_TYPES]);
  const doc: AllowlistDoc = {
    schema: ALLOWLIST_SCHEMA, orgId, root: tree.root, leafTypes: [...LEAF_TYPES],
    entries: rows.map(r => ({
      type: r.type, identifier: r.type === 'domain' ? r.identifier : '',
      [r.type === 'domain' ? 'domainHash' : 'emailHash']: r.id,
      hatIds: r.hatIds.map(h => '0x' + BigInt(h).toString(16)), roleIndexes: [],
    })), treeDump: tree.dump(),
  };
  return { doc, json: JSON.stringify(doc), root: tree.root, tree, verified: verifyAllowlistDocument(doc, { orgId, root: tree.root }) };
}

/** Republish verified leaves with identical commitments, including their exact role order. */
export function buildAllowlistFromVerifiedLeaves(value: VerifiedAllowlist): BuiltVerifiedAllowlist {
  checkVerified(value);
  return buildRows(value.orgId, value.leaves);
}

export interface RetainedAllowlistLeaf {
  /** The actual leaf object projected from current; a copied descriptor is not source authority. */
  leaf: VerifiedAllowlistLeaf;
  /** Omit to preserve exact committed order. Supply to replace grants, sorted canonically. */
  hatIds?: readonly (string | bigint | number)[];
}
export interface ReplaceVerifiedAllowlistArgs {
  orgId: string;
  currentRoot: string;
  current: VerifiedAllowlist;
  /** Whole replacement selection. Omitted old leaves are intentionally removed. */
  retained: readonly RetainedAllowlistLeaf[];
  /** New identities require plaintext; email plaintext is never included in the result. */
  additions?: readonly AllowlistInputEntry[];
}

/** Explicit whole-list edit from a root/org-verified base. No hidden identifier recovery or I/O.
 * Retained leaf handles bind edits to the exact source, including when grants change.
 * Existing duplicate identities are ambiguous here; republish/merge APIs remain compatible. */
export function replaceVerifiedAllowlist(args: ReplaceVerifiedAllowlistArgs): BuiltVerifiedAllowlist {
  checkVerified(args.current);
  const orgId = bytes32(args.orgId), root = bytes32(args.currentRoot);
  if (args.current.orgId !== orgId || args.current.root !== root) throw new Error('Current allowlist scope mismatch');
  if (!Array.isArray(args.retained) || (args.additions !== undefined && !Array.isArray(args.additions))) throw new Error('Invalid allowlist replacement');
  const sourceLeaves = new Set(args.current.leaves), identities = new Set<string>();
  const grants = (values: readonly (string | bigint | number)[], sort: boolean): string[] => {
    if (!Array.isArray(values) || !values.length) throw new Error('Allowlist grants are required');
    const ids = Array.from(values, value => requireAllowlistUint(value));
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate allowlist grant');
    return sort ? ids.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0) : ids;
  };
  const rows: VerifiedAllowlistLeaf[] = [];
  const append = (row: VerifiedAllowlistLeaf) => {
    const key = JSON.stringify([row.type, row.id]);
    if (identities.has(key)) throw new Error('Duplicate allowlist identity');
    identities.add(key);
    rows.push(row);
  };
  for (const selection of args.retained) {
    if (!selection || !sourceLeaves.has(selection.leaf)) throw new Error('Retained leaf is not from the verified source');
    const leaf = selection.leaf;
    append({ ...leaf, hatIds: grants(selection.hatIds === undefined ? leaf.hatIds : selection.hatIds, selection.hatIds !== undefined) });
  }
  for (const entry of args.additions ?? []) {
    if (!entry || !['domain', 'email'].includes(entry.type) || typeof entry.identifier !== 'string'
      || !norm(entry.identifier) || (entry.roleIndexes !== undefined && (!Array.isArray(entry.roleIndexes)
        || Array.from(entry.roleIndexes).some(i => typeof i !== 'number' || !Number.isSafeInteger(i) || i < 0)))) throw new Error('Invalid allowlist addition');
    const id = identifierHash(entry.type, entry.identifier);
    append({ type: entry.type, id, identifier: entry.type === 'domain' ? norm(entry.identifier) : '', hatIds: grants(entry.hatIds, true) });
  }
  return buildRows(orgId, rows);
}

/** Add grants; preserve unrelated old leaves. A positive unreadable root can never become an empty base. */
export function mergeVerifiedAllowlist(args: {
  orgId: string;
  currentRoot: string;
  current?: VerifiedAllowlist | null;
  entries: readonly AllowlistInputEntry[];
}): BuiltVerifiedAllowlist {
  const orgId = bytes32(args.orgId), root = bytes32(args.currentRoot);
  if (root !== zero && !args.current) throw new Error('Current positive allowlist is unavailable');
  if (args.current) {
    checkVerified(args.current);
    if (args.current.orgId !== orgId || args.current.root !== root) throw new Error('Current allowlist scope mismatch');
  }
  const rows = (args.current?.leaves ?? []).map(r => ({ ...r, hatIds: [...r.hatIds] }));
  for (const entry of args.entries) {
    if (!entry || !['domain', 'email'].includes(entry.type) || !Array.isArray(entry.hatIds) || !entry.hatIds.length) {
      throw new Error('Invalid allowlist addition');
    }
    const id = identifierHash(entry.type, entry.identifier);
    const matches = rows.filter(r => r.type === entry.type && r.id === id);
    const hats = [...new Set([...matches.flatMap(r => r.hatIds), ...entry.hatIds.map(requireAllowlistUint)])]
      .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
    // Consolidate only the explicitly edited identity; untouched leaves retain every committed byte.
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].type === entry.type && rows[i].id === id) rows.splice(i, 1);
    rows.push({ type: entry.type, id, hatIds: hats, identifier: entry.type === 'domain' ? norm(entry.identifier) : '' });
  }
  return buildRows(orgId, rows);
}
