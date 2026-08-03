/**
 * Transport regression pins for GraphClient.request().
 *
 * These four body shapes made graphql-request v6 throw ClientError; the
 * fetch-based port must throw too. Resolving undefined instead turns
 * transport failures into "no rows" — the silent-empty failure the tiered
 * client exists to prevent — and clears still-valid free-tier quota pins via
 * the success path.
 */

import { describe, it, expect } from 'vitest';
import {
  GraphClient,
  GraphRequestError,
  InMemoryTierStateStore,
  isQuotaError,
  isAuthError,
} from '../src/graph/client';

const GNOSIS = 100;

function clientWithBody(
  status: number,
  body: string,
  headers: Record<string, string> = {},
  store = new InMemoryTierStateStore()
): GraphClient {
  return new GraphClient({
    stateStore: store,
    fetch: (async () => new Response(body, { status, headers })) as unknown as typeof fetch,
  });
}

describe('HTTP-ok bodies without data still throw (graphql-request parity)', () => {
  for (const [label, body] of [
    ['empty object {}', '{}'],
    ['empty body', ''],
    ['data: null', '{"data":null}'],
    ['non-array errors value', '{"errors":"auth error: missing authorization header"}'],
  ] as const) {
    it(`200 with ${label} rejects`, async () => {
      const client = clientWithBody(200, body);
      await expect(client.query('{ _meta { block { number } } }', {}, GNOSIS))
        .rejects.toThrow();
    });
  }

  it('a non-array errors value is classifiable as an auth error', async () => {
    const client = clientWithBody(200, '{"errors":"auth error: missing authorization header"}');
    const err = await client.query('{ x }', {}, GNOSIS).catch(e => e);
    expect(err).toBeInstanceOf(GraphRequestError);
    expect(isAuthError(err)).toBe(true);
  });
});

describe('non-JSON bodies keep their text classifiable', () => {
  it('plain-text 429 classifies as quota via the message anchor', async () => {
    const err = await clientWithBody(429, 'Too many requests').query('{ x }', {}, GNOSIS).catch(e => e);
    expect(isQuotaError(err)).toBe(true);
  });

  it('a proxy 403 text body saying "rate limit exceeded" classifies as quota via response.error', async () => {
    // Status is NOT 429/402 and the message anchor does not match — only the
    // body text (carried in response.error, as graphql-request did) can say
    // this is quota exhaustion.
    const err = await clientWithBody(403, 'rate limit exceeded, come back later').query('{ x }', {}, GNOSIS).catch(e => e);
    expect(isQuotaError(err)).toBe(true);
  });
});

describe('quota pins survive no-data 200s', () => {
  it('a free-tier 200-with-{} does not clear a still-valid exhaustion pin', async () => {
    const store = new InMemoryTierStateStore();
    const future = Math.floor(Date.now() / 1000) + 600;
    store.save({ version: 1, chains: { [String(GNOSIS)]: { freeExhaustedUntil: future, recordedAt: 0 } } });

    const client = clientWithBody(200, '{}', {}, store);
    await expect(client.query('{ x }', {}, GNOSIS)).rejects.toThrow();
    expect(client.getFreeExhaustedUntil(GNOSIS)).toBe(future);
  });
});
