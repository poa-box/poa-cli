/**
 * GraphQL documents by domain, re-exported as namespaces.
 * Moved verbatim from the CLI's src/queries/ — raw documents stay exported so
 * consumers (e.g. Apollo users) can keep their cache layer and still use the
 * canonical queries.
 */

export * as activityDocuments from './activity';
export * as beaconsDocuments from './beacons';
export * as infrastructureDocuments from './infrastructure';
export * as orgDocuments from './org';
export * as paymasterDocuments from './paymaster';
export * as roleDocuments from './role';
export * as rolesDocuments from './roles';
export * as taskDocuments from './task';
export * as tokenDocuments from './token';
export * as treasuryDocuments from './treasury';
export * as userDocuments from './user';
export * as votingClassesDocuments from './voting-classes';
export * as votingDocuments from './voting';
export * as vouchDocuments from './vouch';
export * as zkemailDocuments from './zkemail';
