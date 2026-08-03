/**
 * Moved to @poa/core/graph/documents (shared with every consumer so query
 * documents and their field-fallback tiers can never drift from the deployed
 * schemas). This shim keeps the historical import path stable.
 */
export * from '@poa/core/graph/documents/roles';
