/** Compiled/runnable consumer examples. All data and IO are explicit fixtures. */
import { buildSendProposalExact } from '../../../../src/tx/treasury';
import { planTreasuryTransfer, type PaymentManagerState } from '../../../../src/treasury/planning';
import { knownFact, type SourceSnapshot } from '../../../../src/data/facts';
import { buildWithdrawDeposit } from '../../../../src/integrations/cashout';
import { encodeIntent } from '../../../../src/tx/intent';
import { buildDistributionClaimsDocument, verifyDistributionClaimsDocument, findDistributionClaim } from '../../../../src/metadata/distribution';
import { bytes32ToCidV0 } from '../../../../src/encoding/cid';
import goldens from './merkle-goldens.json';

const A = '0x0000000000000000000000000000000000000001';
const PM = '0x0000000000000000000000000000000000000011';
const TM = '0x0000000000000000000000000000000000000012';
const TOKEN = '0x0000000000000000000000000000000000000013';
const HV = '0x0000000000000000000000000000000000000014';
const ORG = '0x' + '11'.repeat(32), HASH = '0x' + '22'.repeat(32);

export function exampleExactNativeSend() {
  return buildSendProposalExact({ hybridVotingAddress: HV, recipients: [{ to: A, amount: '0.123456789123456789' }], tokenAddress: null,
    decimals: 18, tokenLabel: 'native', descriptionHash: HASH, durationMinutes: '60', orgId: ORG }).meta.summary;
}
export function exampleTransferPlan() {
  const state: PaymentManagerState = { asset: { chainId: 100, address: TOKEN, decimals: 6 }, balanceRaw: '70', distributionCounterRaw: '2', rounds: [
    { distributionId: '1', payoutToken: TOKEN, totalAmount: '100', totalClaimed: '100', finalized: false, checkpointBlock: '1', creationBlock: knownFact('80') },
    { distributionId: '2', payoutToken: TOKEN, totalAmount: '50', totalClaimed: '30', finalized: false, checkpointBlock: '1', creationBlock: knownFact('80') },
  ] };
  const snapshot: SourceSnapshot<PaymentManagerState> = { source: { chainId: 100, orgId: ORG, contract: PM, endpoint: 'mock://rpc', method: 'complete-enumeration', indexed: false,
    snapshot: 'pinned', block: { number: '100', hash: HASH } }, data: state, coverage: { status: 'complete', receivedKeys: ['1', '2'], missingIds: [], failedIds: [], issues: [] } };
  return planTreasuryTransfer({ scope: { chainId: 100, orgId: ORG, contracts: { paymentManager: PM } }, block: { number: '100', hash: HASH }, asset: state.asset,
    destination: TM, amountRaw: '20', sources: [{ kind: 'payment-manager', address: PM, snapshot }], minClaimPeriodBlocks: '20' });
}
export function exampleStoredClaim() {
  const document = buildDistributionClaimsDocument({ token: TOKEN, tokenSymbol: 'USDC', totalAmount: '10', checkpointBlock: 99, merkleRoot: goldens.host10.root,
    claims: Object.fromEntries(goldens.host10.leaves.map(([address, amount], i) => [address, { amount, proof: goldens.host10.proofs[i] }])), createdAt: 1700000000000 });
  const cid = bytes32ToCidV0(HASH);
  const verified = verifyDistributionClaimsDocument(document, { loadedCid: cid, reference: { chainId: 100, orgId: ORG, paymentManager: PM, distributionId: '1',
    cid, merkleRoot: document.merkleRoot, token: TOKEN, totalAmount: '10', checkpointBlock: '99' } });
  return findDistributionClaim(verified, A);
}
export function exampleCashoutWithdrawal() {
  return encodeIntent(buildWithdrawDeposit({ descriptor: { chainId: 8453, relay: PM, escrow: TM, token: TOKEN }, depositId: '9007199254740993' }));
}
