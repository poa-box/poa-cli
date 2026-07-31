import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import * as fs from 'fs';
import { query } from '../../lib/subgraph';
import { resolveOrgModules } from '../../lib/resolve';
import { tryAggregate, Call } from '../../lib/multicall';
import { resolveNetworkConfig } from '../../config/networks';
import * as output from '../../lib/output';

interface ComputeMerkleArgs {
  org?: string;
  chain?: number;
  amount: string;
  token: string;
  output?: string;
}

interface MemberAllocation {
  address: string;
  username: string | null;
  ptBalance: string;
  share: string;
  allocation: string;
}

interface MerkleResult {
  merkleRoot: string;
  totalAmount: string;
  tokenAddress: string;
  checkpointBlock: number;
  memberCount: number;
  allocations: Array<MemberAllocation & { proof: string[] }>;
}

/**
 * Merkle tree — OpenZeppelin StandardMerkleTree, matching PaymentManager on-chain.
 *
 * PaymentManager.claim recomputes the leaf as
 *   keccak256(bytes.concat(keccak256(abi.encode(msg.sender, claimAmount))))
 * and verifies it with OZ `MerkleProof.verify`, so the tree must be built exactly the way the
 * OZ library builds it.
 *
 * This previously used a hand-rolled tree that paired leaves left-to-right per layer and
 * promoted an odd trailing leaf unchanged. That agrees with OZ for 1, 2, 3, 4, 6 and 8 leaves
 * but DIVERGES at 5 and 7 (OZ builds a complete 2n-1 tree and pairs by node index). For an org
 * with 5 or 7 members the computed root and proofs were rejected by MerkleProof.verify, so a
 * distribution created from them could never be claimed. Pinned by
 * test/commands/treasury-compute-merkle.test.ts.
 */

// --- Subgraph query for members ---

const FETCH_MEMBERS_PT = `
  query FetchMembersPT($orgId: Bytes!) {
    organization(id: $orgId) {
      users(
        orderBy: participationTokenBalance,
        orderDirection: desc,
        first: 1000
      ) {
        address
        participationTokenBalance
        membershipStatus
        account {
          username
        }
      }
      participationToken {
        totalSupply
      }
    }
  }
`;

export const computeMerkleHandler = {
  builder: (yargs: Argv) => yargs
    .option('amount', { type: 'string', demandOption: true, describe: 'Total distribution amount (in token units, e.g. "40" for 40 BREAD)' })
    .option('token', { type: 'string', demandOption: true, describe: 'Payout token address' })
    .option('output', { type: 'string', default: 'merkle-distribution.json', describe: 'Output file for proofs' }),

  handler: async (argv: ArgumentsCamelCase<ComputeMerkleArgs>) => {
    const spin = output.spinner('Computing merkle tree...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const networkConfig = resolveNetworkConfig(argv.chain);
      const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc);

      // Get current block as checkpoint
      const checkpointBlock = await provider.getBlockNumber();

      // Fetch all members and PT balances
      spin.text = 'Fetching member PT balances...';
      const result = await query<any>(FETCH_MEMBERS_PT, { orgId: modules.orgId }, argv.chain);
      const org = result.organization;

      if (!org) {
        throw new Error('Organization not found');
      }

      const totalPTSupply = ethers.BigNumber.from(org.participationToken.totalSupply);
      if (totalPTSupply.isZero()) {
        throw new Error('No participation tokens in circulation');
      }

      // Filter to active members with PT > 0
      const ptHolders = org.users.filter((u: any) =>
        u.membershipStatus === 'Active' &&
        ethers.BigNumber.from(u.participationTokenBalance).gt(0)
      );

      if (ptHolders.length === 0) {
        throw new Error('No active members with PT balance');
      }

      // Exclude members who have opted out of payouts.
      //
      // THIS IS THE ONLY ENFORCEMENT POINT. PaymentManager.claim deliberately does not check
      // opt-out (audit L-19): membership in a distribution's tree is fixed at creation, and
      // opting out afterwards must not strand already-allocated funds. The contract's own
      // comment says opt-out "is honored off-chain when the executor builds the next
      // distribution's merkle tree" — this command is that builder. Allocating to an opted-out
      // member here silently defeats their opt-out.
      //
      // Read on-chain rather than from the subgraph's OptOutToggle log: this decides who gets
      // money, so it uses the authoritative getter the contract points at. One multicall
      // round-trip for the whole member set.
      const paymentManagerAddress = modules.paymentManagerAddress;
      let optedOut = new Set<string>();
      if (paymentManagerAddress) {
        spin.text = `Checking opt-out status for ${ptHolders.length} members...`;
        const pmIface = new ethers.utils.Interface([
          'function isOptedOut(address account) view returns (bool)',
        ]);
        // NOTE the shape: tryAggregate takes { to, data } (lib/multicall Call), not the
        // raw Multicall3 tuple names { target, callData }. This site once used the tuple
        // names — `ptHolders` is untyped JSON so `.map` returned any[] and the mistake
        // compiled — and every probe silently failed, which meant NO ONE was excluded.
        const optOutCalls: Call[] = ptHolders.map((m: any) => ({
          to: paymentManagerAddress,
          data: pmIface.encodeFunctionData('isOptedOut', [ethers.utils.getAddress(m.address)]),
        }));
        const results = await tryAggregate(provider, optOutCalls);
        results.forEach((r, i) => {
          if (!r.success) return; // unreadable — fail open, they stay in the tree
          try {
            if (pmIface.decodeFunctionResult('isOptedOut', r.returnData)[0] === true) {
              optedOut.add(String(ptHolders[i].address).toLowerCase());
            }
          } catch { /* malformed — treat as not opted out */ }
        });
        // Per-member fail-open is deliberate, but ALL probes failing means the opt-out
        // filter did not run at all — say so instead of silently building an
        // enforcement-free tree.
        if (ptHolders.length > 0 && results.every((r) => !r.success)) {
          output.warn(
            'Opt-out status could not be read for ANY member (RPC failure?) — the tree will '
              + 'include members who may have opted out. Verify before proposing this distribution.'
          );
        }
      }

      const activeMembers = ptHolders.filter(
        (m: any) => !optedOut.has(String(m.address).toLowerCase())
      );

      if (activeMembers.length === 0) {
        throw new Error(
          optedOut.size > 0
            ? `All ${ptHolders.length} PT-holding member(s) have opted out of payouts.`
            : 'No active members with PT balance'
        );
      }

      // Parse distribution amount
      const totalAmount = ethers.utils.parseEther(argv.amount);

      // Calculate pro-rata allocations based on PT share
      spin.text = `Computing allocations for ${activeMembers.length} members...`;

      // Sum PT of eligible members (may differ from totalSupply if some are inactive)
      const eligiblePT = activeMembers.reduce(
        (sum: ethers.BigNumber, m: any) => sum.add(ethers.BigNumber.from(m.participationTokenBalance)),
        ethers.BigNumber.from(0)
      );

      const allocations: MemberAllocation[] = activeMembers.map((m: any) => {
        const ptBal = ethers.BigNumber.from(m.participationTokenBalance);
        // Pro-rata: allocation = totalAmount * memberPT / eligiblePT
        const allocation = totalAmount.mul(ptBal).div(eligiblePT);
        const sharePercent = ptBal.mul(10000).div(eligiblePT).toNumber() / 100;

        return {
          address: ethers.utils.getAddress(m.address),
          username: m.account?.username || null,
          ptBalance: ethers.utils.formatEther(ptBal),
          share: `${sharePercent.toFixed(2)}%`,
          allocation: allocation.toString(),
        };
      });

      // Handle rounding dust — give remainder to largest holder
      const allocatedTotal = allocations.reduce(
        (sum, a) => sum.add(ethers.BigNumber.from(a.allocation)),
        ethers.BigNumber.from(0)
      );
      const dust = totalAmount.sub(allocatedTotal);
      if (dust.gt(0)) {
        allocations[0].allocation = ethers.BigNumber.from(allocations[0].allocation).add(dust).toString();
      }

      // Build merkle tree
      spin.text = 'Building merkle tree...';

      // StandardMerkleTree hashes each value pair itself (double-keccak over abi.encode) and
      // sorts leaves internally, so proofs are looked up by the ORIGINAL value, not by index.
      const tree = StandardMerkleTree.of(
        allocations.map(a => [a.address, a.allocation]),
        ['address', 'uint256']
      );
      const merkleRoot = tree.root;

      // Generate proofs for each member
      const allocationsWithProofs = allocations.map(a => ({
        ...a,
        proof: tree.getProof([a.address, a.allocation]),
      }));

      // Build output
      const merkleResult: MerkleResult = {
        merkleRoot,
        totalAmount: totalAmount.toString(),
        tokenAddress: argv.token,
        checkpointBlock,
        memberCount: allocations.length,
        allocations: allocationsWithProofs,
      };

      // Write to file
      const outPath = argv.output as string;
      fs.writeFileSync(outPath, JSON.stringify(merkleResult, null, 2) + '\n');

      spin.stop();

      if (output.isJsonMode()) {
        output.json(merkleResult);
      } else {
        console.log('');
        console.log('  Merkle Distribution Computed');
        console.log('  ─────────────────────────────');
        console.log(`  Root:        ${merkleRoot}`);
        console.log(`  Token:       ${argv.token}`);
        console.log(`  Total:       ${ethers.utils.formatEther(totalAmount)} tokens`);
        console.log(`  Checkpoint:  Block #${checkpointBlock}`);
        console.log(`  Members:     ${allocations.length}`);
        console.log('');
        console.log('  Allocations:');
        for (const a of allocationsWithProofs) {
          const label = a.username || a.address.slice(0, 10) + '...';
          console.log(`    ${label.padEnd(20)} ${a.share.padStart(8)}  →  ${ethers.utils.formatEther(a.allocation)} tokens`);
        }
        console.log('');
        console.log(`  Proofs written to: ${outPath}`);
        console.log('');
        console.log('  To create distribution:');
        console.log(`    pop treasury deposit --token ${argv.token} --amount ${argv.amount}`);
        console.log(`    # Then propose via governance with createDistribution(${argv.token}, ${totalAmount}, ${merkleRoot}, ${checkpointBlock})`);
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
