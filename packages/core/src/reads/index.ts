/**
 * Typed subgraph reads by domain. reads/resolve.ts (org resolution) is
 * re-exported flat; each domain is a namespace.
 */

export * from './resolve';
export * as education from './education';
export * as org from './org';
export * as paymaster from './paymaster';
export * as project from './project';
export * as task from './task';
export * as token from './token';
export * as treasury from './treasury';
export * as user from './user';
export * as vote from './vote';
export * as zkemail from './zkemail';

export * as authority from './authority';
