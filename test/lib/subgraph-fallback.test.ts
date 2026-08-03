import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

/**
 * The transport is @poa/core's fetch-based client; the stub translates the
 * requestMock protocol (resolve data / reject with `.response`) into HTTP
 * responses so the classification paths run for real.
 */
vi.stubGlobal('fetch', async (url: any, init: any) => {
  const body = JSON.parse(init?.body ?? '{}');
  try {
    const data = await requestMock(String(url), body.query, body.variables);
    return new Response(JSON.stringify({ data }), { status: 200 });
  } catch (err: any) {
    const r = err?.response ?? {};
    const payload = Array.isArray(r.errors)
      ? { errors: r.errors }
      : { errors: [{ message: err?.message || 'error' }] };
    return new Response(JSON.stringify(payload), { status: r.status ?? 500, headers: r.headers || {} });
  }
});

import { queryWithFieldFallback } from '../../src/lib/subgraph';

const CHAIN_ID = 100; // Gnosis — resolvable without env vars

const TIER_0 = { query: '{ tasks { id newField } }' };
const TIER_1 = { query: '{ tasks { id } }' };

/** GraphQL validation error as graphql-request surfaces it. */
function validationError(field: string): Error {
  const err: any = new Error(`Cannot query field "${field}" on type "Task"`);
  err.response = {
    errors: [
      {
        message: `Cannot query field "${field}" on type "Task"`,
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
      },
    ],
  };
  return err;
}

describe('queryWithFieldFallback', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('returns tier 0 data with tierIndex 0 when the rich query works', async () => {
    requestMock.mockResolvedValueOnce({ tasks: [{ id: '1', newField: 'x' }] });

    const result = await queryWithFieldFallback([TIER_0, TIER_1], { chainId: CHAIN_ID });
    expect(result.tierIndex).toBe(0);
    expect(result.data).toEqual({ tasks: [{ id: '1', newField: 'x' }] });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('falls through to tier 1 on an unknown-field validation error', async () => {
    requestMock
      .mockRejectedValueOnce(validationError('newField'))
      .mockResolvedValueOnce({ tasks: [{ id: '1' }] });

    const result = await queryWithFieldFallback([TIER_0, TIER_1], { chainId: CHAIN_ID });
    expect(result.tierIndex).toBe(1);
    expect(result.data).toEqual({ tasks: [{ id: '1' }] });
    expect(requestMock).toHaveBeenCalledTimes(2);
    // Tier 1 was sent the degraded query
    expect(requestMock.mock.calls[1][1]).toBe(TIER_1.query);
  });

  it('detects message-only validation errors (no extensions code)', async () => {
    const err: any = new Error('Type `Task` has no field `newField`');
    requestMock
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ tasks: [] });

    const result = await queryWithFieldFallback([TIER_0, TIER_1], { chainId: CHAIN_ID });
    expect(result.tierIndex).toBe(1);
  });

  it('rethrows network errors immediately without trying later tiers', async () => {
    requestMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:443'));

    await expect(
      queryWithFieldFallback([TIER_0, TIER_1], { chainId: CHAIN_ID })
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('throws the last validation error when every tier fails validation', async () => {
    requestMock
      .mockRejectedValueOnce(validationError('newField'))
      .mockRejectedValueOnce(validationError('id'));

    await expect(
      queryWithFieldFallback([TIER_0, TIER_1], { chainId: CHAIN_ID })
    ).rejects.toThrow(/Cannot query field "id"/);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('throws when called with no tiers', async () => {
    await expect(queryWithFieldFallback([], { chainId: CHAIN_ID })).rejects.toThrow(/at least one/);
  });
});
