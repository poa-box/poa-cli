import { RawUintInput, requireRawUint } from '../amounts';
import { assertPlanScope, assertSourceBlock, Fact, knownFact, PlanScope, requireCompleteSnapshot, SourceSnapshot, unknownFact } from '../data/facts';
import { EXISTS_BIT, INHERIT_GLOBAL_BIT, VALUE_MASK } from '../tx/authority';
import { normalizeSubjectId } from './ids';

export interface AuthoritySubject { subjectId: string; kind: 'Role' | 'Group'; name: string | null }
export interface AuthorityGroupEdge { id: string; groupSubjectId: string; roleSubjectId: string; isActive: boolean }
export interface AuthorityPermissionRow { id: string; subjectId: string; permKey: string; ctx: string; word: string }
export interface AuthorityPermissionData {
  subjects: readonly AuthoritySubject[];
  groupEdges: readonly AuthorityGroupEdge[];
  permissions: readonly AuthorityPermissionRow[];
}
export interface AuthorityMemberFact { subjectId: string; isMember: Fact<boolean> }
export interface DecodedPermissionWord { raw: string; exists: boolean; inheritGlobal: boolean; value: string; enabled: boolean }
export function decodePermissionWord(word: RawUintInput): DecodedPermissionWord {
  const raw = requireRawUint(word);
  const w = BigInt(raw);
  const value = w & BigInt(VALUE_MASK.toString());
  return { raw, exists: (w & BigInt(EXISTS_BIT.toString())) !== 0n, inheritGlobal: (w & BigInt(INHERIT_GLOBAL_BIT.toString())) !== 0n,
    value: value.toString(), enabled: value !== 0n };
}
function bytes32(value: string): string {
  if (!/^0x[\da-f]{64}$/i.test(value)) throw new Error('Invalid bytes32');
  return value.toLowerCase();
}
function tag(key: string): bigint { return BigInt(bytes32(key)) >> 248n; }
function fold(a: bigint, b: bigint, key: string): bigint {
  const t = tag(key);
  return t === 1n ? a | b : t === 2n ? a > b ? a : b : a !== 0n ? a : b;
}
export interface PermissionContextValue { value: string; source: 'global' | 'project' | 'combined'; global: Fact<DecodedPermissionWord>; project: DecodedPermissionWord | null }
/** Null is a PROVEN absent row. Unknown rows must arrive as unknown Facts. */
export function resolvePermissionContext(input: {
  permKey: string; global: Fact<string | null>; project?: Fact<string | null>;
}): Fact<PermissionContextValue> {
  tag(input.permKey);
  const p = input.project;
  if (p?.state === 'unknown') return unknownFact(p.code, p.source);
  const project = p?.state === 'known' && p.value !== null ? decodePermissionWord(p.value) : null;
  // A present, non-inheriting project word makes the global input irrelevant.
  if (project?.exists && !project.inheritGlobal) return knownFact({ value: project.value, source: 'project', global: input.global.state === 'known' ? knownFact(decodePermissionWord(input.global.value ?? '0')) : input.global, project });
  if (input.global.state === 'unknown') return unknownFact(input.global.code, input.global.source);
  const global = decodePermissionWord(input.global.value ?? '0');
  return knownFact({ value: project?.exists ? fold(BigInt(global.value), BigInt(project.value), input.permKey).toString() : global.value,
    source: project?.exists ? 'combined' : 'global', global: knownFact(global), project });
}
export interface PermissionContribution { subjectId: string; name: string | null; kind: 'Role' | 'Group'; context: Fact<PermissionContextValue>; membership: Fact<boolean> }
export interface EffectivePermission {
  permKey: string; ctx: string; value: Fact<string>; enabled: Fact<boolean>;
  contributions: readonly PermissionContribution[];
}
export interface PermissionProjectionInput {
  snapshot: SourceSnapshot<AuthorityPermissionData>; scope: PlanScope; permKey: string; ctx: string;
  /** Exact resolved holder order from the contract's ctx list then its global fallback list.
   * Index ID order or SubjectCreated order is never a substitute (swap/pop mutates these lists). */
  contractOrder?: readonly string[];
}
function validateData(data: AuthorityPermissionData): void {
  const byId = new Map<string, AuthoritySubject>();
  for (const subject of data.subjects) {
    const id = normalizeSubjectId(subject.subjectId);
    if (!['Role', 'Group'].includes(subject.kind) || (typeof subject.name !== 'string' && subject.name !== null) || byId.has(id)) throw new Error('INVALID_SUBJECTS');
    byId.set(id, subject);
  }
  const edgeIds = new Set<string>();
  for (const edge of data.groupEdges) {
    if (!edge.id || edgeIds.has(edge.id) || typeof edge.isActive !== 'boolean'
      || byId.get(normalizeSubjectId(edge.groupSubjectId))?.kind !== 'Group'
      || byId.get(normalizeSubjectId(edge.roleSubjectId))?.kind !== 'Role') throw new Error('INVALID_GROUP_EDGES');
    edgeIds.add(edge.id);
  }
  const slots = new Set<string>();
  for (const row of data.permissions) {
    const id = normalizeSubjectId(row.subjectId);
    const slot = `${id}:${bytes32(row.permKey)}:${bytes32(row.ctx)}`;
    if (!byId.has(id) || slots.has(slot)) throw new Error('INVALID_PERMISSION_ROWS');
    slots.add(slot); decodePermissionWord(row.word);
  }
}
/** Groups derive from active composition and current ROLE facts, never group acceptance. */
export function projectSubjectMembership(data: AuthorityPermissionData, subjectId: string, memberships: readonly AuthorityMemberFact[]): Fact<boolean> {
  try {
    validateData(data);
    if (new Set(memberships.map(m => normalizeSubjectId(m.subjectId))).size !== memberships.length) return unknownFact('DUPLICATE_MEMBERSHIP');
    return deriveMembership(data, subjectId, memberships);
  } catch { return unknownFact('INVALID_MEMBERSHIP_INPUT'); }
}
function deriveMembership(data: AuthorityPermissionData, subjectId: string, memberships: readonly AuthorityMemberFact[]): Fact<boolean> {
  const id = normalizeSubjectId(subjectId);
  const subject = data.subjects.find(s => normalizeSubjectId(s.subjectId) === id);
  if (!subject) return unknownFact('MISSING_SUBJECT');
  if (subject.kind === 'Role') {
    const fact = memberships.find(m => normalizeSubjectId(m.subjectId) === id)?.isMember;
    return fact && (fact.state === 'unknown' || (fact.state === 'known' && typeof fact.value === 'boolean')) ? fact : unknownFact('MISSING_MEMBERSHIP');
  }
  const roles = data.groupEdges.filter(e => normalizeSubjectId(e.groupSubjectId) === id && e.isActive);
  const facts = roles.map(e => deriveMembership(data, e.roleSubjectId, memberships));
  if (facts.some(f => f.state === 'known' && f.value)) return knownFact(true);
  if (facts.some(f => f.state === 'unknown')) return unknownFact('GROUP_MEMBERSHIP_UNRESOLVED');
  return knownFact(false);
}
function project(input: PermissionProjectionInput, select: (data: AuthorityPermissionData) => readonly { subject: AuthoritySubject; membership: Fact<boolean> }[]): EffectivePermission {
  const permKey = bytes32(input.permKey), ctx = bytes32(input.ctx);
  let contributions: PermissionContribution[] = [];
  const fail = (code: string): EffectivePermission => ({ permKey, ctx, value: unknownFact(code, input.snapshot.source), enabled: unknownFact(code, input.snapshot.source), contributions });
  try {
    if (!input.scope.orgId || !input.scope.contract) return fail('AUTHORITY_SCOPE_REQUIRED');
    const data = requireCompleteSnapshot(input.snapshot, { scope: { ...input.scope, account: undefined } });
    validateData(data);
    contributions = select(data).map(({ subject, membership }) => {
      const rows = data.permissions.filter(r => normalizeSubjectId(r.subjectId) === normalizeSubjectId(subject.subjectId) && bytes32(r.permKey) === permKey);
      const g = rows.find(r => BigInt(r.ctx) === 0n);
      const p = BigInt(ctx) === 0n ? undefined : rows.find(r => bytes32(r.ctx) === ctx);
      return { subjectId: normalizeSubjectId(subject.subjectId), name: subject.name, kind: subject.kind, membership,
        context: resolvePermissionContext({ permKey, global: knownFact(g?.word ?? null), ...(BigInt(ctx) === 0n ? {} : { project: knownFact(p?.word ?? null) }) }) };
    });
    const relevant = contributions.filter(c => (c.membership.state !== 'known' || c.membership.value)
      && (c.context.state !== 'known' || c.context.value.value !== '0'));
    if (relevant.some(c => c.membership.state === 'unknown' || c.context.state === 'unknown')) return fail('PERMISSION_INPUT_UNRESOLVED');
    const values = relevant.map(c => BigInt((c.context as { state: 'known'; value: PermissionContextValue }).value.value));
    const enabled = knownFact(values.some(v => v !== 0n), input.snapshot.source);
    let value: Fact<string>;
    if (tag(permKey) === 1n || tag(permKey) === 2n) value = knownFact(values.reduce((a, b) => fold(a, b, permKey), 0n).toString(), input.snapshot.source);
    else if (new Set(values.filter(v => v !== 0n).map(String)).size <= 1) value = knownFact((values.find(v => v !== 0n) ?? 0n).toString(), input.snapshot.source);
    else if (input.contractOrder) {
      const order = input.contractOrder.map(normalizeSubjectId);
      if (new Set(order).size !== order.length || relevant.some(c => !order.includes(c.subjectId))) return fail('INVALID_CONTRACT_ORDER');
      const sorted = [...relevant].sort((a, b) => order.indexOf(a.subjectId) - order.indexOf(b.subjectId));
      value = knownFact(sorted.reduce((a, c) => fold(a, BigInt((c.context as { state: 'known'; value: PermissionContextValue }).value.value), permKey), 0n).toString(), input.snapshot.source);
    } else value = unknownFact('CONTRACT_FOLD_ORDER_UNAVAILABLE', input.snapshot.source);
    return { permKey, ctx, value, enabled, contributions };
  } catch { return fail('INVALID_PERMISSION_SNAPSHOT'); }
}
/** Potential effective permissions of a subject: its own row plus active containing groups. */
export function projectEffectiveSubjectPermissions(input: PermissionProjectionInput & { subjectId: string }): EffectivePermission {
  return project(input, data => {
    const id = normalizeSubjectId(input.subjectId);
    const subject = data.subjects.find(s => normalizeSubjectId(s.subjectId) === id);
    if (!subject) throw new Error('MISSING_SUBJECT');
    const groupIds = subject.kind === 'Role' ? data.groupEdges.filter(e => e.isActive && normalizeSubjectId(e.roleSubjectId) === id).map(e => normalizeSubjectId(e.groupSubjectId)) : [];
    return data.subjects.filter(s => normalizeSubjectId(s.subjectId) === id || groupIds.includes(normalizeSubjectId(s.subjectId))).map(subject => ({ subject, membership: knownFact(true) }));
  });
}
export function projectUserPermissions(input: PermissionProjectionInput & { memberships: SourceSnapshot<readonly AuthorityMemberFact[]> }): EffectivePermission {
  return project(input, data => {
    const memberships = requireCompleteSnapshot(input.memberships, { scope: input.scope, ...(input.snapshot.source.block ? { block: input.snapshot.source.block } : {}) });
    if (!input.scope.account) throw new Error('ACCOUNT_SCOPE_REQUIRED');
    for (const m of memberships) if (m.isMember.source) {
      assertPlanScope(m.isMember.source, { chainId: input.scope.chainId, orgId: input.scope.orgId, contract: input.scope.contract, account: input.scope.account });
      if (input.memberships.source.block) assertSourceBlock(m.isMember.source.block, input.memberships.source.block);
    }
    if (new Set(memberships.map(m => normalizeSubjectId(m.subjectId))).size !== memberships.length) throw new Error('DUPLICATE_MEMBERSHIP');
    // Ignore subjects with no row at either applicable context, whose value is proven zero.
    return data.subjects.filter(s => data.permissions.some(r => normalizeSubjectId(r.subjectId) === normalizeSubjectId(s.subjectId)
      && bytes32(r.permKey) === bytes32(input.permKey) && (BigInt(r.ctx) === 0n || bytes32(r.ctx) === bytes32(input.ctx))))
      .map(subject => ({ subject, membership: deriveMembership(data, subject.subjectId, memberships) }));
  });
}
