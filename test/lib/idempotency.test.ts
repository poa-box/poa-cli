import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  checkIdempotencyCache,
  recordIdempotentResult,
  computeCacheKey,
  argvToIdempotencyString,
  resolveTtlSeconds,
  _clearIdempotencyCacheForTest,
} from '../../src/lib/idempotency';

// Use a tmp dir so we don't clobber the real agent home
const TMP_HOME = path.join(os.tmpdir(), `pop-agent-idempotency-test-${Date.now()}`);

describe('idempotency cache — task #369', () => {
  beforeEach(() => {
    process.env.POP_AGENT_HOME = TMP_HOME;
    fs.mkdirSync(TMP_HOME, { recursive: true });
    _clearIdempotencyCacheForTest();
  });

  afterEach(() => {
    delete process.env.POP_AGENT_HOME;
    delete process.env.POP_IDEMPOTENCY_TTL_MINUTES;
    try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  /** Backdate every cache entry by `minutes` (test helper). */
  function backdateEntries(minutes: number): void {
    const cachePath = path.join(TMP_HOME, 'idempotency-cache.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    for (const k of Object.keys(cache.entries)) {
      cache.entries[k].ts -= minutes * 60;
    }
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  }

  describe('computeCacheKey', () => {
    it('produces deterministic keys for identical inputs', () => {
      const k1 = computeCacheKey('0xorg', 'vote.create', 'idem-1');
      const k2 = computeCacheKey('0xorg', 'vote.create', 'idem-1');
      expect(k1).toBe(k2);
    });

    it('produces different keys when orgId differs', () => {
      const k1 = computeCacheKey('0xorg1', 'vote.create', 'idem-1');
      const k2 = computeCacheKey('0xorg2', 'vote.create', 'idem-1');
      expect(k1).not.toBe(k2);
    });

    it('produces different keys when command differs', () => {
      const k1 = computeCacheKey('0xorg', 'vote.create', 'idem-1');
      const k2 = computeCacheKey('0xorg', 'task.create', 'idem-1');
      expect(k1).not.toBe(k2);
    });

    it('produces different keys when idempotency key differs', () => {
      const k1 = computeCacheKey('0xorg', 'vote.create', 'idem-A');
      const k2 = computeCacheKey('0xorg', 'vote.create', 'idem-B');
      expect(k1).not.toBe(k2);
    });
  });

  describe('argvToIdempotencyString', () => {
    it('strips transient fields that should not affect the key', () => {
      const argv1 = {
        name: 'foo',
        description: 'bar',
        duration: 60,
        privateKey: '0xdead',
        dryRun: false,
        yes: true,
        json: true,
      };
      const argv2 = {
        name: 'foo',
        description: 'bar',
        duration: 60,
        privateKey: '0xbeef',
        dryRun: true,
        yes: false,
        json: false,
      };
      expect(argvToIdempotencyString(argv1)).toBe(argvToIdempotencyString(argv2));
    });

    it('is order-independent', () => {
      const argv1 = { name: 'foo', description: 'bar', duration: 60 };
      const argv2 = { duration: 60, name: 'foo', description: 'bar' };
      expect(argvToIdempotencyString(argv1)).toBe(argvToIdempotencyString(argv2));
    });

    it('produces different strings for different content', () => {
      const argv1 = { name: 'foo', duration: 60 };
      const argv2 = { name: 'foo', duration: 120 };
      expect(argvToIdempotencyString(argv1)).not.toBe(argvToIdempotencyString(argv2));
    });
  });

  describe('checkIdempotencyCache + recordIdempotentResult', () => {
    it('returns null on a fresh cache', () => {
      const result = checkIdempotencyCache('0xorg', 'vote.create', 'key-1');
      expect(result).toBeNull();
    });

    it('returns the cached result after recording', () => {
      recordIdempotentResult('0xorg', 'vote.create', 'key-1', {
        proposalId: '42',
        txHash: '0xabc',
      });
      const cached = checkIdempotencyCache('0xorg', 'vote.create', 'key-1');
      expect(cached).toEqual({ proposalId: '42', txHash: '0xabc' });
    });

    it('isolates cache entries by orgId', () => {
      recordIdempotentResult('0xorg1', 'vote.create', 'key-1', { proposalId: '1' });
      recordIdempotentResult('0xorg2', 'vote.create', 'key-1', { proposalId: '2' });
      expect(checkIdempotencyCache('0xorg1', 'vote.create', 'key-1')).toEqual({ proposalId: '1' });
      expect(checkIdempotencyCache('0xorg2', 'vote.create', 'key-1')).toEqual({ proposalId: '2' });
    });

    it('isolates cache entries by command', () => {
      recordIdempotentResult('0xorg', 'vote.create', 'key-1', { proposalId: '42' });
      recordIdempotentResult('0xorg', 'task.create', 'key-1', { taskId: '7' });
      expect(checkIdempotencyCache('0xorg', 'vote.create', 'key-1')).toEqual({ proposalId: '42' });
      expect(checkIdempotencyCache('0xorg', 'task.create', 'key-1')).toEqual({ taskId: '7' });
    });

    it('evicts expired entries (>15 min old)', () => {
      // Record with a deliberately stale timestamp by reading + rewriting
      // the cache file directly.
      recordIdempotentResult('0xorg', 'vote.create', 'key-1', { proposalId: '42' });
      const cachePath = path.join(TMP_HOME, 'idempotency-cache.json');
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      // Backdate the entry to 20 minutes ago
      for (const k of Object.keys(cache.entries)) {
        cache.entries[k].ts -= 20 * 60;
      }
      fs.writeFileSync(cachePath, JSON.stringify(cache));
      // Should now return null (expired)
      const result = checkIdempotencyCache('0xorg', 'vote.create', 'key-1');
      expect(result).toBeNull();
    });

    it('simulates the HB#211 duplicate-proposal scenario', () => {
      // First call: no cache, returns null — caller submits tx, records result
      const firstCheck = checkIdempotencyCache('0xorg', 'vote.create', 'merge-pr-14');
      expect(firstCheck).toBeNull();
      recordIdempotentResult('0xorg', 'vote.create', 'merge-pr-14', {
        proposalId: '55',
        txHash: '0xfirst',
      });

      // Second call (the HB#211 retry): cache hit, caller returns cached result
      // WITHOUT submitting a second tx
      const secondCheck = checkIdempotencyCache('0xorg', 'vote.create', 'merge-pr-14');
      expect(secondCheck).toEqual({ proposalId: '55', txHash: '0xfirst' });
    });
  });

  describe('parameterizable TTL', () => {
    it('resolveTtlSeconds: explicit param wins over env and default', () => {
      process.env.POP_IDEMPOTENCY_TTL_MINUTES = '60';
      expect(resolveTtlSeconds(120)).toBe(120);
    });

    it('resolveTtlSeconds: env var wins over default', () => {
      process.env.POP_IDEMPOTENCY_TTL_MINUTES = '60';
      expect(resolveTtlSeconds()).toBe(3600);
    });

    it('resolveTtlSeconds: defaults to 15 minutes', () => {
      expect(resolveTtlSeconds()).toBe(15 * 60);
    });

    it('resolveTtlSeconds: ignores invalid env values', () => {
      process.env.POP_IDEMPOTENCY_TTL_MINUTES = 'soon';
      expect(resolveTtlSeconds()).toBe(15 * 60);
    });

    it('honors a custom TTL passed to checkIdempotencyCache', () => {
      recordIdempotentResult('0xorg', 'vote.create', 'key-1', { proposalId: '42' }, 3600);
      backdateEntries(20); // past the 15-min default, within 1h

      // With a 1-hour TTL the entry is still fresh
      expect(checkIdempotencyCache('0xorg', 'vote.create', 'key-1', 3600))
        .toEqual({ proposalId: '42' });
      // With the default 15-min TTL the same entry is expired
      expect(checkIdempotencyCache('0xorg', 'vote.create', 'key-1')).toBeNull();
    });

    it('honors POP_IDEMPOTENCY_TTL_MINUTES when no param is passed', () => {
      recordIdempotentResult('0xorg', 'vote.create', 'key-1', { proposalId: '42' });
      backdateEntries(20);

      process.env.POP_IDEMPOTENCY_TTL_MINUTES = '60';
      expect(checkIdempotencyCache('0xorg', 'vote.create', 'key-1'))
        .toEqual({ proposalId: '42' });

      delete process.env.POP_IDEMPOTENCY_TTL_MINUTES;
      expect(checkIdempotencyCache('0xorg', 'vote.create', 'key-1')).toBeNull();
    });

    it('records the TTL used into the cache entry', () => {
      recordIdempotentResult('0xorg', 'vote.create', 'key-1', { proposalId: '42' }, 3600);
      recordIdempotentResult('0xorg', 'task.create', 'key-2', { taskId: '7' });

      const cachePath = path.join(TMP_HOME, 'idempotency-cache.json');
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const entries = Object.values(cache.entries) as any[];
      const voteEntry = entries.find(e => e.command === 'vote.create');
      const taskEntry = entries.find(e => e.command === 'task.create');
      expect(voteEntry.ttlSeconds).toBe(3600);
      expect(taskEntry.ttlSeconds).toBe(15 * 60);
    });
  });

  describe('transient argv keys (Phase 1 additions)', () => {
    it('ignores quiet, preflight, and idempotency-ttl flags', () => {
      const base = { name: 'foo', duration: 60 };
      const withFlags = {
        name: 'foo',
        duration: 60,
        quiet: true,
        preflight: false,
        noPreflight: true,
        'no-preflight': true,
        idempotencyTtl: 30,
        'idempotency-ttl': 30,
      };
      expect(argvToIdempotencyString(withFlags)).toBe(argvToIdempotencyString(base));
    });
  });
});
