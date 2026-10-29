import { ethers } from 'ethers';
import { requireRawUint } from '@poa-box/core/amounts';
import { assertPlanScope, assertSourceBlock, Fact, PlanScope, requireCompleteSnapshot, SourceSnapshot } from '@poa-box/core/data/facts';
import type { WorkflowScope, WorkflowSources } from './types';

/** RawUintInput accepts bigint. Normalize it before JSON journaling or review
 * binding; no amount, salt, nonce or opaque ID passes through Number. */
export function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? requireRawUint(item) : item)); }
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): unknown {
  if (typeof value === 'bigint') return requireRawUint(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
export const digest = (value: unknown): string => ethers.utils.id(JSON.stringify(canonical(value)));
/** Keep semantic protocol data in review bindings; advancing an observation
 * block alone does not invalidate unchanged decisions. */
export function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'source').map(([key, item]) => [key, semantic(item)]));
  return value;
}
export function refuse(code: string, state: 'blocked' | 'unknown' = 'blocked'): never {
  throw Object.assign(new Error(code), { workflowState: state });
}
export function nonzero(value: string): string {
  const address = ethers.utils.getAddress(value);
  if (address === ethers.constants.AddressZero) refuse('NONZERO_MODULE_REQUIRED');
  return address;
}
export function moduleScope(scope: WorkflowScope, contract: string, account = false): PlanScope {
  return { ...scope, contract: nonzero(contract), ...(account ? {} : { account: undefined }) };
}
/** Every input is pinned to a canonical block hash and an explicitly selected
 * endpoint. No indexed snapshot is silently treated as a live RPC preflight. */
export function snapshot<T>(value: SourceSnapshot<T>, scope: PlanScope, sources: WorkflowSources,
  indexed: boolean, sameBlock?: SourceSnapshot<unknown>): T {
  const endpoint = indexed ? sources.indexedEndpoint : sources.rpcEndpoint;
  const data = requireCompleteSnapshot(value, { scope: { ...scope, endpoint }, indexed, snapshot: 'pinned',
    ...(sameBlock ? { block: sameBlock.source.block! } : {}) });
  const now = sources.now(), maxAge = sources.maxAgeSeconds ?? 30;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxAge) || maxAge < 0 || maxAge > 300
    || !value.source.block?.hash || value.source.observedAt === undefined || value.source.observedAt > now
    || now - value.source.observedAt > maxAge || value.source.block.timestamp === undefined
    || BigInt(value.source.block.timestamp) > BigInt(now)
    || BigInt(now) - BigInt(value.source.block.timestamp) > BigInt(maxAge)) refuse('EVIDENCE_STALE', 'unknown');
  return data;
}
export function known<T>(fact: Fact<T>, observation: SourceSnapshot<unknown>, scope: PlanScope): T {
  if (!fact || !['known', 'unknown'].includes(fact.state)) refuse('INVALID_PROTOCOL_FACT', 'unknown');
  if (fact.source) {
    assertPlanScope(fact.source, { ...scope, endpoint: observation.source.endpoint });
    assertSourceBlock(fact.source.block, observation.source.block!);
    if (fact.source.indexed !== observation.source.indexed || fact.source.snapshot !== 'pinned') refuse('FACT_SOURCE_MISMATCH', 'unknown');
  }
  if (fact.state === 'unknown') refuse(fact.code, 'unknown');
  return fact.value;
}
export function allowed(fact: Fact<boolean>): void {
  if (fact.state === 'unknown') refuse(fact.code, 'unknown');
  if (fact.value !== true) refuse('CURRENT_AUTHORIZATION_DENIED');
}
