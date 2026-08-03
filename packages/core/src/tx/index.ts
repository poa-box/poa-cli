/**
 * Intent builders by domain. tx/intent.ts (TxIntent, encodeIntent) is
 * re-exported flat; each domain is a namespace.
 */

export * from './intent';
export * as education from './education';
export * as eligibility from './eligibility';
export * as governance from './governance';
export * as org from './org';
export * as paymaster from './paymaster';
export * as project from './project';
export * as task from './task';
export * as token from './token';
export * as treasury from './treasury';
export * as user from './user';
export * as vote from './vote';
export * as zkemail from './zkemail';
