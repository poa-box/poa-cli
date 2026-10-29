import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import * as fs from 'fs';
import { allocateDistribution, type AllocationPolicy } from '@poa-box/core/treasury/distributions';
import { buildDistributionClaimsDocument } from '@poa-box/core/metadata/distribution';
import { readTokenHolderTotals } from '@poa-box/core/reads/token';
import { readCurrentMemberTotals } from '@poa-box/core/reads/member-totals';
import { checkedIndexedTotalQuery, readIndexedTotalState } from '@poa-box/core/data/indexed-completeness';
import { requireCompleteSnapshot, type SourceSnapshot } from '@poa-box/core/data/facts';
import { parseDecimalAmountToRaw } from '@poa-box/core/amounts';
import type { DistributionMemberInput } from '@poa-box/core/tx/treasury';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { tryAggregate } from '../../lib/multicall';
import { createIndexedSource } from '../../lib/indexed-source';
import { createProvider } from '../../lib/signer';
import { resolveNetworkConfig } from '../../config/networks';
import { resolvePayoutTokenInfo } from './helpers';
import * as output from '../../lib/output';

interface Args { org?: string; chain?: number; amount: string; token: string; output?: string; policy?: AllocationPolicy; pageSize?: number; maxPages?: number }
const ALLOCATION_MODULES = `query DistributionModules($orgId: ID!, $block: Block_height) {
  organization(id: $orgId, block: $block) {
    id participationToken { id } paymentManager { id } membershipAuthority { id }
  }
  _meta(block: $block) { deployment hasIndexingErrors block { number hash timestamp } }
}`;
/** New rounds require complete current authority membership, supply-reconciled
 * TokenBalance holders and opt-out facts at one checkpoint. Historical User
 * activity/flags never authorize a new allocation; stored claims are unchanged. */
export const computeMerkleHandler = {
  builder: (y: Argv) => y.option('amount', { type: 'string', demandOption: true, describe: 'Exact total payout amount in token units' })
    .option('token', { type: 'string', demandOption: true, describe: 'Payout token address, or native' })
    .option('output', { type: 'string', default: 'merkle-distribution.json', describe: 'Local proofs artifact output path' })
    .option('policy', { type: 'string', choices: ['cli-first-holder', 'sorted-last-omit-zero'], default: 'cli-first-holder', describe: 'Explicit allocator policy for this new round' })
    .option('page-size', { type: 'number', default: 100, describe: 'Holder page size (1–1000)' })
    .option('max-pages', { type: 'number', default: 100, describe: 'Finite holder page cap; incomplete snapshots cannot allocate' }),
  handler: async (argv: ArgumentsCamelCase<Args>) => {
    const spin = output.spinner('Computing checkpoint-qualified merkle allocation...'); spin.start();
    try {
      const modules = await resolveOrgModules(argv.org, argv.chain), config = resolveNetworkConfig(argv.chain);
      const paymentManager = requireModule(modules, 'paymentManagerAddress'), holderContract = requireModule(modules, 'participationTokenAddress');
      const membershipAuthority = requireModule(modules, 'membershipAuthorityAddress');
      const provider = createProvider({ chainId: config.chainId });
      if ((await provider.getNetwork()).chainId !== config.chainId) throw new Error('RPC_CHAIN_MISMATCH');
      const contracts = { participationToken: holderContract, paymentManager, membershipAuthority };
      const indexed = await createIndexedSource({ chainId: config.chainId, orgId: modules.orgId, contract: holderContract, contracts });
      const checkpoint = indexed.source.block!;
      if (BigInt(checkpoint.number) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CHECKPOINT_BLOCK_TOO_LARGE');
      const checkpointBlock = Number(checkpoint.number), rpcBlock = await provider.getBlock(checkpointBlock);
      if (!checkpoint.hash || rpcBlock.hash.toLowerCase() !== checkpoint.hash.toLowerCase()) throw new Error('INDEXED_RPC_CHECKPOINT_MISMATCH');
      if (!Number.isSafeInteger(argv.pageSize ?? 100) || (argv.pageSize ?? 100) < 1 || (argv.pageSize ?? 100) > 1000
        || !Number.isSafeInteger(argv.maxPages ?? 100) || (argv.maxPages ?? 100) < 1 || (argv.maxPages ?? 100) > 1000) throw new Error('INVALID_HOLDER_PAGE_BOUNDS');
      // One shared deployment/health guard spans all independent streams.
      const options = { source: indexed.source, query: checkedIndexedTotalQuery(indexed.protocolQuery),
        pageSize: argv.pageSize ?? 100, maxPages: argv.maxPages ?? 100 };
      const moduleSnapshot = await readIndexedTotalState(options, ALLOCATION_MODULES, { orgId: modules.orgId }, 'organization', modules.orgId.toLowerCase());
      const org = requireCompleteSnapshot(moduleSnapshot, { scope: indexed.source, indexed: true, snapshot: 'pinned', block: checkpoint }) as any;
      if (org?.id?.toLowerCase() !== modules.orgId.toLowerCase()
        || org.participationToken?.id?.toLowerCase() !== holderContract.toLowerCase()
        || org.paymentManager?.id?.toLowerCase() !== paymentManager.toLowerCase()
        || org.membershipAuthority?.id?.toLowerCase() !== membershipAuthority.toLowerCase()) throw new Error('ALLOCATION_MODULE_BINDING_MISMATCH');
      const [holders, currentMembership] = await Promise.all([
        readTokenHolderTotals(options),
        readCurrentMemberTotals({ ...options, source: { ...indexed.source, contract: membershipAuthority } }),
      ]);
      const holderFacts = requireCompleteSnapshot(holders, { scope: indexed.source, indexed: true, snapshot: 'pinned', block: checkpoint });
      const membershipFacts = requireCompleteSnapshot(currentMembership, { scope: { ...indexed.source, contract: membershipAuthority },
        indexed: true, snapshot: 'pinned', block: checkpoint });
      if (holderFacts.total.state !== 'known' || holderFacts.balanceTotalRaw.state !== 'known'
        || membershipFacts.total.state !== 'known') throw new Error('ALLOCATION_ELIGIBILITY_UNKNOWN');
      const currentMembers = new Set(membershipFacts.members.map(member => member.account.toLowerCase()));
      // Historical CLI allocation gives dust to the largest holder. ID ordering
      // supplies a deterministic tie-break for NEW rounds; stored claims never reallocate.
      const members = holderFacts.holders.map(holder => ({ address: holder.account, participationTokenBalance: holder.balanceRaw,
        membershipStatus: currentMembers.has(holder.account.toLowerCase()) ? 'Active' : 'Inactive', username: null }))
        .sort((a, b) => BigInt(a.participationTokenBalance) > BigInt(b.participationTokenBalance) ? -1
          : BigInt(a.participationTokenBalance) < BigInt(b.participationTokenBalance) ? 1 : a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
      const active = members.filter(m => m.membershipStatus === 'Active' && BigInt(m.participationTokenBalance) > 0n);
      const iface = new ethers.utils.Interface(['function isOptedOut(address) view returns(bool)']);
      const probes = active.length ? await tryAggregate(provider, active.map(m => ({ to: paymentManager, data: iface.encodeFunctionData('isOptedOut', [m.address]) })), { blockTag: checkpointBlock }) : [];
      const optOuts = probes.map((probe, index) => {
        if (!probe.success) throw new Error('OPT_OUT_UNKNOWN');
        return { address: active[index].address, optedOut: Boolean(iface.decodeFunctionResult('isOptedOut', probe.returnData)[0]) };
      });
      const token = await resolvePayoutTokenInfo(provider, argv.token === 'native' ? ethers.constants.AddressZero : ethers.utils.getAddress(argv.token), config.chainId);
      const totalRaw = parseDecimalAmountToRaw(argv.amount, token.decimals);
      if (totalRaw === '0') throw new Error('ZERO_DISTRIBUTION');
      const holderSnapshot: SourceSnapshot<readonly DistributionMemberInput[]> = { ...holders, data: members };
      const prepared = allocateDistribution({ holders: holderSnapshot, optOutFacts: { source: { ...indexed.source, contract: paymentManager, indexed: false,
        endpoint: `rpc:${config.chainId}`, method: 'eth_call' }, data: optOuts,
        coverage: { status: 'complete', receivedKeys: optOuts.map(m => m.address.toLowerCase()), missingIds: [], failedIds: [], issues: [] } },
        chainId: config.chainId, orgId: modules.orgId, holderContract, paymentManager, checkpoint, totalRaw, policy: argv.policy ?? 'cli-first-holder' });
      const eligible = members.filter(m => active.includes(m) && !optOuts.find(f => f.address.toLowerCase() === m.address.toLowerCase())?.optedOut);
      const eligiblePT = eligible.reduce((sum, m) => sum + BigInt(m.participationTokenBalance), 0n);
      const allocations = prepared.allocations.map(allocation => {
        const holder = members.find(m => m.address.toLowerCase() === allocation.address.toLowerCase())!;
        return { address: allocation.address, username: holder.username, ptBalance: ethers.utils.formatEther(holder.participationTokenBalance),
          share: `${(Number(BigInt(holder.participationTokenBalance) * 10000n / eligiblePT) / 100).toFixed(2)}%`, allocation: allocation.amountRaw,
          proof: prepared.claims[allocation.address].proof };
      });
      const claimsDocument = buildDistributionClaimsDocument({ token: token.address, tokenSymbol: token.symbol, totalAmount: totalRaw,
        checkpointBlock, merkleRoot: prepared.merkleRoot, claims: prepared.claims, createdAt: Date.now() });
      const result = { merkleRoot: prepared.merkleRoot, totalAmount: totalRaw, tokenAddress: token.address, checkpointBlock,
        memberCount: allocations.length, optOutCheck: 'ok', optOutProbeFailures: 0, excludedOptedOut: optOuts.filter(o => o.optedOut).length,
        allocations, claims: prepared.claims, claimsDocument, chainId: config.chainId, orgId: modules.orgId, paymentManager,
        policy: prepared.policy, source: holders.source, holderCoverage: holders.coverage, membershipAuthority,
        membershipSource: currentMembership.source, membershipCoverage: currentMembership.coverage,
        membershipSemantics: membershipFacts.semantics, membershipCheck: 'ok' };
      if ((await provider.getBlock(checkpointBlock)).hash !== rpcBlock.hash) throw new Error('RPC_CHECKPOINT_CHANGED');
      fs.writeFileSync(argv.output ?? 'merkle-distribution.json', JSON.stringify(result, null, 2) + '\n');
      spin.stop();
      if (output.isJsonMode()) output.json(result); else output.info(`Computed ${allocations.length} claims (${argv.amount} ${token.symbol}) at block ${checkpointBlock}; proofs written to ${argv.output ?? 'merkle-distribution.json'}`);
    } catch (error: any) { spin.stop(); output.error(error.message); process.exitCode = 1; }
  },
};
