/**
 * Governance wraps — the shared createProposal builder.
 *
 * Every governance-side change in POP (~10 CLI commands) broadcasts the SAME
 * method: `createProposal(titleBytes, descriptionHash, durationMinutes,
 * numOptions, batches, hatIds)` on a HybridVoting or DirectDemocracyVoting
 * module, where option 0's batch carries `[target, value, calldata][]` triples
 * that the Executor runs if option 0 wins.
 *
 * Encoding parity notes (verified against src/commands/vote/create.ts and
 * src/commands/vote/propose-quorum.ts):
 *   - title is encoded with stringToBytes (UTF-8 Uint8Array), NOT bytes32
 *   - each batch entry is the positional tuple [target, BigNumber(value), data]
 *   - a proposal with NO execution calls passes `batches: []` — the empty
 *     outer array, not [[], []] (vote create only builds per-option batches
 *     when --calls is given). Wrap commands always pass [option0Calls, []].
 *   - hatIds default to [] and must be BigNumbers/strings — real Hats IDs
 *     exceed 2^53 and are mangled by Number
 *
 * First consumers: vote create / propose-quorum / propose-config / classes
 * propose (tx/vote.ts), task perms propose-global, org set-metadata-admin,
 * project propose. Other agents import these from './governance'.
 */

import { ethers } from 'ethers';
import type { TxIntent } from './intent';
import { getAbi } from '../contracts';
import { stringToBytes } from '../encoding';

/** One execution call in an option batch: encoded as [target, value, calldata]. */
export interface ExecutionCall {
  target: string;
  value: ethers.BigNumberish;
  calldata: string;
}

export interface GovernanceWrapParams {
  /** Hybrid or DD voting module address (the proposal is created on it). */
  votingAddress: string;
  votingAbiName: 'HybridVotingNew' | 'DirectDemocracyVotingNew';
  /** Proposal title — encoded with stringToBytes. */
  title: string;
  /** bytes32 — ipfsCidToBytes32 of the pinned proposal metadata. */
  descriptionHash: string;
  durationMinutes: ethers.BigNumberish;
  /** 2 for yes/no wraps. */
  numOptions: number;
  /**
   * Option-indexed execution batches. CLI wraps use [option0Calls, []];
   * a call-free proposal uses [] (see module doc — the empty-array quirk).
   */
  batches: ExecutionCall[][];
  /** Restricted-voting hats; [] default. */
  hatIds?: ethers.BigNumberish[];
  orgId?: string;
  /** meta.action override (default 'create'). */
  action?: string;
  /** meta.domain override for non-vote consumers (default 'vote'). */
  domain?: string;
  summary?: Record<string, unknown>;
  /** meta.ipfs passthrough for builders that pinned the metadata themselves. */
  ipfs?: { cid: string; metadata: unknown };
}

/**
 * Level-1 pure builder for `createProposal` — port of the tx built by
 * `pop vote create` (src/commands/vote/create.ts) and shared verbatim by
 * every governance-wrap command (propose-quorum, propose-config, classes
 * propose, perms propose-global, set-metadata-admin, project propose).
 */
export function buildGovernanceProposal(p: GovernanceWrapParams): TxIntent {
  // [target, BigNumber(value), data] — same tuple construction as the CLI
  // (`c.value || '0'` handles undefined/empty values as zero).
  const batchTuples = p.batches.map(batch =>
    batch.map(call => [call.target, ethers.BigNumber.from(call.value || 0), call.calldata])
  );
  const hatIds = p.hatIds ?? [];

  return {
    to: p.votingAddress,
    abi: getAbi(p.votingAbiName),
    method: 'createProposal',
    args: [
      stringToBytes(p.title),
      p.descriptionHash,
      p.durationMinutes,
      p.numOptions,
      batchTuples,
      hatIds,
    ],
    meta: {
      domain: p.domain ?? 'vote',
      action: p.action ?? 'create',
      orgId: p.orgId,
      summary: p.summary,
      ...(p.ipfs ? { ipfs: p.ipfs } : {}),
    },
  };
}

/**
 * Encode one execution call for an option batch: calldata via the named ABI's
 * Interface (both voting ABIs and TaskManagerNew carry exactly one fragment
 * per method name, so this matches the CLI's inline-fragment encoding
 * byte-for-byte).
 */
export function encodeExecutorCall(
  abiName: string,
  target: string,
  method: string,
  args: unknown[],
  value?: ethers.BigNumberish
): ExecutionCall {
  const iface = new ethers.utils.Interface(getAbi(abiName));
  return {
    target,
    value: value ?? 0,
    calldata: iface.encodeFunctionData(method, args as any[]),
  };
}

/**
 * Extract the created proposal ID from parsed receipt logs — the CLI's
 * `result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal')`
 * shared by every createProposal site. Accepts any parsed-log shape
 * (ethers LogDescription[] / TxResult.logs).
 */
export function parseProposalCreatedLogs(
  logs: Array<{ name: string; args?: any }> | undefined | null
): string | undefined {
  const proposalEvent = (logs ?? []).find(
    l => l.name === 'NewProposal' || l.name === 'NewHatProposal'
  );
  return proposalEvent?.args?.id?.toString();
}
