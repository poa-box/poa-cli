/**
 * Canonical metadata builders. KEY ORDER IS A PROTOCOL CONTRACT — the
 * subgraph and every frontend parse these documents; hosts must never
 * hand-build metadata objects.
 */

export * as education from './education';
export * as org from './org';
export * as proposal from './proposal';
export * as role from './role';
export * as task from './task';
export * as token from './token';
export * as user from './user';
