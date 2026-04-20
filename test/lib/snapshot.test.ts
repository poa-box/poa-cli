import { describe, it, expect, vi } from 'vitest';
import { iterateSnapshotAudits } from '../../src/lib/snapshot';

describe('iterateSnapshotAudits — HB#515 Task #496 retro-509 change-5', () => {
  it('iterates all spaces sequentially and collects results', async () => {
    const spaces = ['a.eth', 'b.eth', 'c.eth'];
    const fn = vi.fn(async (space: string) => ({ space, n: space.length }));
    const out = await iterateSnapshotAudits(spaces, fn);
    expect(out.length).toBe(3);
    expect(out[0]).toEqual({ space: 'a.eth', result: { space: 'a.eth', n: 5 } });
    expect(out[2]).toEqual({ space: 'c.eth', result: { space: 'c.eth', n: 5 } });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('isolates per-space errors — one failure does not abort the batch', async () => {
    const spaces = ['good.eth', 'bad.eth', 'good2.eth'];
    const fn = async (space: string) => {
      if (space === 'bad.eth') throw new Error('simulated 429');
      return { ok: true };
    };
    const out = await iterateSnapshotAudits(spaces, fn);
    expect(out.length).toBe(3);
    expect(out[0].result).toEqual({ ok: true });
    expect(out[1].result).toBeNull();
    expect(out[1].error?.message).toBe('simulated 429');
    expect(out[2].result).toEqual({ ok: true });
  });

  it('calls onProgress for each space with result or error', async () => {
    const progress: Array<[string, any, string | undefined]> = [];
    const onProgress = (space: string, result: any, err?: Error) => {
      progress.push([space, result, err?.message]);
    };
    const spaces = ['x.eth', 'y.eth'];
    const fn = async (space: string) => {
      if (space === 'y.eth') throw new Error('nope');
      return { hello: 'world' };
    };
    await iterateSnapshotAudits(spaces, fn, { onProgress });
    expect(progress).toEqual([
      ['x.eth', { hello: 'world' }, undefined],
      ['y.eth', null, 'nope'],
    ]);
  });

  it('returns empty array for empty input', async () => {
    const out = await iterateSnapshotAudits([], async () => ({}));
    expect(out).toEqual([]);
  });

  it('wraps non-Error throws into Error objects', async () => {
    const fn = async (_space: string) => {
      // eslint-disable-next-line no-throw-literal
      throw 'string error'; // non-Error throw
    };
    const out = await iterateSnapshotAudits(['a.eth'], fn);
    expect(out[0].error).toBeInstanceOf(Error);
    expect(out[0].error?.message).toBe('string error');
  });
});
