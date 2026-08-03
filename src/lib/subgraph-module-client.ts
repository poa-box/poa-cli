/**
 * A GraphClient view over THIS package's subgraph module.
 *
 * Core helpers (resolveOrgModules, fetchOrgBeaconSnapshot, …) take a
 * GraphClient. The CLI could hand them the underlying client instance
 * directly, but tests (and any host instrumentation) intercept the MODULE
 * exports — vi.mock('../../src/lib/subgraph') replaces query() /
 * queryWithFieldFallback(). Routing through the module keeps that seam:
 * mock the module, and every core helper the CLI wraps sees the mock.
 *
 * Methods are looked up lazily so a partial mock (only `query`) works until
 * a missing method is actually called.
 */

import type { GraphClient } from '@poa-box/core/graph/client';
import * as subgraph from './subgraph';

export function subgraphModuleClient(): GraphClient {
  return {
    query: (q: string, v?: Record<string, any>, c?: number) => subgraph.query(q, v, c),
    queryWithFieldFallback: (tiers: any, opts?: any) => subgraph.queryWithFieldFallback(tiers, opts),
    queryAllChains: (q: string, v?: Record<string, any>) => subgraph.queryAllChains(q, v),
    queryUrl: (url: string, q: string, v?: Record<string, any>) => subgraph.queryUrl(url, q, v),
    resolveTransportPlan: (c?: number) => subgraph.resolveTransportPlan(c),
    getTransportStatus: (c?: number) => subgraph.getTransportStatus(c),
    getFreeExhaustedUntil: (c: number) => subgraph.getFreeExhaustedUntil(c),
  } as unknown as GraphClient;
}
