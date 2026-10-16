/** Pure current-circuit recipes. DKIM validation and proving remain injected host operations. */
import { domainHash, emailHash, isPrintableAscii, norm, requireAllowlistUint } from '../zkemail';

export type EmailCircuitVersion = 'v1' | 'v2';
export const EMAIL_CIRCUIT_RECIPES = Object.freeze({
  v1: Object.freeze({ version: 'v1', circuit: 'PopRoleClaim', kind: 'domain', maxHeadersLength: 1024, fromWindow: 256,
    identifierBytes: 192, rsaChunkBits: 121, rsaChunks: 17, ignoreBodyHashCheck: true,
    publicSignals: Object.freeze(['pubkeyHash', 'emailNullifier', 'claimerAddress', 'fromDomainHash']) }),
  v2: Object.freeze({ version: 'v2', circuit: 'PopRoleClaimV2', kind: 'email', maxHeadersLength: 1024, fromWindow: 256,
    identifierBytes: 192, rsaChunkBits: 121, rsaChunks: 17, ignoreBodyHashCheck: true,
    publicSignals: Object.freeze(['pubkeyHash', 'emailNullifier', 'claimerAddress', 'emailHash', 'fromDomainHash']) }),
});
// Literal fields from the generated verifier, not uint256 bounds.
export const EMAIL_SCALAR_FIELD = '21888242871839275222246405745257275088548364400416034343698204186575808495617';
export const EMAIL_BASE_FIELD = '21888242871839275222246405745257275088696311157297823662689037894645226208583';
const prefix = 'Claim POP role for 0x';

function recipe(version: EmailCircuitVersion) {
  if (version !== 'v1' && version !== 'v2') throw new Error('Unsupported email circuit recipe');
  return EMAIL_CIRCUIT_RECIPES[version];
}
export function requireEmailClaimer(value: string): string {
  if (typeof value !== 'string' || !/^0x[\da-f]{40}$/i.test(value) || BigInt(value) === 0n) throw new Error('Invalid email claimer');
  return value.toLowerCase();
}
export function buildEmailClaimCommand(claimer: string): string {
  requireEmailClaimer(claimer);
  // The circuit prefix is literal lowercase "0x"; address digits may retain checksum case.
  return `Claim POP role for 0x${claimer.slice(2)}`;
}

export interface CircuitInputHints {
  commandIndex: string;
  fromWindowIndex: string;
  emailIndexInWindow: string;
  atIndex: string;
  fromEmail: string;
  fromDomain: string;
  /** Signing provider can differ; registry identity is the proven From domain. */
  dkimDomain: string;
  emailHash: string;
  fromDomainHash: string;
}

/** Locate hints only inside injected DKIM-derived signed bytes; never fetch/parse an inbox. */
export function buildCircuitInputHints(args: {
  version: EmailCircuitVersion;
  emailHeader: Uint8Array | readonly (string | number)[];
  /** Exclude SHA/zero padding when the supplied buffer is padded. */
  signedHeaderLength?: number;
  fromEmail: string;
  dkimDomain: string;
  claimer: string;
}): CircuitInputHints {
  const r = recipe(args.version), claimer = requireEmailClaimer(args.claimer);
  if (!(args.emailHeader instanceof Uint8Array) && !Array.isArray(args.emailHeader)) throw new Error('Invalid signed header bytes');
  const bytes = Array.from(args.emailHeader, value => Number(requireAllowlistUint(value)));
  if (bytes.length > r.maxHeadersLength || !bytes.length || bytes.some(b => b > 255)) throw new Error('Signed header exceeds 1024 bytes or contains invalid bytes');
  const length = args.signedHeaderLength ?? bytes.length;
  if (!Number.isSafeInteger(length) || length <= 0 || length > bytes.length) throw new Error('Invalid signed header length');
  const header = String.fromCharCode(...bytes.slice(0, length));
  const start = header.indexOf(prefix);
  if (start < 0 || header.indexOf(prefix, start + prefix.length) >= 0) throw new Error('Signed header requires one exact bound claim command');
  const command = header.slice(start, start + prefix.length + 40);
  if (!/^Claim POP role for 0x[\da-fA-F]{40}$/.test(command)
    || /[\da-fA-F]/.test(header[start + prefix.length + 40] ?? '')
    || command.slice('Claim POP role for '.length).toLowerCase() !== claimer) throw new Error('Signed command claimer mismatch or malformed command');
  // FromAddrRegex anchors to CRLF/BOF and lowercase canonical field name.
  const fields = [...header.matchAll(/(?:^|\r\n)from:([^\r\n]*)/g)];
  if (fields.length !== 1) throw new Error('Signed header requires one canonical From field');
  const field = fields[0];
  const fromWindowIndex = field.index!;
  if (fromWindowIndex + r.fromWindow > r.maxHeadersLength) throw new Error('From window exceeds circuit header buffer');
  const fromEmail = args.fromEmail;
  if (!isPrintableAscii(fromEmail) || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(fromEmail)) throw new Error('Invalid From email address');
  const atIndex = fromEmail.indexOf('@');
  // Restrict the address match to the From field, never a later To or message-id field.
  const fieldStart = fromWindowIndex + field[0].indexOf('from:') + 5;
  const emailIndex = header.indexOf(fromEmail, fieldStart);
  const fieldEnd = fromWindowIndex + field[0].length;
  if (emailIndex < fieldStart || emailIndex + fromEmail.length > fieldEnd
    || emailIndex + fromEmail.length > fromWindowIndex + r.fromWindow) throw new Error('From address is outside the 256-byte signed From window');
  const dkimDomain = norm(args.dkimDomain);
  if (!isPrintableAscii(dkimDomain) || !/^[a-z0-9.-]+$/.test(dkimDomain)) throw new Error('Invalid DKIM signing domain');
  const fromDomain = norm(fromEmail.slice(atIndex + 1));
  return { commandIndex: String(start), fromWindowIndex: String(fromWindowIndex),
    emailIndexInWindow: String(emailIndex - fromWindowIndex), atIndex: String(atIndex),
    fromEmail: norm(fromEmail), fromDomain, dkimDomain, emailHash: emailHash(fromEmail), fromDomainHash: domainHash(fromDomain) };
}

export interface ZkEmailProof {
  readonly pA: readonly [string, string];
  readonly pB: readonly [readonly [string, string], readonly [string, string]];
  readonly pC: readonly [string, string];
  readonly pubkeyHash: string;
  readonly emailNullifier: string;
  readonly fromDomainHash: string;
}
export interface ZkEmailProofV2 extends ZkEmailProof { readonly emailHash: string }
export interface Groth16ProofInput {
  pi_a: readonly (string | number | bigint)[];
  pi_b: readonly (readonly (string | number | bigint)[])[];
  pi_c: readonly (string | number | bigint)[];
  protocol?: string;
  curve?: string;
}
const projectionBrand: unique symbol = Symbol('EmailProofProjection');
const projections = new WeakSet<object>();
export interface EmailProofProjection<V extends EmailCircuitVersion = EmailCircuitVersion> {
  readonly [projectionBrand]: true;
  readonly version: V;
  readonly claimer: string;
  readonly proof: V extends 'v2' ? ZkEmailProofV2 : ZkEmailProof;
}
function field(value: string | number | bigint, modulus: string): bigint {
  const result = BigInt(requireAllowlistUint(value));
  if (result >= BigInt(modulus)) throw new Error('Email proof value exceeds field');
  return result;
}

/** Validate representation/binding only. This does not verify the cryptographic proof. */
export function projectGroth16Proof<V extends EmailCircuitVersion>(args: {
  version: V;
  proof: Groth16ProofInput;
  publicSignals: readonly (string | number | bigint)[];
  claimer: string;
}): EmailProofProjection<V> {
  const r = recipe(args.version), claimer = requireEmailClaimer(args.claimer), p = args.proof;
  if (!p || (p.protocol !== undefined && p.protocol !== 'groth16') || (p.curve !== undefined && p.curve !== 'bn128')
    || !Array.isArray(p.pi_a) || p.pi_a.length !== 3 || !Array.isArray(p.pi_c) || p.pi_c.length !== 3
    || !Array.isArray(p.pi_b) || p.pi_b.length !== 3 || p.pi_b.some(row => !Array.isArray(row) || row.length !== 2)
    || !Array.isArray(args.publicSignals) || args.publicSignals.length !== r.publicSignals.length) throw new Error('Malformed Groth16 proof or circuit signals');
  const a = p.pi_a.map(v => field(v, EMAIL_BASE_FIELD)), b = p.pi_b.map(row => row.map((v: string | number | bigint) => field(v, EMAIL_BASE_FIELD)));
  const c = p.pi_c.map(v => field(v, EMAIL_BASE_FIELD)), s = args.publicSignals.map(v => field(v, EMAIL_SCALAR_FIELD));
  if (a[2] !== 1n || c[2] !== 1n || b[2][0] !== 1n || b[2][1] !== 0n) throw new Error('Unsupported projective proof coordinates');
  if (s[2] !== BigInt(claimer)) throw new Error('Email proof is bound to a different claimer');
  const uint = (v: bigint) => '0x' + v.toString(16);
  const b32 = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
  const pair = (x: bigint, y: bigint): readonly [string, string] => Object.freeze([uint(x), uint(y)]);
  const proof = Object.freeze({ pA: pair(a[0], a[1]), pB: Object.freeze([pair(b[0][1], b[0][0]), pair(b[1][1], b[1][0])]),
    pC: pair(c[0], c[1]), pubkeyHash: b32(s[0]), emailNullifier: b32(s[1]),
    ...(args.version === 'v2' ? { emailHash: b32(s[3]) } : {}), fromDomainHash: b32(s[args.version === 'v2' ? 4 : 3]) });
  const result = Object.freeze({ [projectionBrand]: true as const, version: args.version, claimer, proof }) as unknown as EmailProofProjection<V>;
  projections.add(result);
  return result;
}

/** Transaction codecs must recheck identity at the host's final execution boundary. */
export function requireEmailProofProjection<V extends EmailCircuitVersion>(value: EmailProofProjection<V>, version: V, claimer: string): void {
  if (!value || !projections.has(value) || value.version !== version || value.claimer !== requireEmailClaimer(claimer)) {
    throw new Error('Email proof recipe or claimer mismatch');
  }
}
