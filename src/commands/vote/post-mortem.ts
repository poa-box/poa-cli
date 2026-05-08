/**
 * pop vote post-mortem — automated debug_traceTransaction walker.
 *
 * Given a tx hash, fetches the call-tree trace via debug_traceTransaction
 * with the callTracer, walks it depth-first, and pinpoints the root-cause
 * frame (first revert / OOG site) with a gas-budget meter at every depth.
 *
 * This is the post-mortem complement to `pop vote simulate --gas-limit`.
 * The simulator catches the failure class BEFORE the proposal is created;
 * post-mortem identifies it AFTER the announce tx has reverted on-chain.
 * Together they close the loop on the bridge-saga failure mode (proposals
 * #41/#49/#50/#52): UserOp callGasLimit + 63/64 gas forwarding starving
 * the BREAD.transferFrom -> ERC20Votes checkpoint write.
 *
 * Manual walk of debug_traceTransaction output took ~3 heartbeats during
 * the original diagnosis. This command compresses that to one CLI call.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveNetworkConfig } from '../../config/networks';
import { resolveOrgModules } from '../../lib/resolve';
import { query } from '../../lib/subgraph';
import * as output from '../../lib/output';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const HybridVotingAbi = require('../../abi/HybridVotingNew.json');

interface PostMortemArgs {
  tx?: string;
  proposal?: number;
  org?: string;
  chain?: number;
  rpc?: string;
}

/**
 * Raw shape returned by Geth/Erigon callTracer. Other tracers (4byteTracer,
 * prestateTracer, etc.) return different shapes — we deliberately only
 * support the one universally available on production EVM RPCs.
 */
interface RawCallFrame {
  type: string;       // CALL, STATICCALL, DELEGATECALL, CREATE, CREATE2, SELFDESTRUCT
  from: string;
  to?: string;
  value?: string;     // hex
  gas?: string;       // hex — gas allotted to this frame
  gasUsed?: string;   // hex — gas actually consumed by this frame
  input?: string;     // hex calldata
  output?: string;    // hex returndata
  error?: string;     // string error (e.g. "out of gas", "execution reverted")
  revertReason?: string;
  calls?: RawCallFrame[];
}

/**
 * Flat representation of a single call frame after DFS walk.
 * Numbers are kept as JS numbers because gas values fit safely in 53 bits.
 */
export interface FlatFrame {
  depth: number;
  type: string;
  from: string;
  to: string;
  selector: string;     // first 10 chars of input or '(none)'
  gas: number;          // gas allotted entering this frame
  gasUsed: number;      // gas consumed inside this frame
  err?: string;
  revertReason?: string;
  output?: string;
  /**
   * True if this frame is the deepest descendant on a failing branch — i.e.
   * the leaf where the actual failure occurred. Parents above just propagate
   * the CALL_REVERT upward and are not the "root cause".
   */
  isRootCause?: boolean;
}

function hexToInt(h: string | undefined): number {
  if (!h) return 0;
  // Empty string or '0x' guard.
  if (h === '0x' || h === '') return 0;
  return parseInt(h, 16);
}

/**
 * Depth-first walk of the raw trace into a flat frame list. Records depth
 * at each level so the renderer can indent. Pure function — no I/O.
 */
export function flattenTrace(root: RawCallFrame): FlatFrame[] {
  const out: FlatFrame[] = [];
  function walk(frame: RawCallFrame, depth: number): void {
    const input = frame.input || '0x';
    out.push({
      depth,
      type: frame.type,
      from: frame.from,
      to: frame.to || '(create)',
      selector: input.length >= 10 ? input.slice(0, 10) : '(none)',
      gas: hexToInt(frame.gas),
      gasUsed: hexToInt(frame.gasUsed),
      err: frame.error,
      revertReason: frame.revertReason,
      output: frame.output,
    });
    if (frame.calls) {
      for (const c of frame.calls) walk(c, depth + 1);
    }
  }
  walk(root, 0);
  return out;
}

/**
 * Identify the root-cause frame: deepest frame on a failing branch.
 *
 * Strategy: walk frames in order. Track the deepest frame whose `err` is
 * set. That deepest frame is the leaf of the failing branch — frames above
 * it in the call stack just propagate the revert. If multiple deepest
 * candidates exist at the same depth, prefer the LAST one (DFS ordering
 * means later siblings come after a successful earlier sibling).
 */
export function findRootCause(frames: FlatFrame[]): number | null {
  let bestIdx: number | null = null;
  let bestDepth = -1;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f.err) continue;
    if (f.depth > bestDepth) {
      bestDepth = f.depth;
      bestIdx = i;
    }
  }
  if (bestIdx !== null) frames[bestIdx].isRootCause = true;
  return bestIdx;
}

/**
 * Render the call tree as ANSI text. Indents by depth, shows a gas meter
 * (gas allotted -> gas used + percentage of allotted), highlights the
 * root cause in red. Frames whose gas usage is >= 99% of allotted get a
 * yellow "near-budget" tag — these are the OOG suspects.
 */
function renderTree(frames: FlatFrame[], rootCauseIdx: number | null): string {
  const lines: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const indent = '  '.repeat(f.depth);
    const target = f.to.slice(0, 10);
    const meter = f.gas > 0 ? `${f.gasUsed.toLocaleString()}/${f.gas.toLocaleString()}` : `${f.gasUsed.toLocaleString()}`;
    const pct = f.gas > 0 ? Math.round((f.gasUsed / f.gas) * 100) : 0;
    const nearBudget = f.gas > 0 && pct >= 99;

    let status: string;
    if (f.err) {
      // ANSI red
      status = `\x1b[31m✗ ${f.err}${f.revertReason ? ` (${f.revertReason})` : ''}\x1b[0m`;
    } else if (nearBudget) {
      // ANSI yellow
      status = `\x1b[33m⚠ near-budget (${pct}%)\x1b[0m`;
    } else {
      status = `\x1b[32m✓\x1b[0m`;
    }

    let line = `${indent}[d${f.depth}] ${f.type} ${target} ${f.selector} gas=${meter} ${status}`;
    if (i === rootCauseIdx) {
      // Red-bold the whole line for the root-cause frame.
      line = `\x1b[31;1m>> ROOT CAUSE >>\x1b[0m ${line}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * If the root cause is OOG, walk back up the parent chain and emit the
 * 63/64 gas-forwarding budget at each depth. This is what made the
 * proposal-#50 manual diagnosis hard: the root frame had 52K gas, but the
 * top-level UserOp said 300K — where did the rest go? The answer is the
 * 63/64 forwarding rule applied at every CALL boundary. This helper makes
 * that visible without mental arithmetic.
 */
function explainGasForwardingChain(frames: FlatFrame[], rootCauseIdx: number | null): string[] {
  if (rootCauseIdx === null) return [];
  const root = frames[rootCauseIdx];
  if (!root.err) return [];
  const isOog = /out of gas|outOfGas|gas/i.test(root.err);
  if (!isOog) return [];

  // Reconstruct ancestor chain by depth: for each depth d < rootDepth,
  // find the most recent frame at depth d that appears BEFORE rootCauseIdx
  // in DFS order. That's the parent at that depth.
  const chain: FlatFrame[] = [];
  for (let d = 0; d <= root.depth; d++) {
    let found: FlatFrame | null = null;
    for (let i = rootCauseIdx; i >= 0; i--) {
      if (frames[i].depth === d) { found = frames[i]; break; }
    }
    if (found) chain.push(found);
  }

  const lines: string[] = [];
  lines.push('');
  lines.push('\x1b[33m63/64 gas-forwarding chain (OOG class):\x1b[0m');
  for (const f of chain) {
    const indent = '  '.repeat(f.depth);
    lines.push(`${indent}d${f.depth}: gas allotted ${f.gas.toLocaleString()}, used ${f.gasUsed.toLocaleString()}`);
  }
  lines.push('');
  lines.push('\x1b[33mEach CALL boundary forwards at most 63/64 of remaining gas to the\x1b[0m');
  lines.push('\x1b[33mcallee. If the leaf needed more than its allotment, raise the\x1b[0m');
  lines.push('\x1b[33mtop-level callGasLimit (sponsored.ts minCallGas) or split the batch.\x1b[0m');
  lines.push('\x1b[33mThis is the failure mode that killed proposals #41/#49/#50/#52.\x1b[0m');
  return lines;
}

/**
 * Binary-search a JSON-RPC provider for the block whose timestamp is the
 * largest one ≤ targetTs. Uses ⌈log2(latestBlock)⌉ getBlock calls — ~25
 * round-trips on Gnosis, ~32 on Arbitrum, fast enough for an interactive
 * command. Replaces the previous fixed 5s/block constant which was correct
 * for Gnosis but wildly wrong for Arbitrum (~0.25s) and other L2s.
 *
 * Exported so other future commands (e.g. range-mode post-mortem,
 * historical event scanners) can reuse it without rebuilding the search.
 */
export async function findBlockByTimestamp(
  provider: ethers.providers.JsonRpcProvider,
  targetTs: number,
): Promise<number> {
  const latest = await provider.getBlock('latest');
  if (latest.timestamp <= targetTs) return latest.number;
  let lo = 0;
  let hi = latest.number;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const block = await provider.getBlock(mid);
    if (block.timestamp <= targetTs) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/**
 * Resolve a proposal ID to its announce tx hash by filtering the
 * HybridVoting `Winner` event log for that proposal. Uses the proposal's
 * endTimestamp from the subgraph plus a binary search on block.timestamp
 * to narrow the eth_getLogs window. Chain-agnostic — works on Gnosis,
 * Arbitrum, Optimism, Base, etc., without any per-chain block-time table.
 *
 * Returns the tx hash, or throws with a helpful message if the proposal
 * has no Winner event yet (i.e. has not been announced).
 */
async function resolveProposalAnnounceTx(
  proposalId: number,
  orgArg: string | undefined,
  chainOverride: number | undefined,
  rpcUrl: string,
): Promise<string> {
  const modules = await resolveOrgModules(orgArg as any, chainOverride);
  const hybridVotingAddr = modules.hybridVotingAddress;
  if (!hybridVotingAddr) {
    throw new Error('No HybridVoting contract found for this org');
  }

  // Fetch endTimestamp from the subgraph so we can narrow the eth_getLogs
  // window. A query for a specific proposalId is cheap.
  const PROP_QUERY = `
    query GetProposalEnd($votingId: String!, $proposalId: BigInt!) {
      proposals(where: { hybridVoting: $votingId, proposalId: $proposalId }) {
        proposalId
        endTimestamp
        wasExecuted
        executionFailed
      }
    }
  `;
  const r = await query<{ proposals: any[] }>(
    PROP_QUERY,
    { votingId: hybridVotingAddr.toLowerCase(), proposalId: String(proposalId) },
    chainOverride,
  );
  const prop = (r.proposals || [])[0];
  if (!prop) {
    throw new Error(`Proposal ${proposalId} not found in subgraph for hybrid voting ${hybridVotingAddr}`);
  }
  const endTs = parseInt(prop.endTimestamp);

  // Resolve a precise block range via binary search on block.timestamp.
  // Window: from endTimestamp - 5min (vote closing buffer) to endTimestamp + 7d
  // (announce can be days late if no agent ran announce-all promptly; the bridge
  // saga had multi-day gaps between end and successful re-announce). The binary
  // search is chain-agnostic — Gnosis, Arbitrum, Optimism, Base all just work
  // without a per-chain block-time constant.
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, chainOverride);
  const SEVEN_DAYS = 7 * 86400;
  const fromBlock = await findBlockByTimestamp(provider, endTs - 300);
  const toBlock = await findBlockByTimestamp(provider, endTs + SEVEN_DAYS);

  const contract = new ethers.Contract(hybridVotingAddr, HybridVotingAbi, provider);
  // Filter on the indexed `id` argument matching our proposal.
  const filter = contract.filters.Winner(proposalId);
  const events = await contract.queryFilter(filter, fromBlock, toBlock);
  if (events.length === 0) {
    throw new Error(
      `Proposal ${proposalId} has no Winner event in blocks ${fromBlock}..${toBlock} ` +
      `— has it ended and been finalized? (endTimestamp: ${endTs})`
    );
  }
  // First match wins (multiple Winner events for the same id should not exist).
  return events[0].transactionHash;
}

export const postMortemHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('tx', {
        type: 'string',
        describe: 'Transaction hash (0x-prefixed) to post-mortem.',
      })
      .option('proposal', {
        type: 'number',
        describe:
          'Proposal ID — auto-resolves the announce tx hash from the HybridVoting Winner event ' +
          'for any POP proposal that has been finalized. Mutually exclusive with --tx. Use --tx ' +
          'for non-POP txs (internal calls, third-party contracts, etc).',
      })
      .check(argv => {
        if (!argv.tx && argv.proposal == null) {
          throw new Error('Must supply --proposal N or --tx HASH');
        }
        if (argv.tx && argv.proposal != null) {
          throw new Error('Use --proposal OR --tx, not both');
        }
        return true;
      }),

  handler: async (argv: ArgumentsCamelCase<PostMortemArgs>) => {
    const networkConfig = resolveNetworkConfig(argv.chain);
    const rpcUrl = (argv.rpc as string) || networkConfig.resolvedRpc;
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, networkConfig.chainId);

    // Resolve --proposal to a tx hash if needed. The downstream trace
    // path is identical for both modes; this just supplies the input.
    let txHash: string;
    if (argv.proposal != null) {
      try {
        txHash = await resolveProposalAnnounceTx(argv.proposal, argv.org, argv.chain, rpcUrl);
      } catch (err: any) {
        output.error(err.message);
        process.exit(1);
      }
    } else {
      txHash = argv.tx as string;
    }

    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      output.error('Invalid tx hash. Expected 0x-prefixed 32-byte hex.');
      process.exit(1);
    }

    let raw: RawCallFrame;
    try {
      raw = await provider.send('debug_traceTransaction', [
        txHash,
        { tracer: 'callTracer' },
      ]);
    } catch (err: any) {
      const msg = err?.error?.message || err?.message || String(err);
      if (/method not found|method not supported|does not exist/i.test(msg)) {
        output.error(
          `RPC ${rpcUrl} does not support debug_traceTransaction.\n` +
          `  Try a node that does:\n` +
          `    Gnosis: https://rpc.gnosischain.com (public, supports callTracer)\n` +
          `    Generic: https://blastapi.io (free tier supports tracing)\n` +
          `    Generic: https://getblock.io (free tier supports tracing)\n` +
          `  Override with: pop vote post-mortem --tx <hash> --rpc <URL>`
        );
      } else {
        output.error(`debug_traceTransaction failed: ${msg}`);
      }
      process.exit(1);
    }

    if (!raw || typeof raw !== 'object') {
      output.error(`debug_traceTransaction returned no data for ${txHash}`);
      process.exit(1);
    }

    const frames = flattenTrace(raw);
    const rootIdx = findRootCause(frames);
    const success = rootIdx === null;
    const totalGasUsed = frames[0]?.gasUsed ?? 0;

    if (output.isJsonMode()) {
      output.json({
        proposalId: argv.proposal ?? null,
        txHash,
        success,
        totalGasUsed,
        rootCauseDepth: rootIdx !== null ? frames[rootIdx].depth : null,
        rootCauseSelector: rootIdx !== null ? frames[rootIdx].selector : null,
        rootCauseTarget: rootIdx !== null ? frames[rootIdx].to : null,
        rootCauseError: rootIdx !== null ? frames[rootIdx].err : null,
        frames: frames.map(f => ({
          depth: f.depth,
          type: f.type,
          target: f.to,
          selector: f.selector,
          gasAlloted: f.gas,
          gasUsed: f.gasUsed,
          err: f.err,
        })),
      });
      return;
    }

    console.log('');
    if (argv.proposal != null) {
      console.log(`Proposal: #${argv.proposal} → resolved to tx ${txHash}`);
    } else {
      console.log(`Tx: ${txHash}`);
    }
    console.log(`Total gas used: ${totalGasUsed.toLocaleString()}`);
    if (success) {
      console.log('\x1b[32m✓ Transaction succeeded — no failing frames.\x1b[0m');
    } else {
      const root = frames[rootIdx as number];
      console.log(`\x1b[31m✗ Transaction failed.\x1b[0m`);
      console.log(`  Root cause depth: d${root.depth}`);
      console.log(`  Root cause selector: ${root.selector} on ${root.to}`);
      console.log(`  Root cause error: ${root.err}${root.revertReason ? ` (${root.revertReason})` : ''}`);
    }
    console.log('');
    console.log(renderTree(frames, rootIdx));

    const oogChain = explainGasForwardingChain(frames, rootIdx);
    for (const line of oogChain) console.log(line);

    if (!success) process.exit(2);
  },
};
