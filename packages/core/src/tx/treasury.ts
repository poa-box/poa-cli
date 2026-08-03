/**
 * Treasury transaction builders — ports of `pop treasury *` write paths
 * (src/commands/treasury/).
 *
 * Direct writes (Level 1, PaymentManager / ERC20):
 *   buildApproveErc20 + buildPayErc20        — pop treasury deposit (two txs)
 *   buildClaimDistribution                   — pop treasury claim / claim-mine
 *   buildOptOut                              — pop treasury opt-out / opt-in
 *
 * Governance wraps (option-0 execution batch on HybridVoting, via ./governance):
 *   buildSendProposal                        — pop treasury send
 *   buildDistributionProposal                — pop treasury propose-distribution
 *   buildSwapProposal                        — pop treasury propose-swap
 *   buildSdaiProposal                        — pop treasury propose-sdai
 *   buildFinalizeDistributionProposal        — pop treasury propose-finalize
 *
 * Merkle machinery: the PT-proportional allocation + OZ StandardMerkleTree
 * logic that was DUPLICATED between compute-merkle.ts (builder) and
 * claim-mine.ts (reconstructor) lives here once, as pure functions.
 */

import { ethers } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import type { TxIntent } from './intent';
import { getAbi } from '../contracts';
import { buildGovernanceProposal, ExecutionCall } from './governance';
import type { PopContext } from '../context';
import { resolveOrgModules, requireModule } from '../reads/resolve';
import { resolvePayoutTokenInfo, fetchDistributionById } from '../reads/treasury';
import { buildProposalMetadata, serializeProposalMetadata } from '../metadata/proposal';
import type { ProposalMetadata } from '../metadata/proposal';
import { pinJson } from '../ipfs';
import { ipfsCidToBytes32 } from '../encoding';
import { requireAddress } from '../validation';
import { getTokenDecimals, resolveNetworkConfig } from '../chains';
import { formatToken } from '../format';
import { CliError, PreconditionError } from '../errors';
import { EXIT } from '../exit-codes';

// ---------------------------------------------------------------------------
// Inline ABI fragments — identical to the CLI's, so calldata is byte-for-byte
// ---------------------------------------------------------------------------

const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
const ERC20_APPROVE_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];
const CURVE_EXCHANGE_ABI = ['function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)'];
const PM_CREATE_DISTRIBUTION_ABI = [
  'function createDistribution(address payoutToken, uint256 amount, bytes32 merkleRoot, uint256 checkpointBlock) returns (uint256)',
];
const PM_WITHDRAW_ABI = ['function withdraw(address token, address to, uint256 amount)'];
const PM_FINALIZE_ABI = ['function finalizeDistribution(uint256 distributionId, uint256 minClaimPeriodBlocks)'];

/** Gnosis mainnet WXDAI/sDAI — the propose-sdai strategy is Gnosis-only. */
export const GNOSIS_CHAIN_ID = 100;
export const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
export const SDAI = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';

const WXDAI_IFACE = new ethers.utils.Interface([
  'function deposit() payable',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const SDAI_IFACE = new ethers.utils.Interface([
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
]);

// ---------------------------------------------------------------------------
// Level 1 — direct PaymentManager / ERC20 writes
// ---------------------------------------------------------------------------

export interface ApproveErc20Args {
  tokenAddress: string;
  spender: string;
  amountWei: ethers.BigNumberish;
  orgId?: string;
}

/**
 * Port of `pop treasury deposit` step 1 — src/commands/treasury/deposit.ts:
 * ERC20.approve(paymentManagerAddress, amountWei).
 */
export function buildApproveErc20(a: ApproveErc20Args): TxIntent {
  return {
    to: a.tokenAddress,
    abi: getAbi('ERC20'),
    method: 'approve',
    args: [a.spender, a.amountWei],
    meta: {
      domain: 'treasury',
      action: 'deposit-approve',
      orgId: a.orgId,
      summary: { token: a.tokenAddress, spender: a.spender, amountWei: String(a.amountWei) },
    },
  };
}

export interface PayErc20Args {
  paymentManagerAddress: string;
  tokenAddress: string;
  amountWei: ethers.BigNumberish;
  orgId?: string;
}

/**
 * Port of `pop treasury deposit` step 2 — src/commands/treasury/deposit.ts:
 * PaymentManager.payERC20(token, amountWei) (pulls via transferFrom, emits
 * PaymentReceived). DESTRUCTIVE for the depositor: withdrawing later requires
 * a governance vote.
 */
export function buildPayErc20(a: PayErc20Args): TxIntent {
  return {
    to: a.paymentManagerAddress,
    abi: getAbi('PaymentManager'),
    method: 'payERC20',
    args: [a.tokenAddress, a.amountWei],
    meta: {
      domain: 'treasury',
      action: 'deposit',
      orgId: a.orgId,
      summary: { token: a.tokenAddress, amountWei: String(a.amountWei) },
    },
  };
}

export interface ClaimDistributionArgs {
  paymentManagerAddress: string;
  distributionId: ethers.BigNumberish;
  amountWei: ethers.BigNumberish;
  /** bytes32[] merkle proof — must hash against the raw amount exactly. */
  proof: string[];
  orgId?: string;
}

/**
 * Port of `pop treasury claim` / `pop treasury claim-mine` —
 * src/commands/treasury/claim.ts, claim-mine.ts:
 * PaymentManager.claimDistribution(distId, amountWei, proof).
 *
 * Host-side revert predictors the CLI runs before this (deliberately NOT in
 * the builder — they need a provider and gate broadcasting, not encoding):
 * finalized, hasClaimed(dist, addr), isOptedOut(addr). Opt-out BLOCKS on the
 * deployed PaymentManager (pre-L-19 vintage still reverts OptedOut).
 */
export function buildClaimDistribution(a: ClaimDistributionArgs): TxIntent {
  return {
    to: a.paymentManagerAddress,
    abi: getAbi('PaymentManager'),
    method: 'claimDistribution',
    args: [a.distributionId, a.amountWei, a.proof],
    meta: {
      domain: 'treasury',
      action: 'claim',
      orgId: a.orgId,
      summary: { distributionId: String(a.distributionId), amountWei: String(a.amountWei) },
    },
  };
}

export interface OptOutArgs {
  paymentManagerAddress: string;
  /** true = opt out of distributions, false = opt back in. */
  optOut: boolean;
  orgId?: string;
}

/**
 * Port of `pop treasury opt-out` / `pop treasury opt-in` —
 * src/commands/treasury/opt-out.ts: PaymentManager.optOut(bool).
 * Permissionless and idempotent; the CLI's no-op short-circuit reads
 * isOptedOut over RPC (deliberately never the subgraph — the OptOutToggle
 * table is empty on every live deployment AND the read gates a write).
 */
export function buildOptOut(a: OptOutArgs): TxIntent {
  return {
    to: a.paymentManagerAddress,
    abi: getAbi('PaymentManager'),
    method: 'optOut',
    args: [a.optOut],
    meta: {
      domain: 'treasury',
      action: a.optOut ? 'opt-out' : 'opt-in',
      orgId: a.orgId,
      summary: { optedOut: a.optOut },
    },
  };
}

// ---------------------------------------------------------------------------
// Pure input parsing (ports of the CLI's exported validators)
// ---------------------------------------------------------------------------

export interface TreasuryRecipient {
  to: string;
  amount: number;
}

/**
 * Parse recipients into a validated list (max 8 — the Executor batch cap).
 * Port of parseRecipients in src/commands/treasury/send.ts; accepts the
 * already-parsed array or the CLI's raw --recipients JSON string.
 */
export function parseRecipients(input: {
  to?: string;
  amount?: number;
  recipients?: string | Array<{ to: string; amount: number }>;
}): TreasuryRecipient[] {
  let recipientList: Array<{ to: string; amount: number }>;
  if (input.recipients) {
    if (typeof input.recipients === 'string') {
      try {
        recipientList = JSON.parse(input.recipients);
        if (!Array.isArray(recipientList) || recipientList.length === 0) throw new Error('empty array');
      } catch (e: any) {
        throw new CliError(
          `--recipients must be a JSON array: [{"to":"0x...","amount":5},...]. ${e.message}`,
          EXIT.USAGE
        );
      }
    } else {
      recipientList = input.recipients;
      if (!Array.isArray(recipientList) || recipientList.length === 0) {
        throw new CliError(
          '--recipients must be a JSON array: [{"to":"0x...","amount":5},...]. empty array',
          EXIT.USAGE
        );
      }
    }
    if (recipientList.length > 8) {
      throw new CliError('The Executor supports at most 8 calls per batch — split into multiple proposals.', EXIT.USAGE);
    }
  } else if (input.to && input.amount) {
    recipientList = [{ to: input.to, amount: input.amount }];
  } else {
    throw new CliError('Provide either --to + --amount, or --recipients for a batch send.', EXIT.USAGE);
  }

  return recipientList.map((r, i) => {
    const to = requireAddress(r.to, `recipients[${i}].to`);
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new CliError(`Recipient ${to}: amount must be a positive number, got "${r.amount}".`, EXIT.USAGE);
    }
    return { to, amount };
  });
}

/**
 * Validate a merkle proof array — port of the shape check in parseProof
 * (src/commands/treasury/claim.ts), minus the fs half. Accepts the array or
 * the CLI's inline JSON string; the allocation-object form ({ proof: [...] })
 * is unwrapped like the CLI's --proof-file path.
 */
export function parseProof(input: string | string[] | { proof: string[] }): string[] {
  let raw: any = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new CliError('--proof must be a JSON array of bytes32 hex strings.', EXIT.USAGE);
    }
  }
  if (raw && !Array.isArray(raw) && Array.isArray(raw.proof)) raw = raw.proof; // allocation-object form

  if (!Array.isArray(raw) || raw.some((p: any) => typeof p !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(p))) {
    throw new CliError(
      'The merkle proof must be a JSON array of bytes32 hex strings.',
      EXIT.USAGE,
      'Each entry looks like 0x followed by 64 hex characters (see merkle-distribution.json from compute-merkle).'
    );
  }
  return raw;
}

/**
 * Convert an amount to the raw claim value: decimal token units, or raw wei
 * with `wei`. Port of parseClaimAmount in src/commands/treasury/claim.ts.
 * The merkle leaf hashes the raw amount, so exactness matters.
 */
export function parseClaimAmount(amount: string, wei: boolean, decimals: number): ethers.BigNumber {
  const trimmed = String(amount).trim();
  if (wei) {
    if (!/^\d+$/.test(trimmed)) {
      throw new CliError(`--wei expects a raw integer amount, got "${amount}".`, EXIT.USAGE, 'Drop --wei to pass decimal token units instead.');
    }
    return ethers.BigNumber.from(trimmed);
  }
  try {
    return ethers.utils.parseUnits(trimmed, decimals);
  } catch {
    throw new CliError(
      `Invalid --amount "${amount}" for a token with ${decimals} decimals.`,
      EXIT.USAGE,
      'Pass a decimal token amount (e.g. 12.5), or the exact raw integer with --wei.'
    );
  }
}

// ---------------------------------------------------------------------------
// Merkle distribution machinery (pure — the shared copy of compute-merkle /
// claim-mine's duplicated allocation + tree logic)
// ---------------------------------------------------------------------------

/**
 * Merkle tree — OpenZeppelin StandardMerkleTree, matching PaymentManager on-chain.
 *
 * PaymentManager.claim recomputes the leaf as
 *   keccak256(bytes.concat(keccak256(abi.encode(msg.sender, claimAmount))))
 * and verifies it with OZ `MerkleProof.verify`, so the tree must be built exactly the way the
 * OZ library builds it.
 *
 * The CLI previously used a hand-rolled tree that paired leaves left-to-right per layer and
 * promoted an odd trailing leaf unchanged. That agrees with OZ for 1, 2, 3, 4, 6 and 8 leaves
 * but DIVERGES at 5 and 7 (OZ builds a complete 2n-1 tree and pairs by node index). For an org
 * with 5 or 7 members the computed root and proofs were rejected by MerkleProof.verify, so a
 * distribution created from them could never be claimed. Pinned by
 * test/commands/treasury-compute-merkle.test.ts. This module is the single copy that ends the
 * builder/reconstructor drift class of bug.
 */

export interface DistributionMemberInput {
  address: string;
  /** 18-decimal wei string (subgraph participationTokenBalance). */
  participationTokenBalance: string;
  membershipStatus: string;
  username?: string | null;
}

export interface DistributionAllocation {
  /** EIP-55 checksummed. */
  address: string;
  username: string | null;
  ptBalance: ethers.BigNumber;
  /** Raw allocation in payout-token wei. */
  amount: ethers.BigNumber;
}

/**
 * PT-proportional allocations — the shared rule of compute-merkle.ts (builder)
 * and claim-mine.ts (reconstructor):
 *   - eligible = membershipStatus 'Active' AND PT > 0 AND not opted out
 *   - allocation = totalAmount * memberPT / eligiblePT
 *   - rounding dust goes to the FIRST member — callers must pass members
 *     ordered by PT balance desc (both member queries do), so that is the
 *     largest holder.
 *
 * Throws with the CLI's messages when no one is eligible.
 */
export function computeDistributionAllocations(
  members: DistributionMemberInput[],
  totalAmountWei: ethers.BigNumberish,
  optedOut: Set<string> = new Set()
): DistributionAllocation[] {
  const totalAmount = ethers.BigNumber.from(totalAmountWei);

  const ptHolders = members.filter((u) =>
    u.membershipStatus === 'Active' &&
    ethers.BigNumber.from(u.participationTokenBalance).gt(0)
  );
  if (ptHolders.length === 0) {
    throw new Error('No active members with PT balance');
  }

  const activeMembers = ptHolders.filter(
    (m) => !optedOut.has(String(m.address).toLowerCase())
  );
  if (activeMembers.length === 0) {
    throw new Error(
      optedOut.size > 0
        ? `All ${ptHolders.length} PT-holding member(s) have opted out of payouts.`
        : 'No active members with PT balance'
    );
  }

  // Sum PT of eligible members (may differ from totalSupply if some are inactive)
  const eligiblePT = activeMembers.reduce(
    (sum, m) => sum.add(ethers.BigNumber.from(m.participationTokenBalance)),
    ethers.BigNumber.from(0)
  );

  const allocations: DistributionAllocation[] = activeMembers.map((m) => {
    const ptBal = ethers.BigNumber.from(m.participationTokenBalance);
    return {
      address: ethers.utils.getAddress(m.address),
      username: m.username ?? null,
      ptBalance: ptBal,
      // Pro-rata: allocation = totalAmount * memberPT / eligiblePT
      amount: totalAmount.mul(ptBal).div(eligiblePT),
    };
  });

  // Handle rounding dust — give remainder to largest holder (index 0).
  const allocatedTotal = allocations.reduce(
    (sum, a) => sum.add(a.amount),
    ethers.BigNumber.from(0)
  );
  const dust = totalAmount.sub(allocatedTotal);
  if (dust.gt(0) && allocations.length > 0) {
    allocations[0] = { ...allocations[0], amount: allocations[0].amount.add(dust) };
  }

  return allocations;
}

/**
 * Build the OZ StandardMerkleTree over ['address', 'uint256'] leaves —
 * exactly what compute-merkle.ts commits and claim-mine.ts reconstructs.
 * StandardMerkleTree hashes each value pair itself (double-keccak over
 * abi.encode) and sorts leaves internally, so proofs are looked up by the
 * ORIGINAL value, not by index.
 */
export function buildDistributionTree(
  allocations: Array<Pick<DistributionAllocation, 'address' | 'amount'>>
): StandardMerkleTree<[string, string]> {
  return StandardMerkleTree.of(
    allocations.map((a) => [a.address, a.amount.toString()] as [string, string]),
    ['address', 'uint256']
  );
}

/** Proof for one allocation — looked up by VALUE (OZ sorts leaves internally). */
export function getAllocationProof(
  tree: StandardMerkleTree<[string, string]>,
  allocation: Pick<DistributionAllocation, 'address' | 'amount'>
): string[] {
  return tree.getProof([allocation.address, allocation.amount.toString()]);
}

// ---------------------------------------------------------------------------
// Level 1 — governance wraps (createProposal via ./governance)
// ---------------------------------------------------------------------------

export interface SendProposalArgs {
  hybridVotingAddress: string;
  /** Validated via parseRecipients (max 8). */
  recipients: TreasuryRecipient[];
  /** null for the chain's native token. */
  tokenAddress: string | null;
  /** 18 for native; getTokenDecimals(token) otherwise — as the CLI does. */
  decimals: number;
  /** Native currency symbol for native sends, the token address otherwise. */
  tokenLabel: string;
  /** bytes32 — ipfsCidToBytes32 of the pinned proposal metadata. */
  descriptionHash: string;
  durationMinutes: ethers.BigNumberish;
  orgId?: string;
  ipfs?: { cid: string; metadata: unknown };
}

/**
 * Port of `pop treasury send` — src/commands/treasury/send.ts.
 * HybridVoting.createProposal wrapping an option-0 batch of at most 8 calls:
 * native transfers as [to, amountWei, '0x'], ERC20 as
 * [token, 0, transfer(to, amountWei)]. Option 1 is a no-op.
 */
export function buildSendProposal(a: SendProposalArgs): TxIntent {
  const isNative = a.tokenAddress == null;
  const iface = new ethers.utils.Interface(ERC20_TRANSFER_ABI);

  const calls: ExecutionCall[] = [];
  let totalAmount = 0;
  for (const r of a.recipients) {
    const amountWei = ethers.utils.parseUnits(r.amount.toString(), a.decimals);
    totalAmount += r.amount;
    if (isNative) {
      calls.push({ target: r.to, value: amountWei, calldata: '0x' });
    } else {
      calls.push({
        target: a.tokenAddress as string,
        value: ethers.BigNumber.from(0),
        calldata: iface.encodeFunctionData('transfer', [r.to, amountWei]),
      });
    }
  }

  return buildGovernanceProposal({
    votingAddress: a.hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    title: `Send ${totalAmount} ${a.tokenLabel} to ${a.recipients.length} recipient(s)`,
    descriptionHash: a.descriptionHash,
    durationMinutes: a.durationMinutes,
    numOptions: 2,
    batches: [calls, []], // option 0 = send, option 1 = no-op
    hatIds: [],
    domain: 'treasury',
    action: 'send',
    orgId: a.orgId,
    summary: {
      totalAmount: totalAmount.toString(),
      token: a.tokenLabel,
      recipients: a.recipients.length,
    },
    ipfs: a.ipfs,
  });
}

export interface DistributionProposalArgs {
  hybridVotingAddress: string;
  paymentManagerAddress: string;
  /** As committed in merkle-distribution.json — passed through verbatim. */
  tokenAddress: string;
  totalAmountWei: ethers.BigNumberish;
  merkleRoot: string;
  checkpointBlock: ethers.BigNumberish;
  memberCount: number;
  /** formatUnits(totalAmountWei, payout decimals) — drives the title text. */
  totalHuman: string;
  descriptionHash: string;
  durationMinutes: ethers.BigNumberish;
  orgId?: string;
  ipfs?: { cid: string; metadata: unknown };
}

/**
 * Port of `pop treasury propose-distribution` —
 * src/commands/treasury/propose-distribution.ts. HybridVoting.createProposal
 * wrapping PaymentManager.createDistribution(payoutToken, amount, merkleRoot,
 * checkpointBlock) — an executor-only call, hence the governance wrap.
 * createDistribution reverts InsufficientFunds at EXECUTION time if the
 * PaymentManager's balance can't cover total committed + this amount.
 */
export function buildDistributionProposal(a: DistributionProposalArgs): TxIntent {
  const pmIface = new ethers.utils.Interface(PM_CREATE_DISTRIBUTION_ABI);
  const createDistData = pmIface.encodeFunctionData('createDistribution', [
    a.tokenAddress,
    a.totalAmountWei,
    a.merkleRoot,
    a.checkpointBlock,
  ]);

  const calls: ExecutionCall[] = [
    { target: a.paymentManagerAddress, value: ethers.BigNumber.from(0), calldata: createDistData },
  ];

  return buildGovernanceProposal({
    votingAddress: a.hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    title: `Distribute ${a.totalHuman} tokens to ${a.memberCount} members`,
    descriptionHash: a.descriptionHash,
    durationMinutes: a.durationMinutes,
    numOptions: 2,
    batches: [calls, []], // option 0 = distribute, option 1 = no-op
    hatIds: [],
    domain: 'treasury',
    action: 'propose-distribution',
    orgId: a.orgId,
    summary: {
      tokenAddress: a.tokenAddress,
      totalAmountWei: String(a.totalAmountWei),
      merkleRoot: a.merkleRoot,
      checkpointBlock: String(a.checkpointBlock),
      memberCount: a.memberCount,
    },
    ipfs: a.ipfs,
  });
}

export interface SwapProposalArgs {
  hybridVotingAddress: string;
  paymentManagerAddress: string;
  /** Receives the withdrawn tokens and the swap output. */
  executorAddress: string;
  fromToken: string;
  poolAddress: string;
  fromIndex: number;
  toIndex: number;
  /** In from-token wei. */
  amountWei: ethers.BigNumberish;
  /** In to-token wei — min_dy slippage guard at execution time. */
  minOut: ethers.BigNumberish;
  /** The human --amount figure — drives the title text. */
  amountLabel: string | number;
  descriptionHash: string;
  durationMinutes: ethers.BigNumberish;
  orgId?: string;
  ipfs?: { cid: string; metadata: unknown };
}

/**
 * Port of `pop treasury propose-swap` — src/commands/treasury/propose-swap.ts.
 * HybridVoting.createProposal wrapping THREE option-0 calls:
 *   1. PaymentManager.withdraw(fromToken, executor, amountWei)  (executor-only)
 *   2. ERC20.approve(pool, amountWei)
 *   3. CurvePool.exchange(int128 i, int128 j, dx, min_dy)
 */
export function buildSwapProposal(a: SwapProposalArgs): TxIntent {
  const withdrawIface = new ethers.utils.Interface(PM_WITHDRAW_ABI);
  const erc20Iface = new ethers.utils.Interface(ERC20_APPROVE_ABI);
  const curveIface = new ethers.utils.Interface(CURVE_EXCHANGE_ABI);

  const calls: ExecutionCall[] = [
    {
      target: a.paymentManagerAddress,
      value: ethers.BigNumber.from(0),
      calldata: withdrawIface.encodeFunctionData('withdraw', [a.fromToken, a.executorAddress, a.amountWei]),
    },
    {
      target: a.fromToken,
      value: ethers.BigNumber.from(0),
      calldata: erc20Iface.encodeFunctionData('approve', [a.poolAddress, a.amountWei]),
    },
    {
      target: a.poolAddress,
      value: ethers.BigNumber.from(0),
      calldata: curveIface.encodeFunctionData('exchange', [a.fromIndex, a.toIndex, a.amountWei, a.minOut]),
    },
  ];

  return buildGovernanceProposal({
    votingAddress: a.hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    title: `Treasury swap: ${a.amountLabel} tokens via Curve`,
    descriptionHash: a.descriptionHash,
    durationMinutes: a.durationMinutes,
    numOptions: 2,
    batches: [calls, []], // option 0 = swap, option 1 = no-op
    hatIds: [],
    domain: 'treasury',
    action: 'propose-swap',
    orgId: a.orgId,
    summary: {
      fromToken: a.fromToken,
      pool: a.poolAddress,
      amountWei: String(a.amountWei),
      minOut: String(a.minOut),
    },
    ipfs: a.ipfs,
  });
}

export interface SdaiProposalArgs {
  hybridVotingAddress: string;
  /** Receives the sDAI shares. */
  executorAddress: string;
  /** In xDAI wei (parseEther of the human amount). */
  amountWei: ethers.BigNumberish;
  /** The human --amount figure — drives the title text. */
  amountLabel: string | number;
  descriptionHash: string;
  durationMinutes: ethers.BigNumberish;
  orgId?: string;
  ipfs?: { cid: string; metadata: unknown };
}

/**
 * Port of `pop treasury propose-sdai` — src/commands/treasury/propose-sdai.ts.
 * Gnosis-only (the WXDAI/SDAI constants are Gnosis mainnet deployments) —
 * callers must enforce chainId === 100 (the Level-2 builder does).
 * Option 0 executes three calls from the Executor:
 *   1. [WXDAI, amountWei, deposit()]           (wraps the Executor's xDAI)
 *   2. [WXDAI, 0, approve(SDAI, amountWei)]
 *   3. [SDAI, 0, deposit(amountWei, executor)]
 */
export function buildSdaiProposal(a: SdaiProposalArgs): TxIntent {
  const calls: ExecutionCall[] = [
    { target: WXDAI, value: a.amountWei, calldata: WXDAI_IFACE.encodeFunctionData('deposit', []) },
    { target: WXDAI, value: ethers.BigNumber.from(0), calldata: WXDAI_IFACE.encodeFunctionData('approve', [SDAI, a.amountWei]) },
    { target: SDAI, value: ethers.BigNumber.from(0), calldata: SDAI_IFACE.encodeFunctionData('deposit', [a.amountWei, a.executorAddress]) },
  ];

  return buildGovernanceProposal({
    votingAddress: a.hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    title: `Deposit ${a.amountLabel} xDAI into sDAI for yield`,
    descriptionHash: a.descriptionHash,
    durationMinutes: a.durationMinutes,
    numOptions: 2,
    batches: [calls, []], // option 0 = deposit, option 1 = keep liquid
    hatIds: [],
    domain: 'treasury',
    action: 'propose-sdai',
    orgId: a.orgId,
    summary: { amountWei: String(a.amountWei), executor: a.executorAddress },
    ipfs: a.ipfs,
  });
}

export interface FinalizeDistributionProposalArgs {
  hybridVotingAddress: string;
  paymentManagerAddress: string;
  distributionId: number;
  /**
   * On-chain guard: execution reverts ClaimPeriodNotExpired until this many
   * blocks have passed since the distribution's CHECKPOINT block — the
   * DEPLOYED contract's anchor, proven by live eth_call (audit M-08's
   * creation-block re-anchor is NOT deployed; see propose-finalize.ts).
   */
  minClaimPeriodBlocks: number;
  descriptionHash: string;
  durationMinutes: ethers.BigNumberish;
  orgId?: string;
  ipfs?: { cid: string; metadata: unknown };
}

/**
 * Port of `pop treasury propose-finalize` —
 * src/commands/treasury/propose-finalize.ts. HybridVoting.createProposal
 * wrapping PaymentManager.finalizeDistribution(distId, minClaimPeriodBlocks)
 * (onlyOwner = the Executor, hence the wrap). On success the unclaimed
 * remainder returns to the Executor treasury and further claims are blocked.
 */
export function buildFinalizeDistributionProposal(a: FinalizeDistributionProposalArgs): TxIntent {
  const pmIface = new ethers.utils.Interface(PM_FINALIZE_ABI);
  const finalizeCall = pmIface.encodeFunctionData('finalizeDistribution', [a.distributionId, a.minClaimPeriodBlocks]);

  const calls: ExecutionCall[] = [
    { target: a.paymentManagerAddress, value: ethers.BigNumber.from(0), calldata: finalizeCall },
  ];

  return buildGovernanceProposal({
    votingAddress: a.hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    title: `Finalize distribution #${a.distributionId}`,
    descriptionHash: a.descriptionHash,
    durationMinutes: a.durationMinutes,
    numOptions: 2,
    batches: [calls, []], // option 0: finalize; option 1: keep open
    hatIds: [],
    domain: 'treasury',
    action: 'propose-finalize',
    orgId: a.orgId,
    summary: { distributionId: a.distributionId, minClaimPeriodBlocks: a.minClaimPeriodBlocks },
    ipfs: a.ipfs,
  });
}

// ---------------------------------------------------------------------------
// Level 2 — resolved builders
// ---------------------------------------------------------------------------

async function pinProposalMetadata(
  ctx: PopContext,
  metadata: ProposalMetadata
): Promise<{ cid: string; descriptionHash: string }> {
  const cid = await pinJson(serializeProposalMetadata(metadata), ctx.ipfs);
  return { cid, descriptionHash: ipfsCidToBytes32(cid) };
}

export interface SendProposalParams {
  org: string;
  to?: string;
  amount?: number;
  recipients?: string | Array<{ to: string; amount: number }>;
  /** Token address or 'native' (default) for the chain's gas token. */
  token?: string;
  /** Vote duration in minutes (CLI default 60). */
  durationMinutes?: number;
}

/**
 * Resolved port of `pop treasury send` — src/commands/treasury/send.ts.
 * Resolves the org's HybridVoting, derives token label/decimals, pins the
 * proposal metadata {description, optionNames, createdAt}, and delegates to
 * buildSendProposal.
 */
export async function sendProposalIntent(ctx: PopContext, params: SendProposalParams): Promise<TxIntent> {
  const token = params.token ?? 'native';
  const isNative = token === 'native';
  const tokenAddr = isNative ? null : requireAddress(token, 'token');
  const recipientList = parseRecipients(params);
  const durationMinutes = params.durationMinutes ?? 60;

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const hybridVotingAddr = modules.hybridVotingAddress;
  if (!hybridVotingAddr) {
    throw new PreconditionError('HybridVoting not deployed for this org — cannot create a governance proposal.');
  }

  const network = resolveNetworkConfig(ctx.chainId, ctx.env);
  const tokenLabel = isNative
    ? (network?.nativeCurrency?.symbol ?? 'native')
    : (tokenAddr as string);
  const decimals = isNative ? 18 : getTokenDecimals(tokenAddr as string);

  const totalAmount = recipientList.reduce((sum, r) => sum + r.amount, 0);
  const recipientSummary = recipientList.map(r => `${r.amount} ${tokenLabel} → ${r.to.slice(0, 10)}...`).join(', ');
  const metadata = buildProposalMetadata({
    description: `Transfer ${totalAmount} ${tokenLabel} from Executor: ${recipientSummary}. ${recipientList.length} recipient(s).`,
    optionNames: [`Send ${totalAmount} ${tokenLabel} (${recipientList.length} recipients)`, 'Do not send'],
  });
  const { cid, descriptionHash } = await pinProposalMetadata(ctx, metadata);

  return buildSendProposal({
    hybridVotingAddress: hybridVotingAddr,
    recipients: recipientList,
    tokenAddress: tokenAddr,
    decimals,
    tokenLabel,
    descriptionHash,
    durationMinutes,
    orgId: modules.orgId,
    ipfs: { cid, metadata },
  });
}

/** Parsed merkle-distribution.json contents (compute-merkle output). */
export interface MerkleDistributionData {
  merkleRoot: string;
  /** Raw wei string. */
  totalAmount: string;
  tokenAddress: string;
  checkpointBlock: number | string;
  memberCount: number;
  allocations?: Array<{ address: string; username?: string | null; share?: string }>;
}

export interface ProposeDistributionParams {
  org: string;
  /** Parsed merkle-distribution.json (the CLI reads it from --merkle-file). */
  merkle: MerkleDistributionData;
  /** Vote duration in minutes (CLI default 1440). */
  durationMinutes?: number;
}

/**
 * Resolved port of `pop treasury propose-distribution` —
 * src/commands/treasury/propose-distribution.ts. Takes the parsed
 * merkle-distribution.json (file I/O stays in the host), resolves modules and
 * payout-token decimals, pins the metadata and delegates to
 * buildDistributionProposal. The CLI's PaymentManager-balance check is an
 * advisory warning only (InsufficientFunds fires at execution time) and is
 * not ported.
 */
export async function proposeDistributionIntent(
  ctx: PopContext,
  params: ProposeDistributionParams
): Promise<TxIntent> {
  const { merkleRoot, totalAmount, tokenAddress, checkpointBlock, memberCount, allocations } = params.merkle ?? ({} as MerkleDistributionData);
  if (!merkleRoot || !totalAmount || !tokenAddress || !checkpointBlock) {
    throw new CliError(
      'Invalid merkle file — missing required fields (merkleRoot, totalAmount, tokenAddress, checkpointBlock).',
      EXIT.USAGE,
      'Regenerate it with: pop treasury compute-merkle'
    );
  }
  const durationMinutes = params.durationMinutes ?? 1440;

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const paymentManagerAddr = requireModule(modules, 'paymentManagerAddress');
  const hybridVotingAddr = modules.hybridVotingAddress;
  if (!hybridVotingAddr) {
    throw new PreconditionError('HybridVoting not deployed for this org — cannot create a governance proposal.');
  }

  const amountWei = ethers.BigNumber.from(totalAmount);
  const token = await resolvePayoutTokenInfo(ctx.provider, tokenAddress, ctx.chainId);
  const totalHuman = ethers.utils.formatUnits(amountWei, token.decimals);

  // Build allocation summary for proposal description
  const allocationSummary = (allocations ?? [])
    .map((a) => `${a.username || a.address.slice(0, 10) + '...'} (${a.share})`)
    .join(', ');

  const metadata = buildProposalMetadata({
    description: `Create distribution of ${totalHuman} tokens to ${memberCount} members proportional to PT holdings. Allocations: ${allocationSummary}. Merkle root: ${merkleRoot}. Checkpoint block: ${checkpointBlock}.`,
    optionNames: [`Distribute ${totalHuman} tokens`, 'Do not distribute'],
  });
  const { cid, descriptionHash } = await pinProposalMetadata(ctx, metadata);

  return buildDistributionProposal({
    hybridVotingAddress: hybridVotingAddr,
    paymentManagerAddress: paymentManagerAddr,
    tokenAddress,
    totalAmountWei: amountWei,
    merkleRoot,
    checkpointBlock,
    memberCount,
    totalHuman,
    descriptionHash,
    durationMinutes,
    orgId: modules.orgId,
    ipfs: { cid, metadata },
  });
}

export interface ProposeSwapParams {
  org: string;
  fromToken: string;
  toToken: string;
  /** Human units of from-token. */
  amount: number;
  /** Minimum output in to-token units (default: 95% of the pool quote). */
  minOut?: number;
  pool: string;
  fromIndex: number;
  toIndex: number;
  /** Vote duration in minutes (CLI default 1440). */
  durationMinutes?: number;
}

/**
 * Resolved port of `pop treasury propose-swap` —
 * src/commands/treasury/propose-swap.ts. Decimals come from the static
 * known-token table only (no live read — same as the CLI); the pool quote
 * (get_dy) requires ctx.provider and falls back exactly like the CLI when
 * unavailable WITH a provider present: min_dy defaults to 95% of the quote,
 * or 95% of the input when get_dy reverted — the CLI's exact fallback ladder.
 * With NO provider and no explicit minOut this refuses instead: the CLI can
 * never reach that state (it always has a provider), and silently deriving
 * min_dy from the INPUT amount across a decimals mismatch would let a
 * governance swap execute at a catastrophic rate.
 */
export async function proposeSwapIntent(ctx: PopContext, params: ProposeSwapParams): Promise<TxIntent> {
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new CliError(`--amount must be a positive number, got "${params.amount}".`, EXIT.USAGE);
  }
  const fromToken = requireAddress(params.fromToken, 'from-token');
  const toToken = requireAddress(params.toToken, 'to-token');
  const poolAddr = requireAddress(params.pool, 'pool');
  const durationMinutes = params.durationMinutes ?? 1440;

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const executorAddr = requireModule(modules, 'executorAddress');
  const pmAddr = requireModule(modules, 'paymentManagerAddress');
  const hybridVotingAddr = modules.hybridVotingAddress;
  if (!hybridVotingAddr) {
    throw new PreconditionError('HybridVoting not deployed for this org — cannot create a governance proposal.');
  }

  const fromDecimals = getTokenDecimals(fromToken);
  const toDecimals = getTokenDecimals(toToken);
  const amountWei = ethers.utils.parseUnits(params.amount.toString(), fromDecimals);

  // Get a quote from the pool (RPC; quote unavailable → CLI's fallback path).
  let expectedOut: ethers.BigNumber | null = null;
  if (ctx.provider) {
    try {
      const poolContract = new ethers.Contract(poolAddr, [
        'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
      ], ctx.provider);
      expectedOut = await poolContract.get_dy(params.fromIndex, params.toIndex, amountWei);
    } catch {
      expectedOut = null; // quote unavailable — fall back below
    }
  }

  if (params.minOut === undefined && !ctx.provider) {
    throw new PreconditionError(
      'proposeSwapIntent needs a pool quote to derive min_dy safely — supply ctx.provider (get_dy read) or pass minOut explicitly.'
    );
  }
  const minOut = params.minOut !== undefined
    ? ethers.utils.parseUnits(params.minOut.toString(), toDecimals)
    : (expectedOut ?? amountWei).mul(95).div(100); // 5% slippage default (get_dy reverted — CLI parity)

  const expectedLabel = expectedOut ? ethers.utils.formatUnits(expectedOut, toDecimals) : 'unavailable';
  const metadata = buildProposalMetadata({
    description: `Swap ${params.amount} tokens via Curve pool ${poolAddr}. Withdraws from PaymentManager, approves pool, executes swap. Expected output: ~${expectedLabel}. Min output: ${ethers.utils.formatUnits(minOut, toDecimals)}.`,
    optionNames: [`Execute swap (${params.amount} tokens)`, 'Do not swap'],
  });
  const { cid, descriptionHash } = await pinProposalMetadata(ctx, metadata);

  return buildSwapProposal({
    hybridVotingAddress: hybridVotingAddr,
    paymentManagerAddress: pmAddr,
    executorAddress: executorAddr,
    fromToken,
    poolAddress: poolAddr,
    fromIndex: params.fromIndex,
    toIndex: params.toIndex,
    amountWei,
    minOut,
    amountLabel: params.amount,
    descriptionHash,
    durationMinutes,
    orgId: modules.orgId,
    ipfs: { cid, metadata },
  });
}

export interface ProposeSdaiParams {
  org: string;
  /** xDAI amount to deposit into sDAI (human units). */
  amount: number;
  /** Vote duration in minutes (CLI default 60). */
  durationMinutes?: number;
}

/**
 * Resolved port of `pop treasury propose-sdai` —
 * src/commands/treasury/propose-sdai.ts. Gnosis-only. REQUIRES ctx.provider:
 * the proposal metadata interpolates the Executor's live xDAI balance and
 * current sDAI holdings, so the exact CLI document cannot be built without the
 * reads. Replicates the CLI's Executor-balance precondition (execution would
 * fail if the wrap call can't be funded).
 */
export async function proposeSdaiIntent(ctx: PopContext, params: ProposeSdaiParams): Promise<TxIntent> {
  const amount = params.amount;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CliError(`--amount must be a positive number, got "${params.amount}".`, EXIT.USAGE);
  }
  const durationMinutes = params.durationMinutes ?? 60;

  const network = resolveNetworkConfig(ctx.chainId, ctx.env);
  if (network.chainId !== GNOSIS_CHAIN_ID) {
    throw new PreconditionError(
      `The sDAI strategy is Gnosis-only (WXDAI/sDAI addresses are Gnosis mainnet); current chain is ${network.name}.`,
      'Re-run with --chain 100.'
    );
  }
  if (!ctx.provider) {
    throw new CliError(
      'proposeSdaiIntent requires ctx.provider — the proposal metadata embeds the Executor\'s live xDAI balance and sDAI holdings.',
      EXIT.USAGE
    );
  }

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const executorAddr = requireModule(modules, 'executorAddress');
  const hybridVotingAddr = modules.hybridVotingAddress;
  if (!hybridVotingAddr) {
    throw new PreconditionError('HybridVoting not deployed for this org — cannot create a governance proposal.');
  }

  const amountWei = ethers.utils.parseEther(amount.toString());

  // The wrap call spends the Executor's native balance at execution time.
  const execBalance = await ctx.provider.getBalance(executorAddr);
  if (execBalance.lt(amountWei)) {
    throw new PreconditionError(
      `Executor holds ${formatToken(execBalance, 18, 'xDAI')} but the deposit needs ${amount} xDAI — execution would fail.`,
      'Lower --amount or fund the treasury first.'
    );
  }

  // Current sDAI holdings (context for the proposal metadata).
  const sdaiContract = new ethers.Contract(SDAI, SDAI_IFACE.fragments, ctx.provider);
  const currentShares: ethers.BigNumber = await sdaiContract.balanceOf(executorAddr);
  const currentAssets: ethers.BigNumber = currentShares.gt(0)
    ? await sdaiContract.convertToAssets(currentShares)
    : ethers.BigNumber.from(0);

  const metadata = buildProposalMetadata({
    description: `Deposit ${amount} xDAI into sDAI (${SDAI}) for yield. Three execution steps: wrap xDAI to WXDAI, approve WXDAI, deposit into sDAI vault. Current sDAI holdings: ${ethers.utils.formatEther(currentShares)} shares (${ethers.utils.formatEther(currentAssets)} WXDAI equivalent). Executor retains ${ethers.utils.formatEther(execBalance.sub(amountWei))} xDAI liquid.`,
    optionNames: [`Deposit ${amount} xDAI into sDAI`, 'Keep xDAI liquid'],
  });
  const { cid, descriptionHash } = await pinProposalMetadata(ctx, metadata);

  return buildSdaiProposal({
    hybridVotingAddress: hybridVotingAddr,
    executorAddress: executorAddr,
    amountWei,
    amountLabel: amount,
    descriptionHash,
    durationMinutes,
    orgId: modules.orgId,
    ipfs: { cid, metadata },
  });
}

export interface ProposeFinalizeParams {
  org: string;
  distribution: number;
  /** Blocks since the distribution's CHECKPOINT block before execution may succeed (CLI default 0). */
  minClaimBlocks?: number;
  /** Vote duration in minutes (CLI default 60). */
  durationMinutes?: number;
}

/**
 * Resolved port of `pop treasury propose-finalize` —
 * src/commands/treasury/propose-finalize.ts. When ctx.provider is present the
 * CLI's authoritative pre-flight runs (getDistribution →
 * DistributionNotFound / AlreadyFinalized fail fast, and the metadata carries
 * the payout token + unclaimed remainder); without a provider it behaves like
 * the CLI under --no-preflight (generic 'tokens' label, no unclaimed figure).
 */
export async function proposeFinalizeIntent(ctx: PopContext, params: ProposeFinalizeParams): Promise<TxIntent> {
  const distId = params.distribution;
  if (!Number.isInteger(distId) || distId < 0) {
    throw new CliError(`Invalid --distribution "${params.distribution}".`, EXIT.USAGE, 'Pass the numeric distribution ID (pop treasury distributions).');
  }
  const minClaimBlocks = params.minClaimBlocks ?? 0;
  if (!Number.isInteger(minClaimBlocks) || minClaimBlocks < 0) {
    throw new CliError('--min-claim-blocks must be a non-negative integer.', EXIT.USAGE);
  }
  const durationMinutes = params.durationMinutes ?? 60;

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const paymentManagerAddr = requireModule(modules, 'paymentManagerAddress');
  const hybridVotingAddr = modules.hybridVotingAddress;
  if (!hybridVotingAddr) {
    throw new PreconditionError('HybridVoting not deployed for this org — cannot create a governance proposal.');
  }

  // Authoritative read (RPC — mirrors the contract's own gates so the
  // proposal isn't doomed at execution). Optional: no provider = --no-preflight.
  let tokenLabel = 'tokens';
  let unclaimedLabel: string | undefined;
  if (ctx.provider) {
    const pmRead = new ethers.Contract(paymentManagerAddr, getAbi('PaymentManager'), ctx.provider);
    let dist: any;
    try {
      dist = await pmRead.getDistribution(distId);
    } catch {
      throw new PreconditionError(
        `Could not read distribution ${distId} on-chain.`,
        'List distributions with: pop treasury distributions'
      );
    }
    if (ethers.BigNumber.from(dist.totalAmount).isZero()) {
      throw new PreconditionError(
        `Distribution ${distId} does not exist (the contract would revert DistributionNotFound).`,
        'List distributions with: pop treasury distributions'
      );
    }
    if (dist.finalized) {
      throw new PreconditionError(`Distribution ${distId} is already finalized.`);
    }

    const token = await resolvePayoutTokenInfo(ctx.provider, dist.payoutToken, ctx.chainId);
    tokenLabel = token.symbol;
    const unclaimed = ethers.BigNumber.from(dist.totalAmount).sub(dist.totalClaimed);
    unclaimedLabel = formatToken(unclaimed, token.decimals, token.symbol);
  }

  const title = `Finalize distribution #${distId}`;
  const metadata = buildProposalMetadata({
    description: `Finalize distribution #${distId} via PaymentManager.finalizeDistribution(${distId}, ${minClaimBlocks}). `
      + `Blocks further claims and returns the unclaimed remainder${unclaimedLabel ? ` (${unclaimedLabel})` : ''} to the Executor treasury. `
      + `Payout token: ${tokenLabel}. Min claim period: ${minClaimBlocks} blocks from the checkpoint block.`,
    optionNames: [title, 'Keep the distribution open'],
  });
  const { cid, descriptionHash } = await pinProposalMetadata(ctx, metadata);

  return buildFinalizeDistributionProposal({
    hybridVotingAddress: hybridVotingAddr,
    paymentManagerAddress: paymentManagerAddr,
    distributionId: distId,
    minClaimPeriodBlocks: minClaimBlocks,
    descriptionHash,
    durationMinutes,
    orgId: modules.orgId,
    ipfs: { cid, metadata },
  });
}

export interface DepositParams {
  org: string;
  /** ERC20 token address. */
  token: string;
  /** Human token units. */
  amount: number;
}

/**
 * Resolved port of `pop treasury deposit` — src/commands/treasury/deposit.ts.
 * Returns BOTH intents of the two-transaction flow (approve, then payERC20);
 * hosts execute them in order and stop if the approve fails. Decimals follow
 * the CLI exactly: known-token table first (unknown tokens throw), then a
 * live decimals()/symbol() override when a provider is available.
 */
export async function depositIntents(
  ctx: PopContext,
  params: DepositParams
): Promise<{ approve: TxIntent; payERC20: TxIntent; amountWei: ethers.BigNumber; decimals: number; symbol?: string }> {
  const tokenAddr = requireAddress(params.token, 'token');
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new CliError(`--amount must be a positive number, got "${params.amount}".`, EXIT.USAGE);
  }

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const paymentManagerAddress = requireModule(modules, 'paymentManagerAddress');

  let decimals = getTokenDecimals(tokenAddr);
  let symbol: string | undefined;
  if (ctx.provider) {
    try {
      const erc20Read = new ethers.Contract(tokenAddr, getAbi('ERC20'), ctx.provider);
      const [liveDecimals, liveSymbol] = await Promise.all([
        erc20Read.decimals(),
        erc20Read.symbol().catch(() => undefined),
      ]);
      decimals = Number(liveDecimals);
      symbol = liveSymbol;
    } catch {
      // Live read failed — fall back to the known-token table / 18.
    }
  }
  const amountWei = ethers.utils.parseUnits(params.amount.toString(), decimals);

  return {
    approve: buildApproveErc20({
      tokenAddress: tokenAddr,
      spender: paymentManagerAddress,
      amountWei,
      orgId: modules.orgId,
    }),
    payERC20: buildPayErc20({
      paymentManagerAddress,
      tokenAddress: tokenAddr,
      amountWei,
      orgId: modules.orgId,
    }),
    amountWei,
    decimals,
    symbol,
  };
}

export interface ClaimDistributionParams {
  org: string;
  distribution: number;
  /** Decimal token units by default; the exact raw integer with wei=true. */
  amount: string;
  wei?: boolean;
  /** Merkle proof — array, inline JSON string, or allocation object. */
  proof: string | string[] | { proof: string[] };
}

/**
 * Resolved port of `pop treasury claim` — src/commands/treasury/claim.ts.
 * Resolves the payout token's decimals subgraph-FIRST (FETCH_DISTRIBUTION_BY_ID
 * — null means "not indexed yet" and falls through to getDistribution() when a
 * provider is available, never DistributionNotFound), converts the amount with
 * parseClaimAmount, and delegates to buildClaimDistribution.
 *
 * The CLI's revert-predicting pre-flight (finalized / hasClaimed / isOptedOut
 * — all authoritative eth_calls) stays host-side; opt-out BLOCKS on the
 * deployed pre-L-19 PaymentManager.
 */
export async function claimDistributionIntent(
  ctx: PopContext,
  params: ClaimDistributionParams
): Promise<TxIntent> {
  const proofArray = parseProof(params.proof);

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const paymentManagerAddress = requireModule(modules, 'paymentManagerAddress');

  // The distribution read is core to amount encoding (payout token →
  // decimals), so it runs unless --wei makes it unnecessary.
  let decimals = 18;
  if (!params.wei) {
    const indexed = await fetchDistributionById(ctx.client, paymentManagerAddress, params.distribution, ctx.chainId);
    let payoutToken: string;
    let totalAmount: ethers.BigNumber;
    if (indexed) {
      payoutToken = indexed.payoutToken;
      totalAmount = ethers.BigNumber.from(indexed.totalAmount);
    } else if (ctx.provider) {
      let onChain: any;
      try {
        onChain = await new ethers.Contract(paymentManagerAddress, getAbi('PaymentManager'), ctx.provider)
          .getDistribution(params.distribution);
      } catch {
        throw new PreconditionError(
          `Could not read distribution ${params.distribution} on-chain.`,
          'List distributions with: pop treasury distributions'
        );
      }
      payoutToken = onChain.payoutToken;
      totalAmount = ethers.BigNumber.from(onChain.totalAmount);
    } else {
      throw new PreconditionError(
        `Could not read distribution ${params.distribution} on-chain.`,
        'List distributions with: pop treasury distributions'
      );
    }
    if (totalAmount.isZero()) {
      throw new PreconditionError(
        `Distribution ${params.distribution} does not exist.`,
        'List distributions with: pop treasury distributions'
      );
    }
    const token = await resolvePayoutTokenInfo(ctx.provider, payoutToken, ctx.chainId);
    decimals = token.decimals;
  }

  const amountWei = parseClaimAmount(params.amount, Boolean(params.wei), decimals);

  return buildClaimDistribution({
    paymentManagerAddress,
    distributionId: params.distribution,
    amountWei,
    proof: proofArray,
    orgId: modules.orgId,
  });
}

export interface OptOutParams {
  org: string;
  /** true = opt out, false = opt back in. */
  optOut: boolean;
}

/**
 * Resolved port of `pop treasury opt-out` / `opt-in` —
 * src/commands/treasury/opt-out.ts. The CLI's isOptedOut no-op short-circuit
 * is a host-side pre-flight (the call is idempotent on-chain anyway).
 */
export async function optOutIntent(ctx: PopContext, params: OptOutParams): Promise<TxIntent> {
  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const paymentManagerAddress = requireModule(modules, 'paymentManagerAddress');
  return buildOptOut({ paymentManagerAddress, optOut: params.optOut, orgId: modules.orgId });
}
