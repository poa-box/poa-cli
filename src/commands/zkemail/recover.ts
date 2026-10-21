import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readPendingEmailRecovery, migratePendingEmailCredential } from '@poa-box/core/email/recovery';
import { createIndexedSource } from '../../lib/indexed-source';
import { createProvider } from '../../lib/signer';
import { resolveNetworkConfig } from '../../config/networks';
import { redactSubgraphUrl } from '../../lib/subgraph';
import { readPreparedInput } from '../user/prepare';
import * as output from '../../lib/output';
import { EXIT } from '../../lib/exit-codes';

/** Inspect the exact original enrollment. This produces recovery-only pointers;
 * it never authenticates, activates, deletes a credential or resubmits a send. */
export async function recoverPendingEmail(input: Record<string, any>, rpc?: string): Promise<unknown> {
  const scope = input.scope;
  if (!scope || !Number.isSafeInteger(scope.chainId)) throw new Error('Explicit recovery scope.chainId required');
  const host = await createIndexedSource({ ...scope, ...(input.block ? { block: input.block } : {}) });
  const network = resolveNetworkConfig(scope.chainId);
  const provider = createProvider({ chainId: scope.chainId, rpcUrl: rpc });
  const endpoint = redactSubgraphUrl(rpc ?? network.resolvedRpc);
  if (!endpoint) throw new Error('RPC endpoint is unavailable');
  const rpcSource = { ...host.source, endpoint, indexed: false, method: 'email-recovery-rpc' };
  const freshness = { now: Math.floor(Date.now() / 1000), maxAgeSeconds: 120 };
  const proof = await readPendingEmailRecovery({ scope, legacy: input.legacy, rawCredentialBytes: input.rawCredentialBytes,
    originalTransactionHash: input.originalTransactionHash, source: host.source, rpcSource,
    query: host.protocolQuery, provider, freshness });
  if (proof.status !== 'ready') return { verification: proof };
  if (input.migrate !== true) return { verification: proof };
  const migration = migratePendingEmailCredential({ scope, legacy: input.legacy, legacyRecordId: input.legacyRecordId,
    proof: proof.data, freshness: { ...freshness, now: Math.floor(Date.now() / 1000) },
    hasUnresolvedSubmission: input.hasUnresolvedSubmission, existing: input.existing });
  return { verification: proof, migration };
}
export const recoverHandler = {
  builder: (yargs: Argv) => yargs
    .option('file', { type: 'string', demandOption: true, describe: 'JSON original transaction hash, public legacy credential, raw credential bytes and exact chain/org/target/registry/factory/account scope' })
    .epilogue('Read-only exact-hash recovery. Optional migrate:true prepares a recovery-only pointer record in stdout, preserving the legacy record. It requires hasUnresolvedSubmission:false; credential authentication remains external.'),
  handler: async (argv: ArgumentsCamelCase<{ file: string; rpc?: string }>) => {
    try { output.json(await recoverPendingEmail(readPreparedInput(argv.file), argv.rpc)); }
    catch (err: any) { output.error(err?.message || String(err)); process.exit(EXIT.INFRA); }
  },
};
