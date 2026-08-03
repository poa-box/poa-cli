/**
 * Subgraph transport tiering.
 *
 * Covers all four availability combinations (both / paid-only / free-only /
 * neither), the persistence round-trip across "processes", expiry of the pin,
 * a corrupt state file, and the rule that a NON-quota error must never spend
 * paid quota.
 *
 * The transport is mocked end to end — nothing here touches the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

/**
 * Records the URL each request went to, so we can assert which tier served it.
 * The transport is @poa-box/core's fetch-based GraphQL client, so the stub speaks
 * HTTP: requestMock resolutions become 200 responses ({ data }), and
 * requestMock rejections are translated from their `.response`
 * { status, headers, errors|error } shape into the equivalent HTTP response —
 * a string `error` body becomes a non-JSON (plain text) body, exactly how
 * Studio serves its plain-text 429. A mock resolution may carry a `__headers`
 * bag, which is served as response headers and stripped from the data.
 */
vi.stubGlobal('fetch', async (url: any, init: any) => {
  const body = JSON.parse(init?.body ?? '{}');
  try {
    const res: any = await requestMock(String(url), body.query, body.variables);
    const headers = res && typeof res === 'object' ? res.__headers : undefined;
    let data = res;
    if (headers) {
      const { __headers, ...rest } = res;
      data = rest;
    }
    return new Response(JSON.stringify({ data }), { status: 200, headers: headers || {} });
  } catch (err: any) {
    const r = err?.response ?? {};
    const status = r.status ?? 500;
    const headers = r.headers || {};
    if (typeof r.error === 'string' && !Array.isArray(r.errors)) {
      // Plain-text (non-JSON) body — Studio's 429 shape.
      return new Response(r.error, { status, headers });
    }
    const payload: any = {};
    if (Array.isArray(r.errors)) payload.errors = r.errors;
    if (r.error !== undefined) payload.error = r.error;
    if (!payload.errors && !payload.error) payload.errors = [{ message: err?.message || 'error' }];
    return new Response(JSON.stringify(payload), { status, headers });
  }
});

import {
  query,
  queryAllChains,
  queryWithFieldFallback,
  resolveTransportPlan,
  getTransportStatus,
  getFreeExhaustedUntil,
  isQuotaError,
  isAuthError,
  redactSubgraphUrl,
  resetSubgraphTransportCache,
  FREE_BACKOFF_SECONDS,
} from '../../src/lib/subgraph';

const GNOSIS = 100;
const ARBITRUM = 42161;
const STUDIO_GNOSIS = 'https://api.studio.thegraph.com/query/73367/poa-gnosis-v-1/version/latest';
const GATEWAY_GNOSIS = 'https://gateway.thegraph.com/api/subgraphs/id/576YA6oF16nA2uG5Q9KFfBSvJm4ZNKzWZkwh8eWXaxJs';

const Q = '{ _meta { block { number } } }';

let stateDir: string;
let statePath: string;

/** Env keys this suite manipulates; wiped before each test for isolation. */
const OWNED_ENV = [
  'GRAPH_API_KEY',
  'POP_SUBGRAPH_TIER',
  'POP_SUBGRAPH_STATE_FILE',
  'POP_SUBGRAPH_URL',
  'POP_GNOSIS_SUBGRAPH',
  'POP_GNOSIS_SUBGRAPH_FALLBACK',
  'POP_GNOSIS_SUBGRAPH_GATEWAY',
  'POP_GNOSIS_SUBGRAPH_ID',
  'POP_ARBITRUM_SUBGRAPH',
  'POP_ARBITRUM_SUBGRAPH_FALLBACK',
  'POP_ARBITRUM_SUBGRAPH_GATEWAY',
  'POP_ARBITRUM_SUBGRAPH_ID',
  'POP_GRAPH_GATEWAY_URL',
  'POP_AGENT_HOME',
];

const savedEnv: Record<string, string | undefined> = {};

/** Simulate a fresh CLI process: drop every in-memory cache, keep the disk state. */
function newProcess(): void {
  resetSubgraphTransportCache();
}

/** graphql-request ClientError shape for an HTTP-status failure. */
function httpError(status: number, body: any, headers?: Record<string, string>): Error {
  const err: any = new Error(
    typeof body === 'string'
      ? `GraphQL Error (Code: ${status}): ${JSON.stringify({ response: { error: body, status } })}`
      : `${body?.errors?.[0]?.message}: ${JSON.stringify({ response: body })}`
  );
  err.response = typeof body === 'string'
    ? { error: body, status, headers: headers || {} }
    : { ...body, status, headers: headers || {} };
  return err;
}

/** GraphQL error body served with HTTP 200 — how the gateway reports auth failures. */
function gqlError(message: string): Error {
  const err: any = new Error(`${message}: {}`);
  err.response = { errors: [{ message }], status: 200, headers: {} };
  return err;
}

function validationError(field: string): Error {
  const err: any = new Error(`Cannot query field "${field}" on type "Task"`);
  err.response = {
    status: 200,
    errors: [{ message: `Cannot query field "${field}" on type "Task"`, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }],
  };
  return err;
}

beforeEach(() => {
  for (const k of OWNED_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop-subgraph-tier-'));
  statePath = path.join(stateDir, 'subgraph-tier-state.json');
  process.env.POP_SUBGRAPH_STATE_FILE = statePath;
  requestMock.mockReset();
  newProcess();
});

afterEach(() => {
  for (const k of OWNED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
  newProcess();
});

// ---------------------------------------------------------------------------
// Availability combinations
// ---------------------------------------------------------------------------

describe('availability: BOTH free and paid', () => {
  beforeEach(() => {
    process.env.GRAPH_API_KEY = 'test-key-never-printed';
    process.env.POP_GNOSIS_SUBGRAPH_FALLBACK = GATEWAY_GNOSIS;
    newProcess();
  });

  it('plans free first, paid second', () => {
    const plan = resolveTransportPlan(GNOSIS);
    expect(plan.availability).toBe('both');
    expect(plan.attempts.map(a => a.tier)).toEqual(['free', 'paid']);
    expect(plan.attempts[0].url).toBe(STUDIO_GNOSIS);
    expect(plan.attempts[1].url).toBe(GATEWAY_GNOSIS);
  });

  it('serves a healthy query from the free tier only', async () => {
    requestMock.mockResolvedValueOnce({ ok: 1 });
    await expect(query(Q, {}, GNOSIS)).resolves.toEqual({ ok: 1 });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toBe(STUDIO_GNOSIS);
  });

  it('switches to the gateway on a free-tier 429', async () => {
    requestMock
      .mockRejectedValueOnce(httpError(429, 'Too Many Requests'))
      .mockResolvedValueOnce({ ok: 2 });

    await expect(query(Q, {}, GNOSIS)).resolves.toEqual({ ok: 2 });
    expect(requestMock.mock.calls[0][0]).toBe(STUDIO_GNOSIS);
    expect(requestMock.mock.calls[1][0]).toBe(GATEWAY_GNOSIS);
  });

  it('switches on a 200-with-GraphQL-rate-limit body too', async () => {
    requestMock
      .mockRejectedValueOnce(gqlError('rate limit exceeded for this deployment'))
      .mockResolvedValueOnce({ ok: 3 });

    await expect(query(Q, {}, GNOSIS)).resolves.toEqual({ ok: 3 });
    expect(requestMock.mock.calls[1][0]).toBe(GATEWAY_GNOSIS);
  });

  it('a NON-quota error does NOT trigger a paid retry', async () => {
    requestMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:443'));

    await expect(query(Q, {}, GNOSIS)).rejects.toThrow(/ECONNREFUSED/);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(getFreeExhaustedUntil(GNOSIS)).toBeUndefined();
  });

  it('a schema validation error does NOT trigger a paid retry', async () => {
    requestMock.mockRejectedValueOnce(validationError('deadline'));

    await expect(query(Q, {}, GNOSIS)).rejects.toThrow(/Cannot query field/);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(getFreeExhaustedUntil(GNOSIS)).toBeUndefined();
  });

  it('a query whose TEXT contains "429" is not mistaken for a rate limit', async () => {
    // The old substring check matched ClientError.message, which embeds the
    // serialized request — so any query mentioning 429 burned paid quota.
    const err: any = new Error(
      'Cannot query field "x": {"response":{"errors":[{"message":"Cannot query field \\"x\\""}],"status":200},"request":{"query":"{ org(block: 429) { id } }"}}'
    );
    err.response = { status: 200, errors: [{ message: 'Cannot query field "x"' }] };
    requestMock.mockRejectedValueOnce(err);

    await expect(query('{ org(block: 429) { id } }', {}, GNOSIS)).rejects.toThrow();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});

describe('availability: PAID only', () => {
  beforeEach(() => {
    process.env.GRAPH_API_KEY = 'test-key';
    // Point the primary straight at the gateway: no free transport exists.
    process.env.POP_GNOSIS_SUBGRAPH = GATEWAY_GNOSIS;
    newProcess();
  });

  it('never probes Studio', async () => {
    const plan = resolveTransportPlan(GNOSIS);
    expect(plan.availability).toBe('paid-only');
    expect(plan.attempts.map(a => a.tier)).toEqual(['paid']);
    expect(plan.freeUrl).toBeUndefined();

    requestMock.mockResolvedValueOnce({ ok: 1 });
    await query(Q, {}, GNOSIS);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toBe(GATEWAY_GNOSIS);
  });

  it('POP_SUBGRAPH_TIER=paid forces the gateway even when Studio is configured', async () => {
    delete process.env.POP_GNOSIS_SUBGRAPH;
    process.env.POP_GNOSIS_SUBGRAPH_FALLBACK = GATEWAY_GNOSIS;
    process.env.POP_SUBGRAPH_TIER = 'paid';
    newProcess();

    const plan = resolveTransportPlan(GNOSIS);
    expect(plan.availability).toBe('both');
    expect(plan.attempts.map(a => a.tier)).toEqual(['paid']);

    requestMock.mockResolvedValueOnce({ ok: 1 });
    await query(Q, {}, GNOSIS);
    expect(requestMock.mock.calls[0][0]).toBe(GATEWAY_GNOSIS);
  });

  it('reports a gateway auth rejection as an actionable error', async () => {
    requestMock.mockRejectedValueOnce(gqlError('auth error: API key not found'));
    await expect(query(Q, {}, GNOSIS)).rejects.toThrow(/rejected the API key/);
  });
});

describe('availability: FREE only', () => {
  it('uses Studio and never mentions a gateway', async () => {
    const plan = resolveTransportPlan(GNOSIS);
    expect(plan.availability).toBe('free-only');
    expect(plan.attempts.map(a => a.tier)).toEqual(['free']);
    expect(plan.hasApiKey).toBe(false);

    requestMock.mockResolvedValueOnce({ ok: 1 });
    await query(Q, {}, GNOSIS);
    expect(requestMock.mock.calls[0][0]).toBe(STUDIO_GNOSIS);
  });

  it('on exhaustion tells you to set GRAPH_API_KEY (Gnosis already knows its gateway id)', async () => {
    requestMock.mockRejectedValueOnce(httpError(429, 'Too Many Requests'));

    await expect(query(Q, {}, GNOSIS)).rejects.toMatchObject({
      message: expect.stringMatching(/rate-limited/),
      suggestion: expect.stringMatching(/GRAPH_API_KEY/),
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('on exhaustion names BOTH the key and the gateway var when no gateway is known', async () => {
    requestMock.mockRejectedValueOnce(httpError(429, 'Too Many Requests'));

    await expect(query(Q, {}, ARBITRUM)).rejects.toMatchObject({
      message: expect.stringMatching(/rate-limited/),
      suggestion: expect.stringMatching(/GRAPH_API_KEY.*POP_ARBITRUM_SUBGRAPH_GATEWAY/s),
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('a configured gateway with NO key counts as free-only and says so', () => {
    process.env.POP_GNOSIS_SUBGRAPH_FALLBACK = GATEWAY_GNOSIS;
    newProcess();

    const plan = resolveTransportPlan(GNOSIS);
    expect(plan.availability).toBe('free-only');
    expect(plan.paidKeyMissing).toBe(true);
    expect(plan.attempts.map(a => a.tier)).toEqual(['free']);
    expect(getTransportStatus(GNOSIS).summary).toMatch(/unusable without a key/);
  });
});

describe('availability: NEITHER', () => {
  it('raises the PRECONDITION error for an RPC-only chain', async () => {
    await expect(query(Q, {}, 11155111)).rejects.toMatchObject({
      code: 4,
      message: expect.stringMatching(/POP has no subgraph on Sepolia \(chain 11155111\)/),
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('POP_SUBGRAPH_TIER=paid is prefer-paid: a chain with no gateway falls back to free', async () => {
    // The override is one global env var but paid transports are per-chain.
    // Arbitrum has no gateway deployment; honouring the override literally
    // would make the whole chain unreadable while its Studio endpoint is
    // alive, so the plan softens to the free endpoint and says so.
    process.env.POP_SUBGRAPH_TIER = 'paid';
    process.env.GRAPH_API_KEY = 'test-key';
    newProcess();

    requestMock.mockResolvedValueOnce({ ok: true });
    await expect(query(Q, {}, ARBITRUM)).resolves.toEqual({ ok: true });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(String(requestMock.mock.calls[0][0])).toMatch(/studio\.thegraph\.com/);

    const plan = resolveTransportPlan(ARBITRUM);
    expect(plan.attempts).toEqual([{ tier: 'free', url: expect.stringMatching(/studio/) }]);
    expect(plan.modeOverrideIgnored).toMatch(/no gateway configured/);
  });

  it('POP_SUBGRAPH_TIER=paid without a key explains itself', async () => {
    process.env.POP_SUBGRAPH_TIER = 'paid';
    process.env.POP_GNOSIS_SUBGRAPH_FALLBACK = GATEWAY_GNOSIS;
    newProcess();

    await expect(query(Q, {}, GNOSIS)).rejects.toMatchObject({
      code: 4,
      message: expect.stringMatching(/GRAPH_API_KEY is not set/),
    });
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('exhaustion persistence', () => {
  beforeEach(() => {
    process.env.GRAPH_API_KEY = 'test-key';
    process.env.POP_GNOSIS_SUBGRAPH_FALLBACK = GATEWAY_GNOSIS;
    newProcess();
  });

  it('round-trips across processes: the second process skips Studio entirely', async () => {
    // Process 1: eats the 429, switches, records the exhaustion.
    requestMock
      .mockRejectedValueOnce(httpError(429, 'Too Many Requests'))
      .mockResolvedValueOnce({ ok: 1 });
    await query(Q, {}, GNOSIS);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(statePath)).toBe(true);

    // Process 2: no Studio round-trip at all.
    newProcess();
    requestMock.mockReset();
    requestMock.mockResolvedValueOnce({ ok: 2 });
    await query(Q, {}, GNOSIS);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toBe(GATEWAY_GNOSIS);
  });

  it('pins for ~15 minutes, never until UTC midnight', async () => {
    requestMock
      .mockRejectedValueOnce(httpError(429, 'Too Many Requests'))
      .mockResolvedValueOnce({ ok: 1 });
    await query(Q, {}, GNOSIS);

    const until = getFreeExhaustedUntil(GNOSIS)!;
    const nowS = Math.floor(Date.now() / 1000);
    expect(until).toBeGreaterThan(nowS);
    expect(until).toBeLessThanOrEqual(nowS + FREE_BACKOFF_SECONDS + 2);
  });

  it('an x-ratelimit-reset sooner than the backoff SHORTENS the pin', async () => {
    const soon = Math.floor(Date.now() / 1000) + 60;
    requestMock
      .mockRejectedValueOnce(httpError(429, 'Too Many Requests', { 'x-ratelimit-reset': String(soon) }))
      .mockResolvedValueOnce({ ok: 1 });
    await query(Q, {}, GNOSIS);

    expect(getFreeExhaustedUntil(GNOSIS)).toBe(soon);
  });

  it('a far-future x-ratelimit-reset does NOT extend the pin past the backoff', async () => {
    const tomorrow = Math.floor(Date.now() / 1000) + 24 * 3600;
    requestMock
      .mockRejectedValueOnce(httpError(429, 'Too Many Requests', { 'x-ratelimit-reset': String(tomorrow) }))
      .mockResolvedValueOnce({ ok: 1 });
    await query(Q, {}, GNOSIS);

    const nowS = Math.floor(Date.now() / 1000);
    expect(getFreeExhaustedUntil(GNOSIS)).toBeLessThanOrEqual(nowS + FREE_BACKOFF_SECONDS + 2);
  });

  it('expires: an elapsed pin re-probes Studio', async () => {
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      chains: { '100': { freeExhaustedUntil: Math.floor(Date.now() / 1000) - 1, recordedAt: 0 } },
    }));
    newProcess();

    expect(getFreeExhaustedUntil(GNOSIS)).toBeUndefined();
    expect(resolveTransportPlan(GNOSIS).attempts.map(a => a.tier)).toEqual(['free', 'paid']);

    requestMock.mockResolvedValueOnce({ ok: 1 });
    await query(Q, {}, GNOSIS);
    expect(requestMock.mock.calls[0][0]).toBe(STUDIO_GNOSIS);
  });

  it('a live pin DEMOTES free below paid — it never drops it', () => {
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      chains: { '100': { freeExhaustedUntil: Math.floor(Date.now() / 1000) + 600, recordedAt: 0 } },
    }));
    newProcess();
    // Previously this asserted ['paid'], i.e. the pin REMOVED the free transport
    // for its whole 15-minute window. That handed the gateway a single point of
    // failure: a revoked/unbilled GRAPH_API_KEY or a transient gateway outage
    // hard-failed the command while Studio was healthy and answering. The pin's
    // purpose is only to skip a doomed Studio round-trip on the happy path, so
    // free is demoted to last resort instead.
    expect(resolveTransportPlan(GNOSIS).attempts.map(a => a.tier)).toEqual(['paid', 'free']);
  });

  it('a broken gateway falls through to the demoted free transport', async () => {
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      chains: { '100': { freeExhaustedUntil: Math.floor(Date.now() / 1000) + 600, recordedAt: 0 } },
    }));
    newProcess();
    // Gateway rejects the key (the common "exists but unbilled/revoked" state),
    // Studio is healthy.
    requestMock.mockRejectedValueOnce(
      Object.assign(new Error('auth error: invalid api key'), {
        response: { errors: [{ message: 'auth error: invalid api key' }], status: 200 },
      })
    );
    requestMock.mockResolvedValueOnce({ ok: 1 });

    await expect(query(Q, {}, GNOSIS)).resolves.toEqual({ ok: 1 });
    expect(requestMock.mock.calls[1][0]).toBe(STUDIO_GNOSIS);
    // ...and the free success clears the stale pin, which is only reachable
    // because free stayed in the plan.
    expect(getFreeExhaustedUntil(GNOSIS)).toBeUndefined();
  });

  it('clears the pin when Studio succeeds again (transient burst limit)', async () => {
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      chains: { '100': { freeExhaustedUntil: Math.floor(Date.now() / 1000) + 600, recordedAt: 0 } },
    }));
    // No paid transport, so the pin cannot cause a skip and free is retried.
    delete process.env.GRAPH_API_KEY;
    newProcess();

    expect(resolveTransportPlan(GNOSIS).freeExhaustedUntil).toBeDefined();
    requestMock.mockResolvedValueOnce({ ok: 1 });
    await query(Q, {}, GNOSIS);
    expect(getFreeExhaustedUntil(GNOSIS)).toBeUndefined();
  });

  it('pins PROACTIVELY when Studio reports x-ratelimit-remaining: 0', async () => {
    // Studio publishes the counter on every 200. Reading it means the NEXT
    // command skips the free tier instead of learning via a 429.
    const reset = Math.floor(Date.now() / 1000) + 120;
    requestMock.mockResolvedValueOnce({
      ok: 1,
      __headers: { 'x-ratelimit-limit': '3000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    });

    await expect(query(Q, {}, GNOSIS)).resolves.toEqual({ ok: 1 }); // __headers stripped
    expect(getFreeExhaustedUntil(GNOSIS)).toBe(reset);

    newProcess();
    requestMock.mockReset();
    requestMock.mockResolvedValueOnce({ ok: 2 });
    await query(Q, {}, GNOSIS);
    expect(requestMock.mock.calls[0][0]).toBe(GATEWAY_GNOSIS);
  });

  it('does NOT pin while free quota remains', async () => {
    requestMock.mockResolvedValueOnce({
      ok: 1,
      __headers: { 'x-ratelimit-limit': '3000', 'x-ratelimit-remaining': '2818' },
    });
    await query(Q, {}, GNOSIS);
    expect(getFreeExhaustedUntil(GNOSIS)).toBeUndefined();
  });

  it('never reads rate-limit headers off the PAID transport', async () => {
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      chains: { '100': { freeExhaustedUntil: Math.floor(Date.now() / 1000) + 300, recordedAt: 0 } },
    }));
    newProcess();
    // Served by the gateway; its headers must not re-pin or clear anything.
    requestMock.mockResolvedValueOnce({ ok: 1, __headers: { 'x-ratelimit-remaining': '0' } });
    await query(Q, {}, GNOSIS);
    expect(requestMock.mock.calls[0][0]).toBe(GATEWAY_GNOSIS);
    // Pin unchanged (still the hand-written one, not extended by the gateway).
    expect(getFreeExhaustedUntil(GNOSIS)).toBeGreaterThan(Math.floor(Date.now() / 1000) + 200);
  });

  it('is per-chain: exhausting Gnosis does not pin Arbitrum', async () => {
    requestMock
      .mockRejectedValueOnce(httpError(429, 'Too Many Requests'))
      .mockResolvedValueOnce({ ok: 1 });
    await query(Q, {}, GNOSIS);

    expect(getFreeExhaustedUntil(GNOSIS)).toBeDefined();
    expect(getFreeExhaustedUntil(ARBITRUM)).toBeUndefined();
  });

  it('ignores a corrupt state file instead of crashing', async () => {
    fs.writeFileSync(statePath, '{ this is not json ');
    newProcess();

    expect(() => getFreeExhaustedUntil(GNOSIS)).not.toThrow();
    expect(getFreeExhaustedUntil(GNOSIS)).toBeUndefined();

    requestMock.mockResolvedValueOnce({ ok: 1 });
    await expect(query(Q, {}, GNOSIS)).resolves.toEqual({ ok: 1 });
    expect(requestMock.mock.calls[0][0]).toBe(STUDIO_GNOSIS);
  });

  it('ignores a state file with the wrong shape', () => {
    fs.writeFileSync(statePath, JSON.stringify({ version: 99, chains: 'nope' }));
    newProcess();
    expect(getFreeExhaustedUntil(GNOSIS)).toBeUndefined();
  });

  it('survives an unwritable state path without failing the query', async () => {
    process.env.POP_SUBGRAPH_STATE_FILE = path.join(stateDir, 'not-a-dir', '\0bad', 'state.json');
    newProcess();
    requestMock
      .mockRejectedValueOnce(httpError(429, 'Too Many Requests'))
      .mockResolvedValueOnce({ ok: 1 });
    await expect(query(Q, {}, GNOSIS)).resolves.toEqual({ ok: 1 });
  });

  it('stops queryWithFieldFallback from re-probing Studio on every tier', async () => {
    requestMock
      // tier 0 on free: rate limited -> switch to paid
      .mockRejectedValueOnce(httpError(429, 'Too Many Requests'))
      // tier 0 on paid: schema is too old for the rich query
      .mockRejectedValueOnce(validationError('newField'))
      // tier 1 must go straight to paid — no second Studio probe
      .mockResolvedValueOnce({ tasks: [] });

    const res = await queryWithFieldFallback(
      [{ query: '{ tasks { id newField } }' }, { query: '{ tasks { id } }' }],
      { chainId: GNOSIS }
    );
    expect(res.tierIndex).toBe(1);
    expect(requestMock.mock.calls.map(c => c[0])).toEqual([STUDIO_GNOSIS, GATEWAY_GNOSIS, GATEWAY_GNOSIS]);
  });
});

// ---------------------------------------------------------------------------
// Gateway URL resolution (defect (e): per-network, not one ad-hoc var per chain)
// ---------------------------------------------------------------------------

describe('gateway URL resolution', () => {
  beforeEach(() => {
    process.env.GRAPH_API_KEY = 'test-key';
    newProcess();
  });

  it('derives Gnosis from the built-in subgraph id with no env var at all', () => {
    expect(resolveTransportPlan(GNOSIS).paidUrl).toBe(GATEWAY_GNOSIS);
  });

  it('lets any chain opt in with POP_<NET>_SUBGRAPH_ID', () => {
    process.env.POP_ARBITRUM_SUBGRAPH_ID = 'AbCdEf123';
    newProcess();
    const plan = resolveTransportPlan(ARBITRUM);
    expect(plan.paidUrl).toBe('https://gateway.thegraph.com/api/subgraphs/id/AbCdEf123');
    expect(plan.availability).toBe('both');
  });

  it('honours an explicit POP_<NET>_SUBGRAPH_GATEWAY over the built-in id', () => {
    process.env.POP_GNOSIS_SUBGRAPH_GATEWAY = 'https://gateway.thegraph.com/api/subgraphs/id/OTHER';
    newProcess();
    expect(resolveTransportPlan(GNOSIS).paidUrl).toBe('https://gateway.thegraph.com/api/subgraphs/id/OTHER');
  });

  it('honours a custom gateway base', () => {
    process.env.POP_GRAPH_GATEWAY_URL = 'https://gateway-eu.thegraph.com/api/subgraphs/id/';
    newProcess();
    expect(resolveTransportPlan(GNOSIS).paidUrl).toBe('https://gateway-eu.thegraph.com/api/subgraphs/id/576YA6oF16nA2uG5Q9KFfBSvJm4ZNKzWZkwh8eWXaxJs');
  });

  it('Arbitrum has NO paid tier by default (subgraph-gap: not published to the gateway)', () => {
    const plan = resolveTransportPlan(ARBITRUM);
    expect(plan.paidUrl).toBeUndefined();
    expect(plan.availability).toBe('free-only');
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('isQuotaError / isAuthError', () => {
  it('matches the exhaustion codes', () => {
    expect(isQuotaError(httpError(429, 'Too Many Requests'))).toBe(true);
    expect(isQuotaError(httpError(402, 'Payment Required'))).toBe(true);
  });

  it('matches a rate-limit message served with HTTP 200', () => {
    expect(isQuotaError(gqlError('rate limit exceeded'))).toBe(true);
    expect(isQuotaError(gqlError('Too many requests, please retry'))).toBe(true);
    expect(isQuotaError(gqlError('daily query quota reached'))).toBe(true);
  });

  it('does NOT match schema, network or auth errors', () => {
    expect(isQuotaError(validationError('deadline'))).toBe(false);
    expect(isQuotaError(new Error('connect ECONNREFUSED'))).toBe(false);
    // Confirmed live: the gateway answers HTTP 200 with this body when the
    // Authorization header is missing.
    expect(isQuotaError(gqlError('auth error: missing authorization header'))).toBe(false);
    expect(isQuotaError(gqlError('auth error: API key not found'))).toBe(false);
  });

  it('does not match a 429 that only appears in the serialized request', () => {
    const err: any = new Error('Some error: {"request":{"query":"{ x(block:429) }"}}');
    err.response = { status: 200, errors: [{ message: 'Some error' }] };
    expect(isQuotaError(err)).toBe(false);
  });

  it('classifies gateway auth failures', () => {
    expect(isAuthError(gqlError('auth error: missing authorization header'))).toBe(true);
    expect(isAuthError(gqlError('auth error: API key not found'))).toBe(true);
    expect(isAuthError(httpError(429, 'Too Many Requests'))).toBe(false);
    expect(isAuthError(validationError('x'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// queryAllChains
// ---------------------------------------------------------------------------

describe('queryAllChains', () => {
  it('distinguishes "no rows" from "chain failed"', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // getAllSubgraphUrls() order: arbitrum (42161) then gnosis (100).
    requestMock
      .mockResolvedValueOnce({ organizations: [] })
      .mockRejectedValueOnce(new Error('boom'));

    const results = await queryAllChains(Q, {});
    const arb = results.find(r => r.chainId === ARBITRUM)!;
    const gno = results.find(r => r.chainId === GNOSIS)!;

    expect(arb.data).toEqual({ organizations: [] });
    expect(arb.error).toBeUndefined();
    expect(gno.data).toBeNull();
    expect(gno.error).toMatch(/boom/);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('preserves the { chainId, name, data } shape existing callers read', async () => {
    requestMock.mockResolvedValue({ organizations: [{ id: '0x1' }] });
    const results = await queryAllChains(Q, {});
    for (const r of results) {
      expect(typeof r.chainId).toBe('number');
      expect(typeof r.name).toBe('string');
      expect(r.data).toEqual({ organizations: [{ id: '0x1' }] });
    }
  });

  it('routes each chain through its own tier plan', async () => {
    process.env.GRAPH_API_KEY = 'test-key';
    process.env.POP_GNOSIS_SUBGRAPH_FALLBACK = GATEWAY_GNOSIS;
    newProcess();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Both chains 429 on free; only Gnosis has a gateway to fall back to.
    requestMock.mockImplementation((url: string) => {
      if (url === GATEWAY_GNOSIS) return Promise.resolve({ ok: 'paid' });
      return Promise.reject(httpError(429, 'Too Many Requests'));
    });

    const results = await queryAllChains(Q, {});
    expect(results.find(r => r.chainId === GNOSIS)!.data).toEqual({ ok: 'paid' });
    const arb = results.find(r => r.chainId === ARBITRUM)!;
    expect(arb.data).toBeNull();
    expect(arb.error).toMatch(/rate-limited/);
    stderr.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Introspection / secrecy
// ---------------------------------------------------------------------------

describe('getTransportStatus', () => {
  it('reports the active tier and key detection without leaking the key', () => {
    process.env.GRAPH_API_KEY = 'SUPER-SECRET-KEY';
    process.env.POP_GNOSIS_SUBGRAPH_FALLBACK = GATEWAY_GNOSIS;
    newProcess();

    const status = getTransportStatus(GNOSIS);
    expect(status.activeTier).toBe('free');
    expect(status.availability).toBe('both');
    expect(status.hasApiKey).toBe(true);
    expect(JSON.stringify(status)).not.toContain('SUPER-SECRET-KEY');
    expect(status.summary).toMatch(/free tier active/);
    expect(status.summary).toMatch(/GRAPH_API_KEY detected/);
  });

  it('reports the paid tier once free is pinned', () => {
    process.env.GRAPH_API_KEY = 'k';
    process.env.POP_GNOSIS_SUBGRAPH_FALLBACK = GATEWAY_GNOSIS;
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      chains: { '100': { freeExhaustedUntil: Math.floor(Date.now() / 1000) + 300, recordedAt: 0 } },
    }));
    newProcess();

    const status = getTransportStatus(GNOSIS);
    expect(status.activeTier).toBe('paid');
    expect(status.summary).toMatch(/free quota spent, re-probing in ~\d+m/);
  });

  it('reports no transport for an RPC-only chain', () => {
    expect(getTransportStatus(11155111).activeTier).toBeNull();
  });

  it('redacts a legacy key-in-path gateway URL', () => {
    expect(redactSubgraphUrl('https://gateway.thegraph.com/api/deadbeefkey/subgraphs/id/ABC'))
      .toBe('https://gateway.thegraph.com/api/<redacted>/subgraphs/id/ABC');
    expect(redactSubgraphUrl('https://example.com/graphql?api_key=hunter2'))
      .toBe('https://example.com/graphql?api_key=<redacted>');
    // The modern form carries no credential in the path — leave it readable.
    expect(redactSubgraphUrl(GATEWAY_GNOSIS)).toBe(GATEWAY_GNOSIS);
  });
});

// ---------------------------------------------------------------------------
// Mode override
// ---------------------------------------------------------------------------

describe('POP_SUBGRAPH_TIER', () => {
  it('defaults to auto', () => {
    expect(resolveTransportPlan(GNOSIS).mode).toBe('auto');
  });

  it('free forces Studio even with a key and a live pin', () => {
    process.env.GRAPH_API_KEY = 'k';
    process.env.POP_GNOSIS_SUBGRAPH_FALLBACK = GATEWAY_GNOSIS;
    process.env.POP_SUBGRAPH_TIER = 'free';
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      chains: { '100': { freeExhaustedUntil: Math.floor(Date.now() / 1000) + 300, recordedAt: 0 } },
    }));
    newProcess();

    expect(resolveTransportPlan(GNOSIS).attempts.map(a => a.tier)).toEqual(['free']);
  });

  it('an unrecognised value falls back to auto and is reported', () => {
    process.env.POP_SUBGRAPH_TIER = 'gold';
    newProcess();
    const plan = resolveTransportPlan(GNOSIS);
    expect(plan.mode).toBe('auto');
    expect(plan.modeOverrideIgnored).toBe('gold');
  });
});

// ---------------------------------------------------------------------------
// Empty-override regression (POP_SUBGRAPH_URL= in the shipped .env templates)
// ---------------------------------------------------------------------------

describe('empty POP_SUBGRAPH_URL', () => {
  it('does not shadow the built-in default', () => {
    process.env.POP_SUBGRAPH_URL = '';
    newProcess();
    expect(resolveTransportPlan(GNOSIS).freeUrl).toBe(STUDIO_GNOSIS);
  });

  it('a whitespace-only override does not shadow it either', () => {
    process.env.POP_SUBGRAPH_URL = '   ';
    process.env.POP_GNOSIS_SUBGRAPH = '  ';
    newProcess();
    expect(resolveTransportPlan(GNOSIS).freeUrl).toBe(STUDIO_GNOSIS);
  });
});
