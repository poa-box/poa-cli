/**
 * Execution layer — consumer-chosen transaction paths over TxIntent/contracts.
 * - ethers.ts: direct EOA path (gas estimate, send, wait, log parsing, error classification)
 * - sponsored.ts: EIP-7702 / ERC-4337 sponsored path via PaymasterHub + bundler
 */
export * from './ethers';
export * from './sponsored';
