/**
 * ZK Email allowlist — build / parse / prove.
 *
 * Port of the frontend's `poa-app/src/lib/zkemail/allowlist.js`. That file names the
 * CLI as an intended caller ("Applied for EVERY caller of buildAllowlist (editor, CLI,
 * forge tooling)"), so this module reproduces it exactly rather than reinventing it.
 *
 * CRITICAL coordination — every one of these is load-bearing, and a mismatch produces a
 * silently UNCLAIMABLE allowlist (fail-closed: no funds at risk, but a broken invite):
 *
 *   - Merkle leaf == `ZkEmailInvites._leaf` == OpenZeppelin StandardMerkleTree over
 *     ['uint8','bytes32','uint256[]'] = [kind, id, hatIds], kind 0=domain, 1=email.
 *     We use @openzeppelin/merkle-tree rather than a hand-rolled tree because the doc
 *     carries a `treeDump` that the frontend reloads with StandardMerkleTree.load().
 *   - domain id = Poseidon(packBytes(ascii-lower(domain), 192)) == the circuit's
 *     `fromDomainHash` signal and the PoaDKIMRegistry key. NOT keccak.
 *   - email id = Poseidon(packBytes(ascii-lower(address), 192)) == PopRoleClaimV2.circom's
 *     `emailHash` public signal.
 *
 * Conformance is pinned by test/lib/zkemail.test.ts, which checks these helpers against the
 * three Poseidon constants and the live allowlist root baked into the contracts repo's
 * script/zkemail/CeremonyDeployTest6Gnosis.s.sol (verified equal to the deployed Gnosis root).
 */

import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { poseidon7 } from 'poseidon-lite';
import { BigNumber, constants as ethersConstants } from 'ethers';
import type { BigNumber as ethersBN } from 'ethers';
import { CliError } from './errors';
import { EXIT } from './exit-codes';

export const ALLOWLIST_SCHEMA = 'poa.zkemail.allowlist/1';
export const LEAF_TYPES = ['uint8', 'bytes32', 'uint256[]'] as const;

/** == EMAX in PopRoleClaimV2.circom */
const EMAIL_PAD = 192;
/** ceil(192 / 31) */
const CHUNKS = 7;

export const LEAF_KIND_DOMAIN = 0;
export const LEAF_KIND_EMAIL = 1;

export type EntryType = 'domain' | 'email';

export interface AllowlistInputEntry {
  type: EntryType;
  identifier: string;
  hatIds: Array<string | bigint | number>;
  roleIndexes?: number[];
}

export interface AllowlistDocEntry {
  type: EntryType;
  identifier: string;
  emailHash?: string;
  domainHash?: string;
  hatIds: string[];
  roleIndexes: number[];
}

export interface AllowlistDoc {
  schema: string;
  orgId: string;
  root: string;
  leafTypes: string[];
  entries: AllowlistDocEntry[];
  treeDump: any;
}

/**
 * ASCII-only lowercase — EXACTLY mirrors the circuit's `ToLower` and the contract's `_lower`,
 * both of which transform only bytes 0x41–0x5A. JS String.prototype.toLowerCase() is
 * Unicode-aware and would additionally lowercase non-ASCII letters, producing a leaf the
 * on-chain path can never reproduce. Trim, then ASCII-lowercase.
 */
export function norm(s: unknown): string {
  return String(s || '')
    .trim()
    .replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * An identifier that isn't pure printable ASCII can never round-trip through the circuit
 * (its From-address regex + PackBytes are ASCII) or the contract, so it would build an
 * unclaimable leaf. Reject at build time so the operator learns immediately, not the claimer later.
 */
export function isPrintableAscii(s: unknown): boolean {
  return /^[\x20-\x7E]+$/.test(String(s));
}

/**
 * Poseidon commitment = Poseidon(packBytes(ascii-lower(s) zero-padded to 192), 7).
 *
 * This is the exact commitment the circuits compute: `emailHash` over the From ADDRESS and
 * `fromDomainHash` over the From DOMAIN. Both allowlist leaf ids use it, and each equals the
 * corresponding on-chain proof signal / DKIM registry key.
 *
 * The 192-byte pad and little-endian 31-byte packing MUST equal EMAX/PackBytes in the circuit.
 *
 * The frontend calls circomlibjs `buildPoseidon()`; we use `poseidon-lite`, which is pure JS
 * (no wasm, no worker threads — circomlibjs logs a worker TypeError to stderr on every call,
 * which would corrupt `--json` output). Equivalence is not assumed: the conformance test pins
 * this against the three production domain hashes and the live on-chain root.
 * The fixed arity-7 entry point also enforces CHUNKS === 7.
 *
 * Synchronous, unlike the frontend's — theirs is async only because circomlibjs needs a wasm
 * build step. The value is what has to match, not the signature.
 */
export function poseidonCommit(str: string): string {
  const bytes = new Uint8Array(EMAIL_PAD);
  bytes.set(new TextEncoder().encode(norm(str)).slice(0, EMAIL_PAD));
  const chunks: bigint[] = [];
  for (let i = 0; i < CHUNKS; i++) {
    let acc = 0n;
    for (let j = 0; j < 31; j++) {
      const idx = 31 * i + j;
      acc += (idx < EMAIL_PAD ? BigInt(bytes[idx]) : 0n) << BigInt(8 * j);
    }
    chunks.push(acc);
  }
  return '0x' + poseidon7(chunks).toString(16).padStart(64, '0');
}

/** domainHash(domain) — domain-leaf id == the circuit's `fromDomainHash` / PoaDKIMRegistry key. */
export function domainHash(domain: string): string {
  return poseidonCommit(domain);
}

/** emailHash(address) — email-leaf id == PopRoleClaimV2.circom's `emailHash` signal. */
export function emailHash(address: string): string {
  return poseidonCommit(address);
}

/** Sort hat IDs ascending as bigints (leaf encoding is order-sensitive). */
function sortHats(hatIds: Array<string | bigint | number>): bigint[] {
  return hatIds.map((h) => BigInt(h)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Build the allowlist JSON + merkle tree.
 *
 * Returns the doc exactly as the frontend writes it, including `treeDump` so a claimant can
 * reload the identical tree without recomputing Poseidon hashes.
 */
export async function buildAllowlist(args: {
  orgId: string;
  entries: AllowlistInputEntry[];
}): Promise<{ doc: AllowlistDoc; json: string; tree: any; root: string }> {
  const { orgId, entries } = args;
  if (!entries || entries.length === 0) {
    throw new CliError('Allowlist must contain at least one entry.', EXIT.USAGE);
  }

  const rows: Array<{ type: EntryType; identifier: string; id: string; hatIds: bigint[]; roleIndexes?: number[] }> = [];
  for (const e of entries) {
    if (e.type !== 'domain' && e.type !== 'email') {
      throw new CliError(`Allowlist entry type must be "domain" or "email", got "${e.type}".`, EXIT.USAGE);
    }
    if (!isPrintableAscii(e.identifier)) {
      throw new CliError(
        `Allowlist identifier "${e.identifier}" contains non-ASCII characters, which can never be `
          + 'matched by an email proof on-chain. Use the plain ASCII domain/email.',
        EXIT.USAGE
      );
    }
    if (e.type === 'email' && !String(e.identifier).includes('@')) {
      throw new CliError(`Email allowlist entry "${e.identifier}" is not an email address.`, EXIT.USAGE);
    }
    if (e.type === 'domain' && String(e.identifier).includes('@')) {
      throw new CliError(
        `Domain allowlist entry "${e.identifier}" looks like an email address — use --type email, `
          + 'or supply just the domain part.',
        EXIT.USAGE
      );
    }
    if (!e.hatIds || e.hatIds.length === 0) {
      throw new CliError(`Allowlist entry "${e.identifier}" grants no hat IDs.`, EXIT.USAGE);
    }
    const hatIds = sortHats(e.hatIds);
    const id = e.type === 'domain' ? domainHash(e.identifier) : emailHash(e.identifier);
    // Store the canonical (trimmed, ASCII-lowercased) identifier — exactly what was hashed
    // into the leaf — so the displayed identifier can never drift from its committed id.
    rows.push({ type: e.type, identifier: norm(e.identifier), id, hatIds, roleIndexes: e.roleIndexes });
  }

  const tree = StandardMerkleTree.of(
    // uint256[] values as decimal strings (BigInt isn't JSON-serializable in the tree dump).
    rows.map((r) => [r.type === 'domain' ? LEAF_KIND_DOMAIN : LEAF_KIND_EMAIL, r.id, r.hatIds.map((h) => h.toString())]),
    LEAF_TYPES as unknown as string[]
  );

  const docEntries: AllowlistDocEntry[] = rows.map((r) => ({
    type: r.type,
    identifier: r.identifier,
    [r.type === 'email' ? 'emailHash' : 'domainHash']: r.id,
    hatIds: r.hatIds.map((h) => '0x' + h.toString(16)),
    roleIndexes: r.roleIndexes || [],
  })) as AllowlistDocEntry[];

  const doc: AllowlistDoc = {
    schema: ALLOWLIST_SCHEMA,
    orgId,
    root: tree.root,
    leafTypes: LEAF_TYPES as unknown as string[],
    entries: docEntries,
    treeDump: tree.dump(),
  };

  return { doc, json: JSON.stringify(doc), tree, root: tree.root };
}

/** Reload the exact tree from a fetched allowlist doc (prefers the dumped tree). */
export function treeFromDoc(doc: any): any {
  if (doc?.treeDump) return StandardMerkleTree.load(doc.treeDump);
  throw new CliError(
    'Allowlist file is missing its merkle tree dump, so proofs cannot be derived from it.',
    EXIT.PRECONDITION
  );
}

/**
 * Recompute the root from a doc and assert it matches `expectedRoot` (anti-swapped-CID guard).
 *
 * `label` names what `expectedRoot` is, because the two call sites mean different things:
 * inspecting an active allowlist compares against the on-chain commit, whereas proposing one
 * compares against a root that is not on-chain yet.
 */
export function assertRootMatches(doc: any, expectedRoot: string, label = 'active on-chain root'): any {
  const tree = treeFromDoc(doc);
  if (String(tree.root).toLowerCase() !== String(expectedRoot).toLowerCase()) {
    throw new CliError(
      `Allowlist file does not match the ${label}.\n`
        + `  file root:     ${tree.root}\n`
        + `  expected root: ${expectedRoot}`,
      EXIT.PRECONDITION
    );
  }
  return tree;
}

/** Merkle proof + hatIds for a DOMAIN entry, or null if the domain is not in the allowlist. */
export function proofForDomain(tree: any, domain: string): { hatIds: string[]; proof: string[] } | null {
  const dh = domainHash(domain).toLowerCase();
  for (const [i, v] of tree.entries()) {
    if (Number(v[0]) === LEAF_KIND_DOMAIN && String(v[1]).toLowerCase() === dh) {
      return { hatIds: v[2].map((h: any) => h.toString()), proof: tree.getProof(i) };
    }
  }
  return null;
}

/** Merkle proof + hatIds for a SPECIFIC-address entry by its emailHash, or null. */
export function proofForEmailHash(tree: any, eHash: string): { hatIds: string[]; proof: string[] } | null {
  const target = String(eHash).toLowerCase();
  for (const [i, v] of tree.entries()) {
    if (Number(v[0]) === LEAF_KIND_EMAIL && String(v[1]).toLowerCase() === target) {
      return { hatIds: v[2].map((h: any) => h.toString()), proof: tree.getProof(i) };
    }
  }
  return null;
}

/** Human-readable summary: which domains + which specific addresses are invited. */
export function summarize(doc: any): { domains: string[]; emails: string[] } {
  const entries = (doc && doc.entries) || [];
  return {
    domains: entries.filter((e: any) => e.type === 'domain').map((e: any) => e.identifier),
    emails: entries.filter((e: any) => e.type === 'email').map((e: any) => e.identifier),
  };
}

/**
 * Parse the CLI's allowlist input format into entries.
 *
 * Accepts either a full allowlist doc (re-publish an existing one) or a bare array, and
 * normalizes `hatIds` from hex strings / decimals / numbers.
 */
export function parseEntriesFile(raw: string, filePath: string): AllowlistInputEntry[] {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new CliError(`${filePath} is not valid JSON: ${e.message}`, EXIT.USAGE);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.entries;
  if (!Array.isArray(list)) {
    throw new CliError(
      `${filePath} must be a JSON array of entries, or an allowlist doc with an "entries" array.`,
      EXIT.USAGE
    );
  }
  return list.map((e: any, i: number) => {
    if (!e || typeof e !== 'object') {
      throw new CliError(`${filePath} entry ${i} is not an object.`, EXIT.USAGE);
    }
    const hatIds = e.hatIds ?? e.hats;
    if (!Array.isArray(hatIds)) {
      throw new CliError(`${filePath} entry ${i} ("${e.identifier}") has no hatIds array.`, EXIT.USAGE);
    }
    return {
      type: e.type,
      identifier: e.identifier,
      hatIds,
      roleIndexes: Array.isArray(e.roleIndexes) ? e.roleIndexes : undefined,
    };
  });
}


/** One indexed DKIM key, as served by the subgraph's DkimKey entity. */
export interface IndexedDkimKey {
  domainHash: string;
  keyHash?: string;
  valid: boolean;
  validUntil: string | number | bigint | null;
}

/**
 * Is any currently-usable DKIM key indexed for `domainLeafId`?
 *
 * Reproduces PoaDKIMRegistry.isKeyHashValid rather than trusting the indexed `valid` flag
 * alone. That flag is the registry's boolean at last-event time and does NOT track a
 * time-bounded expiry lapsing, because no event fires when one does — so a key can be
 * `valid: true` on the index and already rejected on-chain.
 *
 * The sentinels are counter-intuitive and worth stating plainly:
 *   validUntil == 0            -> unset or REVOKED (never "permanent")
 *   validUntil == 2^256 - 1    -> NO_EXPIRY, valid until explicitly revoked
 *   anything else              -> unix cut-off, compare against now
 *
 * 2^256-1 overflows a JS number, so every comparison goes through BigNumber.
 *
 * Returns null when the registry itself is not indexed (e.g. a chain where it is not
 * configured), which must stay distinguishable from "indexed, and this domain has no key".
 */
export function dkimSeededFromIndex(
  registry: { keys?: IndexedDkimKey[] | null } | null | undefined,
  domainLeafId: string,
  nowSeconds?: number
): boolean | null {
  if (!registry) return null;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const target = String(domainLeafId).toLowerCase();
  for (const k of registry.keys ?? []) {
    if (String(k.domainHash).toLowerCase() !== target) continue;
    if (k.valid !== true) continue;
    let until: ethersBN;
    try {
      until = BigNumber.from(String(k.validUntil ?? 0));
    } catch {
      continue;
    }
    if (until.isZero()) continue;
    if (until.eq(ethersConstants.MaxUint256)) return true;
    if (until.gte(now)) return true;
  }
  return false;
}
