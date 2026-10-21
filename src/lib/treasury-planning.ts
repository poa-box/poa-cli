/** RPC snapshots used only to predict treasury proposal solvency/reverts. */
import { ethers } from 'ethers';
import { knownFact, type SourceRef, type SourceSnapshot } from '@poa-box/core/data/facts';
import { requireRawUint, type AssetRef } from '@poa-box/core/amounts';
import { readPaymentManagerPlanningSnapshot, paymentManagerPlanningState } from '@poa-box/core/reads/treasury';
import { paymentManagerAvailability, type PaymentManagerState } from '@poa-box/core/treasury/planning';
import { tryAggregate } from './multicall';

const PM = new ethers.utils.Interface([
  'function distributionCounter() view returns(uint256)',
  'function getDistribution(uint256) view returns(address payoutToken,uint256 totalAmount,uint256 checkpointBlock,bytes32 merkleRoot,uint256 totalClaimed,bool finalized)',
]);
const ERC20 = new ethers.utils.Interface(['function balanceOf(address) view returns(uint256)']);
export async function readTreasuryPlanningState(input: {
  provider: ethers.providers.Provider; chainId: number; orgId: string; paymentManager: string;
  asset: AssetRef; maxRounds?: number; blockNumber?: number;
}): Promise<SourceSnapshot<PaymentManagerState>> {
  const { provider, chainId, orgId, paymentManager, asset } = input;
  if ((await provider.getNetwork()).chainId !== chainId) throw new Error('RPC_CHAIN_MISMATCH');
  const block = await provider.getBlock(input.blockNumber ?? 'latest');
  if (!block?.hash) throw new Error('RPC_BLOCK_UNAVAILABLE');
  const source: SourceRef = { chainId, orgId, contract: paymentManager, contracts: { paymentManager }, endpoint: `rpc:${chainId}`,
    method: 'eth_call', indexed: false, snapshot: 'pinned', block: { number: String(block.number), hash: block.hash, timestamp: String(block.timestamp) } };
  const maxRounds = input.maxRounds ?? 1000;
  const [counterResult, balanceRaw] = await Promise.all([
    tryAggregate(provider, [{ to: paymentManager, data: PM.encodeFunctionData('distributionCounter') }], { blockTag: block.number }),
    asset.address === ethers.constants.AddressZero ? provider.getBalance(paymentManager, block.number).then(String)
      : tryAggregate(provider, [{ to: asset.address, data: ERC20.encodeFunctionData('balanceOf', [paymentManager]) }], { blockTag: block.number })
        .then(rows => { if (!rows[0]?.success) throw new Error('TOKEN_BALANCE_UNAVAILABLE'); return ERC20.decodeFunctionResult('balanceOf', rows[0].returnData)[0].toString(); }),
  ]);
  if (!counterResult[0]?.success) throw new Error('DISTRIBUTION_COUNTER_UNAVAILABLE');
  const counter = PM.decodeFunctionResult('distributionCounter', counterResult[0].returnData)[0].toString();
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 0 || BigInt(counter) > BigInt(maxRounds)) throw new Error('ROUND_CAP');
  const ids = Array.from({ length: Number(counter) }, (_, i) => String(i + 1));
  const rounds = ids.length ? await tryAggregate(provider, ids.map(id => ({ to: paymentManager, data: PM.encodeFunctionData('getDistribution', [id]) })), { blockTag: block.number }) : [];
  const snapshot = await readPaymentManagerPlanningSnapshot({ source, asset, maxRounds, reader: {
    readCounter: async () => knownFact(counter, source),
    readBalance: async () => knownFact(requireRawUint(balanceRaw), { ...source, contract: asset.address === ethers.constants.AddressZero ? paymentManager : asset.address, account: paymentManager }),
    readDistribution: async id => {
      const row = rounds[Number(id) - 1];
      if (!row?.success) throw new Error('DISTRIBUTION_UNAVAILABLE');
      const decoded = PM.decodeFunctionResult('getDistribution', row.returnData);
      return knownFact({ distributionId: id, payoutToken: decoded.payoutToken, totalAmount: decoded.totalAmount.toString(),
        totalClaimed: decoded.totalClaimed.toString(), finalized: decoded.finalized, checkpointBlock: decoded.checkpointBlock.toString() }, source);
    },
  } });
  const closing = await provider.getBlock(block.number);
  if (closing?.hash !== block.hash) throw new Error('RPC_SNAPSHOT_CHANGED');
  const state = paymentManagerPlanningState(snapshot);
  if (state.state !== 'known') throw new Error(state.code);
  return state.value;
}
export function treasuryAvailability(snapshot: SourceSnapshot<PaymentManagerState>, minClaimPeriodBlocks = '0') {
  return paymentManagerAvailability({ snapshot, asset: snapshot.data.asset, scope: snapshot.source, block: snapshot.source.block!, minClaimPeriodBlocks });
}
