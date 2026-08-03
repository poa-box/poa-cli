/**
 * PopContext — the bag of injected services that resolved (async) builders and
 * read helpers take as their first argument.
 *
 * Hosts construct it once: the CLI from process.env + its fs-backed tier
 * store, a frontend from its wagmi/Apollo wiring, an integrator from nothing
 * but a chainId. createPop() (index.ts) wraps one of these in a bound facade.
 */

import type { ethers } from 'ethers';
import { GraphClient } from './graph/client';
import type { GraphClientOptions } from './graph/client';
import type { IpfsOptions } from './ipfs';
import type { EnvSource } from './env';

export interface PopContext {
  /** Subgraph reads (tier-routed). */
  client: GraphClient;
  /** Default chain for reads and address resolution. */
  chainId?: number;
  /** Only builders that feature-detect or preflight need a provider. */
  provider?: ethers.providers.Provider;
  /** Only builders that pin metadata need IPFS options. */
  ipfs?: IpfsOptions;
  /** Never read directly by domain code; passed to helpers that take env. */
  env?: EnvSource;
}

export interface CreatePopContextOptions {
  /** Default chain for reads and address resolution. */
  chainId?: number;
  /** Env overrides (endpoint/tier/IPFS vars). Pure defaults when omitted. */
  env?: EnvSource;
  /** Needed only for feature detection / preflight / live decimals reads. */
  provider?: ethers.providers.Provider;
  /** Graph transport overrides (state store, fetch, warn reporter). */
  graph?: Omit<GraphClientOptions, 'env'>;
  /** IPFS endpoints / readonly flag. */
  ipfs?: IpfsOptions;
}

/**
 * One-call setup for integrators:
 *
 *   const ctx = createPopContext({ chainId: 100 });
 *   const org = await resolveOrgModules(ctx.client, 'my-org');
 *   const intent = await createTaskIntent(ctx, { org: 'my-org', ... });
 *
 * Every resolved builder takes this ctx as its first argument; execution is
 * host-chosen (executeIntent for ethers EOA, encodeIntent for anything else).
 */
export function createPopContext(options: CreatePopContextOptions = {}): PopContext {
  const client = new GraphClient({ env: options.env, ...options.graph });
  return {
    client,
    chainId: options.chainId,
    provider: options.provider,
    ipfs: options.ipfs,
    env: options.env,
  };
}
