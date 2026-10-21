import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { requireRawUint } from '@poa-box/core/amounts';
import { verifyDistributionClaimsDocument, findDistributionClaim } from '@poa-box/core/metadata/distribution';
import { readDistributionReferences } from '@poa-box/core/reads/treasury';
import { buildClaimDistribution } from '@poa-box/core/tx/treasury';
import { requireCompleteSnapshot } from '@poa-box/core/data/facts';
import { createProvider, resolveIdentityAddress } from '../../lib/signer';
import { resolveNetworkConfig } from '../../config/networks';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { createIndexedSource } from '../../lib/indexed-source';
import { tryAggregate } from '../../lib/multicall';
import { fetchJson } from '../../lib/ipfs';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { executeIntent } from '../../lib/tx';
import * as output from '../../lib/output';
interface Args { org?: string; chain?: number; address?: string; distribution: string; cid?: string; maxPages?: number; dryRun?: boolean }
const PM = new ethers.utils.Interface([
  'function getDistribution(uint256) view returns(address payoutToken,uint256 totalAmount,uint256 checkpointBlock,bytes32 merkleRoot,uint256 totalClaimed,bool finalized)',
  'function hasClaimed(uint256,address) view returns(bool)', 'function isOptedOut(address) view returns(bool)',
]);
export async function loadStoredDistributionClaim(argv: Args, account: string, provider?: ethers.providers.Provider) {
  const modules = await resolveOrgModules(argv.org, argv.chain), config = resolveNetworkConfig(argv.chain);
  const rpc = provider ?? createProvider({ chainId: config.chainId });
  if ((await rpc.getNetwork()).chainId !== config.chainId) throw new Error('RPC_CHAIN_MISMATCH');
  const manager = requireModule(modules, 'paymentManagerAddress'), id = requireRawUint(argv.distribution);
  if (id === '0') throw new Error('Invalid distribution ID');
  const block = await rpc.getBlock('latest');
  const calls = [{ to: manager, data: PM.encodeFunctionData('getDistribution', [id]) },
    { to: manager, data: PM.encodeFunctionData('hasClaimed', [id, account]) }, { to: manager, data: PM.encodeFunctionData('isOptedOut', [account]) }];
  const rows = await tryAggregate(rpc, calls, { blockTag: block.number });
  if (rows.some(r => !r.success)) throw new Error('Pinned distribution state is unavailable');
  const distribution = PM.decodeFunctionResult('getDistribution', rows[0].returnData);
  if (distribution.totalAmount.isZero()) throw new Error('Distribution does not exist');
  let cid = argv.cid;
  if (!cid) {
    const indexed = await createIndexedSource({ chainId: config.chainId, orgId: modules.orgId, contract: requireModule(modules, 'hybridVotingAddress') });
    const references = await readDistributionReferences({ source: indexed.source, query: indexed.protocolQuery, pageSize: 100, maxPages: argv.maxPages ?? 20 });
    requireCompleteSnapshot(references);
    const candidates = [...new Set(references.data.flatMap(row => row.reference.state === 'known'
      && row.reference.value.merkleRoot.toLowerCase() === distribution.merkleRoot.toLowerCase() ? [row.reference.value.cid] : []))];
    if (candidates.length !== 1) throw new Error(candidates.length ? 'Multiple stored claim documents match this root; select --cid explicitly.' : 'No complete stored claim reference was discovered; supply --cid or use the historical claim path.');
    cid = candidates[0];
  }
  const reference = { chainId: config.chainId, orgId: modules.orgId, paymentManager: manager, distributionId: id, cid,
    merkleRoot: distribution.merkleRoot, token: distribution.payoutToken, totalAmount: distribution.totalAmount.toString(), checkpointBlock: distribution.checkpointBlock.toString() };
  const verified = verifyDistributionClaimsDocument(await fetchJson(cid), { reference, loadedCid: cid });
  if (verified.state !== 'known') throw new Error(`Stored claims failed verification: ${verified.code}`);
  const claim = findDistributionClaim(verified, account);
  if ((await rpc.getBlock(block.number)).hash !== block.hash) throw new Error('Distribution observation changed');
  return { reference, claim, finalized: Boolean(distribution.finalized), alreadyClaimed: Boolean(PM.decodeFunctionResult('hasClaimed', rows[1].returnData)[0]),
    optedOut: Boolean(PM.decodeFunctionResult('isOptedOut', rows[2].returnData)[0]),
    block: { number: String(block.number), hash: block.hash }, verified };
}
const builder = (y: Argv) => y.option('distribution', { type: 'string', demandOption: true, describe: 'Exact distribution ID' })
  .option('cid', { type: 'string', describe: 'Stored claims CIDv0; otherwise discover from complete executed proposals' })
  .option('max-pages', { type: 'number', default: 20, describe: 'Finite executed-proposal discovery bound' });
export const claimsHandler = { builder: (y: Argv) => builder(y).option('address', { type: 'string', describe: 'Observe this claimant without a signing key' }),
  handler: async (argv: ArgumentsCamelCase<Args>) => {
    try { const account = resolveIdentityAddress(argv, { required: true })!, result = await loadStoredDistributionClaim(argv, account);
      const data = { account, reference: result.reference, claim: result.claim, finalized: result.finalized, alreadyClaimed: result.alreadyClaimed, optedOut: result.optedOut, block: result.block };
      if (output.isJsonMode()) output.json(data); else output.info(JSON.stringify(data, null, 2));
    } catch (error: any) { output.error(error.message); process.exitCode = 1; }
  } };
export const claimStoredHandler = { builder,
  handler: async (argv: ArgumentsCamelCase<Args>) => {
    try {
      const ctx = await getWriteContext(argv), result = await loadStoredDistributionClaim(argv, ctx.address, ctx.provider);
      if (result.claim.state !== 'known' || !result.claim.value || result.claim.value.amount === '0') throw new Error('No positive verified claim for this account');
      if (result.finalized || result.alreadyClaimed || result.optedOut) throw new Error('Distribution is finalized, already claimed, or this wallet is opted out');
      await confirmWrite(argv, { distribution: argv.distribution, amountWei: result.claim.value.amount, recipient: ctx.address, chain: ctx.chainId }, { actionLabel: 'About to claim a verified stored distribution leaf' });
      const intent = buildClaimDistribution({ paymentManagerAddress: result.reference.paymentManager, distributionId: argv.distribution,
        amountWei: result.claim.value.amount, proof: result.claim.value.proof, orgId: ctx.orgId });
      const tx = await executeIntent(ctx.signer, intent, { dryRun: argv.dryRun });
      finishWrite(tx, { successMsg: 'Distribution claimed', fields: { distributionId: argv.distribution, amountWei: result.claim.value.amount,
        token: result.reference.token, claimsCid: result.reference.cid } });
    } catch (error: any) { output.error(error.message); process.exitCode = 1; }
  } };
