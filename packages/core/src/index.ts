/**
 * @poa-box/core — the stable POP protocol layer.
 *
 * Subpath imports are the primary API (tree-shake friendly and explicit):
 *
 *   @poa-box/core/chains            chain table + env-injected resolvers + tokens
 *   @poa-box/core/abis              generated contract ABIs (ALL_ABIS registry)
 *   @poa-box/core/graph/client      tiered subgraph client (GraphClient)
 *   @poa-box/core/graph/documents   GraphQL documents + pure derivation helpers
 *   @poa-box/core/reads/*           typed reads (resolve, per-domain)
 *   @poa-box/core/tx/*              TxIntent + per-domain intent builders
 *   @poa-box/core/execute/*         ethers EOA executor + 4337/7702 sponsored path
 *   @poa-box/core/metadata/*        canonical metadata builders (key order = protocol)
 *   @poa-box/core/ipfs              pin/fetch client (injected endpoints)
 *   @poa-box/core/payout|perms|zkemail|encoding|…  pure domain logic
 *
 * This barrel re-exports the kernel for convenience; bundle-sensitive
 * consumers should prefer subpaths.
 */

export * from './env';
export * from './errors';
export * from './exit-codes';
export * from './chains';
export * from './contracts';
export * from './encoding';
export * from './format';
export * from './validation';
export * from './similarity';
export * from './stats';
export * from './label-aliases';
export * from './multicall';
export * from './payout';
export * from './perms';
export * from './error-catalog';
export * from './sponsorship-config';
export * from './context';
export * from './tx/intent';
export * from './graph/client';
export * as documents from './graph/documents';
export * as abis from './abis';
export * from './reads/resolve';
export * from './ipfs';
export * from './version';
export * from './task-lens';
export * from './preflight';
// NOT re-exported here: ./execute (ethers EOA executor + 4337/7702 sponsored
// path). It requires the optional viem/permissionless peers at load time, and
// this barrel must stay loadable for reads-only consumers that skip them.
// Import executors explicitly: '@poa-box/core/execute/ethers' / '/sponsored'.
export * as zkemail from './zkemail';
export * as intents from './tx';
export * as reads from './reads';
export * as metadata from './metadata';
