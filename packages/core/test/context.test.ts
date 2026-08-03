/**
 * createPopContext contract: the documented zero-config path must work.
 *
 * `createPopContext({ chainId: 100 })` + `fn(ctx.client, …)` is the first
 * thing the README shows; the context chain therefore has to reach the read
 * client as its default — without it every read threw "No chain specified"
 * unless POP_DEFAULT_CHAIN was also set.
 */

import { describe, it, expect } from 'vitest';
import { createPopContext } from '../src/context';
import { GraphClient } from '../src/graph/client';

describe('createPopContext chain default', () => {
  it('ctx.client serves reads on the context chain with no per-call chainId', async () => {
    const ctx = createPopContext({
      chainId: 100,
      graph: {
        fetch: (async () =>
          new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })) as unknown as typeof fetch,
      },
    });

    const plan = ctx.client.resolveTransportPlan();
    expect(plan.chainId).toBe(100);
    expect(plan.networkName).toBe('Gnosis');

    await expect(ctx.client.query('{ ok }')).resolves.toEqual({ ok: true });
  });

  it('a per-call chainId still overrides the default', () => {
    const client = new GraphClient({ defaultChainId: 100 });
    expect(client.resolveTransportPlan(42161).chainId).toBe(42161);
  });

  it('without a default, a chainless read still fails loudly (CLI parity)', () => {
    const client = new GraphClient({});
    expect(() => client.resolveTransportPlan()).toThrow(/No chain specified/);
  });
});
