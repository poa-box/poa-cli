import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseSubscriptionsFile, validateFilter, saveSubscriptions, loadSubscriptions } from '../../src/lib/subscriptions';

/**
 * Task #513 (HB#596 vigil_01) — schema validator for per-agent subscriptions.json.
 * Question-independent layer: parsing + validation are decoupled from the open
 * peer-poll questions Q1-Q4 (priority key, write-back atomicity, cache, match-window).
 */
describe('parseSubscriptionsFile — Task #513 schema', () => {
  it('rejects invalid JSON', () => {
    const { result, file } = parseSubscriptionsFile('not json');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/invalid JSON/);
    expect(file).toBeNull();
  });

  it('rejects non-object top-level', () => {
    const { result } = parseSubscriptionsFile('[]');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/top-level must be an object/);
  });

  it('rejects unsupported version', () => {
    const { result } = parseSubscriptionsFile('{"version":2,"subscriptions":[]}');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/unsupported version/);
  });

  it('accepts empty subscriptions array', () => {
    const { result, file } = parseSubscriptionsFile('{"version":1,"subscriptions":[]}');
    expect(result.ok).toBe(true);
    expect(file?.subscriptions).toEqual([]);
  });

  it('accepts a minimal valid subscription with author filter', () => {
    const raw = JSON.stringify({
      version: 1,
      subscriptions: [
        {
          id: 'vigil-watch-argus',
          docId: 'pop.brain.shared',
          filter: { author: '0x451563aB9b5b4E8DfaA602f5e7890089EDF6bf10' },
        },
      ],
    });
    const { result, file } = parseSubscriptionsFile(raw);
    expect(result.ok).toBe(true);
    expect(file?.subscriptions).toHaveLength(1);
    // address is normalized to lowercase
    expect(file?.subscriptions[0].filter.author).toBe('0x451563ab9b5b4e8dfaa602f5e7890089edf6bf10');
    // priority defaults to 0
    expect(file?.subscriptions[0].priority).toBe(0);
    // matchCount defaults to 0
    expect(file?.subscriptions[0].matchCount).toBe(0);
    // lastMatchAt defaults to null
    expect(file?.subscriptions[0].lastMatchAt).toBeNull();
    // lastMatchedLessonId defaults to null (Q4 peer-poll resolution)
    expect(file?.subscriptions[0].lastMatchedLessonId).toBeNull();
  });

  it('preserves lastMatchedLessonId when provided (Q4 peer-poll: id-based match window)', () => {
    const raw = JSON.stringify({
      version: 1,
      subscriptions: [
        {
          id: 'a',
          docId: 'pop.brain.shared',
          filter: { tags: ['paymaster'] },
          lastMatchedLessonId: 'hb-697-vigil-hb-593-ack-...-1778249252',
          lastMatchAt: 1778249252,
          matchCount: 3,
        },
      ],
    });
    const { result, file } = parseSubscriptionsFile(raw);
    expect(result.ok).toBe(true);
    expect(file?.subscriptions[0].lastMatchedLessonId).toBe(
      'hb-697-vigil-hb-593-ack-...-1778249252',
    );
    expect(file?.subscriptions[0].lastMatchAt).toBe(1778249252);
    expect(file?.subscriptions[0].matchCount).toBe(3);
  });

  it('rejects duplicate ids', () => {
    const raw = JSON.stringify({
      version: 1,
      subscriptions: [
        { id: 'a', docId: 'pop.brain.shared', filter: { titleContains: 'foo' } },
        { id: 'a', docId: 'pop.brain.shared', filter: { titleContains: 'bar' } },
      ],
    });
    const { result } = parseSubscriptionsFile(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /duplicate id/.test(e))).toBe(true);
  });

  it('warns on non-standard docId but does not fail', () => {
    const raw = JSON.stringify({
      version: 1,
      subscriptions: [
        { id: 'a', docId: 'pop.brain.custom', filter: { titleContains: 'foo' } },
      ],
    });
    const { result, file } = parseSubscriptionsFile(raw);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /not a standard brain doc/.test(w))).toBe(true);
    expect(file?.subscriptions[0].docId).toBe('pop.brain.custom');
  });

  it('rejects a subscription with no filter object', () => {
    const raw = JSON.stringify({
      version: 1,
      subscriptions: [{ id: 'a', docId: 'pop.brain.shared', filter: 'invalid' }],
    });
    const { result } = parseSubscriptionsFile(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /filter must be an object/.test(e))).toBe(true);
  });

  it('preserves driftThreshold + createdAt when provided', () => {
    const raw = JSON.stringify({
      version: 1,
      subscriptions: [
        {
          id: 'a',
          docId: 'pop.brain.shared',
          filter: { tags: ['paymaster'] },
          driftThreshold: 20,
          createdAt: 1778250000,
        },
      ],
    });
    const { result, file } = parseSubscriptionsFile(raw);
    expect(result.ok).toBe(true);
    expect(file?.subscriptions[0].driftThreshold).toBe(20);
    expect(file?.subscriptions[0].createdAt).toBe(1778250000);
  });
});

describe('validateFilter — Task #513 v1 filter language', () => {
  it('accepts an empty filter (matches all) but warns', () => {
    const r = validateFilter({}, 'f');
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /empty filter/.test(w))).toBe(true);
  });

  it('rejects unsupported filter keys (regex, NOT, OR — out of v1 scope)', () => {
    const r = validateFilter({ regex: '.*' }, 'f');
    expect(r.errors.some((e) => /unsupported filter key "regex"/.test(e))).toBe(true);
  });

  it('lowercases author addresses', () => {
    const r = validateFilter({ author: '0x451563aB9b5b4E8DfaA602f5e7890089EDF6bf10' }, 'f');
    expect(r.errors).toEqual([]);
    expect(r.canonical.author).toBe('0x451563ab9b5b4e8dfaa602f5e7890089edf6bf10');
  });

  it('rejects malformed author addresses', () => {
    const r = validateFilter({ author: 'not-an-address' }, 'f');
    expect(r.errors.some((e) => /must be a 0x-prefixed 40-hex/.test(e))).toBe(true);
  });

  it('lowercases delegateTo addresses', () => {
    const r = validateFilter({ delegateTo: '0x7150aEE7139cb2AC19c98c33C861B99E998b9a8E' }, 'f');
    expect(r.errors).toEqual([]);
    expect(r.canonical.delegateTo).toBe('0x7150aee7139cb2ac19c98c33c861b99e998b9a8e');
  });

  it('lowercases tag arrays', () => {
    const r = validateFilter({ tags: ['Paymaster', 'Sprint20'] }, 'f');
    expect(r.errors).toEqual([]);
    expect(r.canonical.tags).toEqual(['paymaster', 'sprint20']);
  });

  it('rejects non-array tags', () => {
    const r = validateFilter({ tags: 'paymaster' }, 'f');
    expect(r.errors.some((e) => /tags: must be an array/.test(e))).toBe(true);
  });

  it('rejects empty titleContains', () => {
    const r = validateFilter({ titleContains: '' }, 'f');
    expect(r.errors.some((e) => /titleContains: must be a non-empty string/.test(e))).toBe(true);
  });

  it('round-trip: saveSubscriptions then loadSubscriptions preserves shape (Q2 atomic write)', () => {
    // Use a tmp file path that does NOT exist; saveSubscriptions creates parent dir
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-subs-test-'));
    const filePath = path.join(tmpDir, 'subdir-that-does-not-exist', 'subscriptions.json');
    const file = {
      version: 1 as const,
      subscriptions: [
        {
          id: 'roundtrip',
          docId: 'pop.brain.shared',
          filter: { author: '0x451563ab9b5b4e8dfaa602f5e7890089edf6bf10' },
          priority: 0,
          matchCount: 7,
          lastMatchAt: 1778250000,
          lastMatchedLessonId: 'hb-N-...-1NNNNNNNNN',
          createdAt: 1778240000,
        },
      ],
    };
    saveSubscriptions(file, filePath);
    expect(fs.existsSync(filePath)).toBe(true);
    const { result, file: loaded } = loadSubscriptions(filePath);
    expect(result.ok).toBe(true);
    expect(loaded.subscriptions[0].id).toBe('roundtrip');
    expect(loaded.subscriptions[0].matchCount).toBe(7);
    expect(loaded.subscriptions[0].lastMatchedLessonId).toBe('hb-N-...-1NNNNNNNNN');
    // No leftover .tmp.* files in the directory after atomic rename
    const tmpFiles = fs.readdirSync(path.dirname(filePath)).filter((f) => f.includes('.tmp.'));
    expect(tmpFiles).toEqual([]);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('accepts a multi-key AND filter', () => {
    const r = validateFilter(
      {
        author: '0x451563aB9b5b4E8DfaA602f5e7890089EDF6bf10',
        tags: ['paymaster'],
        titleContains: 'Proposal',
      },
      'f',
    );
    expect(r.errors).toEqual([]);
    expect(r.canonical.author).toBe('0x451563ab9b5b4e8dfaa602f5e7890089edf6bf10');
    expect(r.canonical.tags).toEqual(['paymaster']);
    expect(r.canonical.titleContains).toBe('Proposal');
  });
});