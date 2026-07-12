/**
 * pop treasury claim-mine — auto-claim your allocation from every unclaimed
 * distribution. This is the RECOMMENDED claim path: it recomputes the
 * PT-proportional merkle tree at each distribution's checkpoint block (the
 * same allocation rules as compute-merkle), verifies the recomputed root
 * matches the on-chain root, and derives your exact amount + proof — no
 * manual --amount/--proof needed (that escape hatch is pop treasury claim).
 *
 * Pre-flight (skippable with --no-preflight) mirrors the contract's claim
 * gates before any gas is spent: isOptedOut fails fast, and per-distribution
 * hasClaimed reads skip claims the subgraph hasn't indexed yet.
 *
 * Amounts display in the payout token's human units — address(0) is the
 * chain's native token (verified against contracts origin/main
 * src/PaymentManager.sol), otherwise a live ERC20 decimals() read.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { query } from '../../lib/subgraph';
import { requireModule } from '../../lib/resolve';
import { getWriteContext, confirmWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { formatToken } from '../../lib/format';
import { resolvePayoutTokenInfo, PayoutTokenInfo } from './helpers';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ClaimMineArgs {
  org?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

// OZ v5 double-hash leaf
function hashLeaf(address: string, amount: ethers.BigNumber): string {
  const inner = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [address, amount])
  );
  return ethers.utils.keccak256(inner);
}

function hashPair(a: string, b: string): string {
  const [left, right] = a < b ? [a, b] : [b, a];
  return ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [left, right]);
}

function buildTree(leaves: string[]): string[][] {
  const sorted = [...leaves].sort();
  const layers: string[][] = [sorted];
  let current = sorted;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(hashPair(current[i], current[i + 1]));
      } else {
        next.push(current[i]);
      }
    }
    layers.push(next);
    current = next;
  }
  return layers;
}

function getProof(layers: string[][], leaf: string): string[] {
  const proof: string[] = [];
  let index = layers[0].indexOf(leaf);
  if (index === -1) return [];
  for (let i = 0; i < layers.length - 1; i++) {
    const siblingIndex = index % 2 === 1 ? index - 1 : index + 1;
    if (siblingIndex < layers[i].length) proof.push(layers[i][siblingIndex]);
    index = Math.floor(index / 2);
  }
  return proof;
}

const FETCH_MEMBERS_AT_BLOCK = `
  query FetchMembersAtBlock($orgId: Bytes!, $block: Int!) {
    organization(id: $orgId, block: { number: $block }) {
      participationToken { totalSupply }
      users(orderBy: participationTokenBalance, orderDirection: desc, first: 1000) {
        address
        participationTokenBalance
        membershipStatus
      }
    }
  }
`;

const FETCH_DISTRIBUTIONS = `
  query FetchDistributions($orgId: Bytes!) {
    organization(id: $orgId) {
      paymentManager {
        distributions(where: { status: "Active" }, first: 50) {
          distributionId
          totalAmount
          merkleRoot
          checkpointBlock
          payoutToken
          claims { claimer }
        }
      }
    }
  }
`;

interface ClaimResult {
  distId: string;
  amount: string;
  amountWei?: string;
  symbol?: string;
  token?: string;
  success: boolean;
  txHash?: string;
  explorerUrl?: string;
  dryRun?: boolean;
  error?: string;
}

interface Claimable {
  distId: string;
  amount: ethers.BigNumber;
  proof: string[];
  token: PayoutTokenInfo;
}

export const claimMineHandler = {
  builder: (yargs: Argv) => yargs
    .example('pop treasury claim-mine', 'Derive your amount + proof and claim from every unclaimed distribution')
    .example('pop treasury claim-mine --dry-run --json', 'Preview the claims without sending transactions')
    .epilogue(
      'Recommended over pop treasury claim: the amount and merkle proof are recomputed for you '
      + 'from PT balances at each distribution\'s checkpoint block. Distributions whose recomputed '
      + 'root does not match on-chain are skipped (different allocation parameters).'
    ),

  handler: async (argv: ArgumentsCamelCase<ClaimMineArgs>) => {
    const spin = output.spinner('Checking claimable distributions...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const paymentManagerAddress = requireModule(ctx.modules, 'paymentManagerAddress');
      const myAddrLower = ctx.address.toLowerCase();
      const pmRead = createReadContract(paymentManagerAddress, 'PaymentManager', ctx.provider);

      // Get active distributions
      const distResult = await query<any>(FETCH_DISTRIBUTIONS, { orgId: ctx.orgId }, argv.chain);
      const distributions = distResult.organization?.paymentManager?.distributions || [];

      if (distributions.length === 0) {
        spin.stop();
        if (output.isJsonMode()) output.json({ claimed: 0, distributions: [] });
        else output.info('No active distributions to claim from');
        return;
      }

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      // Mirror the contract's global claim gate: OptedOut reverts every claim.
      if (argv.preflight !== false) {
        const optedOut = await pmRead.isOptedOut(ctx.address);
        if (optedOut) {
          throw new PreconditionError(
            'This wallet is opted out of distributions — every claim would revert OptedOut.',
            'Opt back in first: pop treasury opt-in'
          );
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });

      // ── Derive amount + proof for every unclaimed distribution ────────
      const results: ClaimResult[] = [];
      const claimables: Claimable[] = [];

      for (const dist of distributions) {
        // Skip if already claimed (subgraph view, then authoritative on-chain
        // read when pre-flight is enabled — the subgraph can lag).
        const alreadyClaimed = (dist.claims || []).some((c: any) => c.claimer?.toLowerCase() === myAddrLower);
        if (alreadyClaimed) continue;
        if (argv.preflight !== false) {
          const claimedOnChain = await pmRead.hasClaimed(dist.distributionId, ctx.address);
          if (claimedOnChain) continue;
        }

        spin.text = `Recomputing merkle tree for distribution #${dist.distributionId}...`;

        // Get PT balances at checkpoint block
        const membersResult = await query<any>(FETCH_MEMBERS_AT_BLOCK, {
          orgId: ctx.orgId,
          block: parseInt(dist.checkpointBlock),
        }, argv.chain);

        const org = membersResult.organization;
        if (!org) continue;

        const activeMembers = org.users.filter((u: any) =>
          u.membershipStatus === 'Active' &&
          ethers.BigNumber.from(u.participationTokenBalance).gt(0)
        );

        const totalAmount = ethers.BigNumber.from(dist.totalAmount);
        const eligiblePT = activeMembers.reduce(
          (sum: ethers.BigNumber, m: any) => sum.add(ethers.BigNumber.from(m.participationTokenBalance)),
          ethers.BigNumber.from(0)
        );

        // Compute allocations
        const allocs = activeMembers.map((m: any) => {
          const pt = ethers.BigNumber.from(m.participationTokenBalance);
          return {
            address: ethers.utils.getAddress(m.address),
            amount: totalAmount.mul(pt).div(eligiblePT),
          };
        });

        // Dust fix
        const allocated = allocs.reduce((s: ethers.BigNumber, a: any) => s.add(a.amount), ethers.BigNumber.from(0));
        const dust = totalAmount.sub(allocated);
        if (dust.gt(0) && allocs.length > 0) allocs[0].amount = allocs[0].amount.add(dust);

        // Build merkle tree
        const leaves = allocs.map((a: any) => hashLeaf(a.address, a.amount));
        const layers = buildTree(leaves);
        const computedRoot = layers[layers.length - 1][0];

        const token = await resolvePayoutTokenInfo(ctx.provider, dist.payoutToken, ctx.chainId);

        // Verify root matches on-chain
        if (computedRoot !== dist.merkleRoot) {
          results.push({ distId: dist.distributionId, amount: '0', symbol: token.symbol, success: false, error: 'Root mismatch — different allocation parameters' });
          continue;
        }

        // Find my allocation
        const myAlloc = allocs.find((a: any) => a.address.toLowerCase() === myAddrLower);
        if (!myAlloc || myAlloc.amount.isZero()) {
          results.push({ distId: dist.distributionId, amount: '0', symbol: token.symbol, success: false, error: 'No allocation for this address' });
          continue;
        }

        const myLeaf = hashLeaf(myAlloc.address, myAlloc.amount);
        claimables.push({ distId: dist.distributionId, amount: myAlloc.amount, proof: getProof(layers, myLeaf), token });
      }

      spin.stop();

      // ── Confirm once for the whole batch, then claim ───────────────────
      if (claimables.length > 0) {
        const totalsBySymbol = new Map<string, { total: ethers.BigNumber; decimals: number }>();
        for (const c of claimables) {
          const entry = totalsBySymbol.get(c.token.symbol) ?? { total: ethers.BigNumber.from(0), decimals: c.token.decimals };
          entry.total = entry.total.add(c.amount);
          totalsBySymbol.set(c.token.symbol, entry);
        }
        const totalLabel = [...totalsBySymbol.entries()]
          .map(([symbol, { total, decimals }]) => formatToken(total, decimals, symbol))
          .join(' + ');

        await confirmWrite(argv, {
          distributions: claimables.map(c => `#${c.distId}`).join(', '),
          total: totalLabel,
          recipient: `${ctx.address} (you)`,
          org: argv.org,
          chain: ctx.networkName,
        }, { actionLabel: `About to claim from ${claimables.length} distribution(s)` });

        const pm = createWriteContract(paymentManagerAddress, 'PaymentManager', ctx.signer);
        for (const c of claimables) {
          const txSpin = output.spinner(`Claiming ${formatToken(c.amount, c.token.decimals, c.token.symbol)} from distribution #${c.distId}...`);
          txSpin.start();
          const txResult = await executeTx(
            pm,
            'claimDistribution',
            [c.distId, c.amount, c.proof],
            { dryRun: argv.dryRun }
          );
          txSpin.stop();

          results.push({
            distId: c.distId,
            amount: ethers.utils.formatUnits(c.amount, c.token.decimals),
            amountWei: c.amount.toString(),
            symbol: c.token.symbol,
            token: c.token.isNative ? 'native' : c.token.address,
            success: txResult.success,
            txHash: txResult.txHash,
            explorerUrl: txResult.explorerUrl,
            dryRun: txResult.dryRun || undefined,
            error: txResult.success ? undefined : txResult.error,
          });
        }
      }

      if (output.isJsonMode()) {
        output.json({
          claimed: results.filter(r => r.success && !r.dryRun).length,
          distributions: results,
          dryRun: argv.dryRun || undefined,
        });
      } else {
        if (results.length === 0) {
          output.info('No unclaimed distributions found');
        } else {
          console.log('');
          for (const r of results) {
            if (r.success && r.dryRun) {
              console.log(`  \x1b[36m○\x1b[0m Distribution #${r.distId}: DRY RUN — would claim ${r.amount} ${r.symbol ?? 'tokens'}`);
            } else if (r.success) {
              console.log(`  \x1b[32m✓\x1b[0m Distribution #${r.distId}: claimed ${r.amount} ${r.symbol ?? 'tokens'}`);
              if (r.explorerUrl) console.log(`      ${r.explorerUrl}`);
            } else {
              console.log(`  \x1b[31m✗\x1b[0m Distribution #${r.distId}: ${r.error}`);
            }
          }
          const ok = results.filter(r => r.success).length;
          console.log(`\n  ${ok}/${results.length} claimed${argv.dryRun ? ' (dry run)' : ''}.`);
          console.log('');
        }
      }
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err?.message || String(err));
      process.exit(EXIT.USAGE);
    }
  },
};
