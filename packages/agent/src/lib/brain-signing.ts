/**
 * Brain-layer change signing — ECDSA over snapshot bytes.
 *
 * Each brain CRDT change gets wrapped in a signed envelope before being
 * written to the blockstore. The envelope's sig authenticates the full
 * Automerge snapshot against an Ethereum address derived from the
 * existing POP_PRIVATE_KEY. No Nostr keys, no Schnorr, no second PKI.
 *
 * Envelope format (v1):
 *
 *     {
 *       v: 1,
 *       author: "0xABCD...",        // Ethereum address (lowercase)
 *       timestamp: 1776200000,      // unix seconds
 *       automerge: "0xDEADBEEF",    // full Automerge.save() bytes, hex
 *       sig: "0xABC..."             // ECDSA over keccak256(author|ts|automerge)
 *     }
 *
 * Serialized as UTF-8 JSON, stored as a raw-codec IPLD block. The CID
 * covers the whole envelope, so the sig is content-addressed alongside
 * the data it authenticates.
 *
 * On read, the projection layer:
 *   1. Unmarshal the envelope JSON
 *   2. Verify the sig recovers to `author`
 *   3. Check `author` against the allowlist at
 *      agent/brain/Config/brain-allowlist.json
 *   4. If all OK, extract the Automerge bytes and merge
 *
 * Sync layer stays permissionless — any peer can gossip any CID. Auth
 * happens at read time so the network is resilient against relay
 * operators (there are none, but the principle stands for any future
 * transport).
 */

import { ethers } from 'ethers';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface BrainChangeEnvelope {
  v: 1;
  author: string;         // 0x-prefixed lowercase Ethereum address
  timestamp: number;      // unix seconds
  automerge: string;      // 0x-prefixed hex of the Automerge.save() bytes
  sig: string;            // 0x-prefixed ECDSA sig
}

/**
 * Canonical message that gets signed. Kept deterministic and simple —
 * just concatenate the fields in a fixed order, hash, sign. Changing
 * this format is a breaking change; bump the version when it happens.
 */
function canonicalMessage(author: string, timestamp: number, automergeHex: string): string {
  return [
    'pop-brain-change/v1',
    author.toLowerCase(),
    String(timestamp),
    automergeHex.toLowerCase(),
  ].join('|');
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

/**
 * Sign an Automerge snapshot with the wallet derived from POP_PRIVATE_KEY.
 * Returns a v1 envelope ready to be JSON-encoded and written as a block.
 */
export async function signBrainChange(
  automergeBytes: Uint8Array,
  privateKey?: string,
): Promise<BrainChangeEnvelope> {
  const key = privateKey || process.env.POP_PRIVATE_KEY;
  if (!key) {
    throw new Error('No private key for brain signing (set POP_PRIVATE_KEY)');
  }

  const wallet = new ethers.Wallet(key);
  const author = wallet.address.toLowerCase();
  const timestamp = Math.floor(Date.now() / 1000);
  const automergeHex = bytesToHex(automergeBytes);

  const message = canonicalMessage(author, timestamp, automergeHex);
  // signMessage applies the standard EIP-191 personal_sign prefix,
  // so verification uses verifyMessage (not recoverAddress on a raw hash).
  const sig = await wallet.signMessage(message);

  return {
    v: 1,
    author,
    timestamp,
    automerge: automergeHex,
    sig,
  };
}

/**
 * Verify an envelope's signature and return the recovered author.
 * Throws if the envelope is malformed or the signature doesn't verify.
 *
 * NOTE: this only checks authenticity (sig corresponds to `author`);
 * it does NOT check authorization (whether `author` is allowed to
 * write to this doc). That's the allowlist check — see isAllowedAuthor.
 */
export function verifyBrainChange(envelope: BrainChangeEnvelope): string {
  if (envelope.v !== 1) {
    throw new Error(`Unsupported brain envelope version: ${envelope.v}`);
  }
  if (!envelope.author || !envelope.timestamp || !envelope.automerge || !envelope.sig) {
    throw new Error('Malformed brain envelope: missing required field');
  }
  const message = canonicalMessage(envelope.author, envelope.timestamp, envelope.automerge);
  const recovered = ethers.utils.verifyMessage(message, envelope.sig).toLowerCase();
  if (recovered !== envelope.author.toLowerCase()) {
    throw new Error(`Brain envelope signature mismatch: expected ${envelope.author}, recovered ${recovered}`);
  }
  return recovered;
}

/**
 * Extract the Automerge snapshot bytes from an envelope.
 * Does NOT verify the signature — caller must run verifyBrainChange first.
 */
export function unwrapAutomergeBytes(envelope: BrainChangeEnvelope): Uint8Array {
  return hexToBytes(envelope.automerge);
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export interface AllowlistEntry {
  address: string;    // 0x-prefixed, case-insensitive on load
  name?: string;      // human label
  addedAt?: string;   // ISO date
  addedBy?: string;   // human note
}

/**
 * Path to the git-tracked brain-allowlist.json. Single source of truth
 * for who is permitted to write to brain docs. Edited via governance
 * (or via `pop brain allowlist add/remove`, which writes to the same
 * file and leaves the git review gate in place).
 *
 * Exported so command handlers can write to the same path without
 * hard-coding it independently.
 */
export function getAllowlistPath(): string {
  return join(process.cwd(), 'agent', 'brain', 'Config', 'brain-allowlist.json');
}

export function loadAllowlist(): AllowlistEntry[] {
  const p = getAllowlistPath();
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    // Accept either a list or an { entries: [...] } wrapper for future flex.
    const list: any[] = Array.isArray(raw) ? raw : raw.entries || [];
    return list.map(e => ({
      address: String(e.address).toLowerCase(),
      name: e.name,
      addedAt: e.addedAt,
      addedBy: e.addedBy,
    }));
  } catch {
    return [];
  }
}

/**
 * Check whether a given address is in the allowlist.
 * Case-insensitive on the address.
 */
export function isAllowedAuthor(address: string): boolean {
  const needle = address.toLowerCase();
  const list = loadAllowlist();
  return list.some(e => e.address === needle);
}

/**
 * Combined auth check: verify signature + allowlist membership.
 * Returns the authenticated author on success; throws otherwise.
 */
export function authenticateAndAuthorize(envelope: BrainChangeEnvelope): string {
  const author = verifyBrainChange(envelope);
  if (!isAllowedAuthor(author)) {
    throw new Error(`Brain change rejected: author ${author} not in allowlist`);
  }
  return author;
}

// ---------------------------------------------------------------------------
// Dynamic allowlist (task #330 — HB#312 Hudson directive)
//
// The async `isAuthorizedAuthor` replaces the static `isAllowedAuthor` for
// network-connected verify paths. It checks the on-chain org member set
// FIRST (via src/lib/brain-membership.ts — cached 5 min), and falls back
// to the static JSON allowlist on any subgraph error. That way:
//
//   - A freshly-vouched agent is trusted on their first brain write
//     without anyone editing brain-allowlist.json by hand
//   - Offline / fresh-clone / air-gapped agents still work, via the
//     static fallback
//   - Emergency manual trust for keys outside the DAO still works,
//     via the static JSON
//
// Sync callers that can't easily be made async (like pop brain doctor's
// quick health check) keep using `isAllowedAuthor` — that's a
// best-effort preview, not the canonical auth.
// ---------------------------------------------------------------------------

export type AuthorizationMode = 'dynamic' | 'static-fallback' | 'both-agree';

export interface AuthorizationResult {
  allowed: boolean;
  mode: AuthorizationMode;
  /** Populated only when fallback fired. Empty string otherwise. */
  fallbackReason: string;
}

/**
 * Async authorization check: on-chain org membership first, static
 * JSON allowlist second. Does NOT throw — returns a result object the
 * caller can inspect for logging purposes. Callers then decide whether
 * to reject the change or accept it based on `.allowed`.
 *
 * This is the new canonical authorization for brain read paths.
 */
export async function isAuthorizedAuthor(
  address: string,
): Promise<AuthorizationResult> {
  const addr = address.toLowerCase();
  // Lazy import to keep brain-signing.ts free of subgraph / helia deps
  // for the pure-function sign/verify side. The read-path verify that
  // calls this runs in an async context that already pulls in brain.ts.
  const { isOrgMember } = await import('./brain-membership');
  try {
    const onChain = await isOrgMember(addr);
    if (onChain) {
      // Also a static match? Just informational — both-agree is the
      // healthy steady state for genesis agents.
      const staticMatch = isAllowedAuthor(addr);
      return {
        allowed: true,
        mode: staticMatch ? 'both-agree' : 'dynamic',
        fallbackReason: '',
      };
    }
    // Not a member. Still honor the static JSON for emergency overrides.
    if (isAllowedAuthor(addr)) {
      return {
        allowed: true,
        mode: 'static-fallback',
        fallbackReason:
          'not an active org member but present in static brain-allowlist.json (emergency override)',
      };
    }
    return {
      allowed: false,
      mode: 'dynamic',
      fallbackReason: 'not an active org member and not in static allowlist',
    };
  } catch (err: any) {
    // Subgraph unreachable → fall back to static JSON.
    const staticMatch = isAllowedAuthor(addr);
    return {
      allowed: staticMatch,
      mode: 'static-fallback',
      fallbackReason: `dynamic allowlist unreachable (${err?.message ?? 'unknown error'}), using static fallback`,
    };
  }
}
