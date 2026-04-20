import { describe, it, expect } from 'vitest';
import { resolveIdeaId } from '../../src/commands/brain/brainstorm';

describe('resolveIdeaId — Task #492 retro-509 change-1 idea-ID resolution', () => {
  const storedIds = [
    'smart-account-implementation-registry-sair-sentinel-hb-857-s-1776704707',
    'l2-governance-corpus-extension-sentinel-hb-857-extend-audit--1776704717',
    'variant-check-batch-integration-vigil-hb-495-merge-governanc-1776705231',
    'brain-lesson-propagation-validation-vigil-hb-495-hb-490-less-1776705240',
    'predecessor-task-pattern-tooling-vigil-hb-495-hb-493-494-shi-1776705250',
  ];

  it('returns exact-match result for full stored id', () => {
    const r = resolveIdeaId(storedIds[0], storedIds);
    expect(r).toEqual({ id: storedIds[0], reason: 'exact' });
  });

  it('returns unique-prefix match for voter-typed prefix', () => {
    const r = resolveIdeaId('smart-account-implementation', storedIds);
    expect(r).toEqual({ id: storedIds[0], reason: 'prefix' });
  });

  it('returns unique-prefix match for slug-only prefix (without timestamp)', () => {
    const r = resolveIdeaId('l2-governance-corpus-extension', storedIds);
    expect(r).toEqual({ id: storedIds[1], reason: 'prefix' });
  });

  it('returns unique-substring match when prefix fails but substring is unique', () => {
    // "merge-governanc" is only in idea #3
    const r = resolveIdeaId('merge-governanc', storedIds);
    expect(r).toEqual({ id: storedIds[2], reason: 'prefix' });
  });

  it('returns null when no match exists', () => {
    const r = resolveIdeaId('completely-unknown-idea-id', storedIds);
    expect(r).toBeNull();
  });

  it('returns null when prefix matches multiple ideas (ambiguous)', () => {
    const shared = ['foo-bar-sentinel-hb-100-1000', 'foo-bar-sentinel-hb-200-2000'];
    const r = resolveIdeaId('foo-bar', shared);
    expect(r).toBeNull();
  });

  it('returns null when supplied is empty string', () => {
    // Empty string would prefix-match all ideas (ambiguous) → null
    const r = resolveIdeaId('', storedIds);
    expect(r).toBeNull();
  });

  it('handles storedIds empty list gracefully', () => {
    const r = resolveIdeaId('anything', []);
    expect(r).toBeNull();
  });

  it('preserves exact-match priority over prefix ambiguity', () => {
    // "foo" exact matches "foo"; should return exact even though "foo-bar-1" and "foo-bar-2" both prefix-match "foo"
    const ids = ['foo', 'foo-bar-1', 'foo-bar-2'];
    const r = resolveIdeaId('foo', ids);
    expect(r).toEqual({ id: 'foo', reason: 'exact' });
  });

  it('case-sensitive match (stored ids are already lowercased by slugify)', () => {
    const r = resolveIdeaId('SMART-ACCOUNT', storedIds);
    // Case-sensitive — uppercase doesn't prefix-match the lowercase stored id
    expect(r).toBeNull();
  });
});
