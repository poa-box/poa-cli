/** Explicit third-party EOA recovery only. No initiation, Permit2 signing or implicit deployment addresses. */
import type { Argv } from 'yargs';
import { ethers } from 'ethers';
import { GraphQLClient } from 'graphql-request';
import { CASHOUT_RELAY_ABI_V1, CASHOUT_ESCROW_ABI_V1, projectRecoveryFacts, buildRecoverFailed, buildWithdrawDeposit,
  readCashoutDiscovery, prepareCashoutPayload, encodeCashoutPayload, decodeCashoutDeposit, type CashoutDescriptor, type CashoutRecoveryState } from '@poa-box/core/integrations/cashout';
import { EOA_DELEGATION } from '@poa-box/core/accounts/constants';
import { knownFact, type SourceRef, type SourceSnapshot } from '@poa-box/core/data/facts';
import { requireRawUint } from '@poa-box/core/amounts';
import { resolveIdentityAddress, createSigner } from '../../lib/signer';
import { tryAggregate } from '../../lib/multicall';
import { executeIntent } from '../../lib/tx';
import { confirmWrite, finishWrite } from '../../lib/command';
import { redactSubgraphUrl } from '../../lib/subgraph';
import * as output from '../../lib/output';

const RELAY = new ethers.utils.Interface([...CASHOUT_RELAY_ABI_V1, 'function escrow() view returns(address)']);
const ESCROW = new ethers.utils.Interface([...CASHOUT_ESCROW_ABI_V1]);
function descriptor(argv: any): CashoutDescriptor {
  if (!Number.isSafeInteger(argv.chain) || argv.chain <= 0) throw new Error('--chain must explicitly identify the cashout chain');
  const value = { chainId: argv.chain, relay: ethers.utils.getAddress(argv.relay), escrow: ethers.utils.getAddress(argv.escrow), token: ethers.utils.getAddress(argv.token) };
  if (Object.values(value).some(v => v === ethers.constants.AddressZero)) throw new Error('Cashout descriptor contains a zero address');
  return value;
}
async function observe(argv: any, account: string) {
  const deployment = descriptor(argv), provider = new ethers.providers.JsonRpcProvider(argv.rpc);
  if ((await provider.getNetwork()).chainId !== deployment.chainId) throw new Error('CASHOUT_RPC_CHAIN_MISMATCH');
  const block = await provider.getBlock('latest');
  const source: SourceRef = { chainId: deployment.chainId, account, contract: argv.request ? deployment.relay : deployment.escrow,
    endpoint: `cashout-rpc:${deployment.chainId}`, method: 'eth_call', indexed: false, snapshot: 'pinned',
    block: { number: String(block.number), hash: block.hash, timestamp: String(block.timestamp) } };
  const binding = await tryAggregate(provider, ['usdc', 'escrow'].map(name => ({ to: deployment.relay, data: RELAY.encodeFunctionData(name) })), { blockTag: block.number });
  if (binding.some(r => !r.success) || RELAY.decodeFunctionResult('usdc', binding[0].returnData)[0].toLowerCase() !== deployment.token.toLowerCase()
    || RELAY.decodeFunctionResult('escrow', binding[1].returnData)[0].toLowerCase() !== deployment.escrow.toLowerCase()) throw new Error('CASHOUT_RELAY_DESCRIPTOR_MISMATCH');
  const code = (await provider.getCode(account, block.number)).toLowerCase();
  const capability = code === '0x' || code === `0xef0100${EOA_DELEGATION.slice(2).toLowerCase()}`;
  let state: CashoutRecoveryState;
  if (argv.request) {
    if (!ethers.utils.isHexString(argv.request, 32)) throw new Error('Invalid --request hash');
    const rows = await tryAggregate(provider, ['failedDepositor', 'failedAmount'].map(name => ({ to: deployment.relay, data: RELAY.encodeFunctionData(name, [argv.request]) })), { blockTag: block.number });
    if (rows.some(r => !r.success)) throw new Error('CASHOUT_FAILED_STATE_UNAVAILABLE');
    state = { kind: 'failed', requestHash: argv.request, depositor: RELAY.decodeFunctionResult('failedDepositor', rows[0].returnData)[0],
      amountRaw: RELAY.decodeFunctionResult('failedAmount', rows[1].returnData)[0].toString(), token: deployment.token };
  } else {
    const id = requireRawUint(argv.deposit), rows = await tryAggregate(provider, [{ to: deployment.escrow, data: ESCROW.encodeFunctionData('getDeposit', [id]) }], { blockTag: block.number });
    if (!rows[0]?.success) throw new Error('CASHOUT_ESCROW_STATE_UNAVAILABLE');
    const row = ESCROW.decodeFunctionResult('getDeposit', rows[0].returnData)[0];
    state = { kind: 'escrow', depositId: id, depositor: row.depositor, token: row.token,
      remainingDeposits: row.remainingDeposits.toString(), outstandingIntentAmount: row.outstandingIntentAmount.toString() };
  }
  if ((await provider.getBlock(block.number)).hash !== block.hash) throw new Error('CASHOUT_SNAPSHOT_CHANGED');
  const snapshot: SourceSnapshot<CashoutRecoveryState> = { source, data: state,
    coverage: { status: 'complete', receivedKeys: ['state', 'descriptor', 'account-code'], missingIds: [], failedIds: [], issues: [] } };
  const facts = projectRecoveryFacts({ descriptor: deployment, account, block: source.block!, snapshot, transactionCapability: knownFact(capability, source) });
  return { descriptor: deployment, provider, source, snapshot, facts };
}
function selector(argv: any) {
  if (Boolean(argv.request) === (argv.deposit !== undefined)) throw new Error('Provide exactly one of --request or --deposit');
}
export function registerCashoutCommands(yargs: Argv) {
  const base = (y: Argv) => y.option('relay', { type: 'string', demandOption: true, describe: 'Explicit cashout relay address' })
    .option('escrow', { type: 'string', demandOption: true, describe: 'Explicit escrow address' })
    .option('token', { type: 'string', demandOption: true, describe: 'Explicit USDC token address' })
    .option('rpc', { type: 'string', demandOption: true, describe: 'RPC endpoint for the explicitly selected external chain' })
    .option('address', { type: 'string', describe: 'Observe as this account without a key' });
  const selected = (y: Argv) => base(y).option('request', { type: 'string', describe: 'Failed relay request hash' })
    .option('deposit', { type: 'string', describe: 'Escrow deposit ID' });
  return yargs.command('payload', 'Encode an unsigned opt-in cashout schema payload from explicit quote fields', y => y
    .option('depositor', { type: 'string', demandOption: true, describe: 'EOA depositor address' })
    .option('payment-method', { type: 'string', demandOption: true, describe: 'Payment method bytes32' })
    .option('payee-details-hash', { type: 'string', demandOption: true, describe: 'Payee details bytes32 digest' })
    .option('fiat-currency', { type: 'string', demandOption: true, describe: 'Fiat currency bytes32' })
    .option('conversion-rate', { type: 'string', demandOption: true, describe: 'Explicit conversion rate (18 decimals)' })
    .option('min-amount', { type: 'string', demandOption: true, describe: 'Minimum intent in 6-decimal token units' })
    .option('max-amount', { type: 'string', demandOption: true, describe: 'Maximum intent in 6-decimal token units' }), argv => {
      try {
        const payload = prepareCashoutPayload({ depositor: argv.depositor as string, paymentMethod: argv.paymentMethod as string,
          payeeDetailsHash: argv.payeeDetailsHash as string, fiatCurrency: argv.fiatCurrency as string,
          conversionRateDecimal: argv.conversionRate as string, minIntentDecimal: argv.minAmount as string, maxIntentDecimal: argv.maxAmount as string });
        const result = { payload, encoded: encodeCashoutPayload(payload), initiationCapability: 'unproven' };
        if (output.isJsonMode()) output.json(result); else output.info(JSON.stringify(result, null, 2));
      } catch (error: any) { output.error(error.message); process.exitCode = 1; }
    }).command('deposit-from-receipt', 'Resolve an exact escrow deposit from one chain-checked receipt', y => base(y)
      .option('transaction', { type: 'string', demandOption: true, describe: 'Exact cashout deposit transaction hash' })
      .option('deposit', { type: 'string', describe: 'Optional known deposit ID to narrow ambiguous logs' }), async argv => {
        try {
          if (!ethers.utils.isHexString(argv.transaction as string, 32)) throw new Error('Invalid receipt transaction hash');
          const account = resolveIdentityAddress(argv, { required: true })!;
          const observation = await observe({ ...argv, request: ethers.constants.HashZero }, account);
          const receipt = await observation.provider.getTransactionReceipt(argv.transaction as string);
          if (!receipt || receipt.status !== 1 || receipt.transactionHash.toLowerCase() !== String(argv.transaction).toLowerCase()) throw new Error('Successful exact cashout receipt is unavailable');
          const canonical = await observation.provider.getBlock(receipt.blockNumber);
          if (canonical?.hash !== receipt.blockHash) throw new Error('Receipt inclusion is noncanonical');
          const result = decodeCashoutDeposit({ descriptor: observation.descriptor, chainId: observation.descriptor.chainId,
            depositor: account, transactionHash: receipt.transactionHash, depositId: argv.deposit as string | undefined,
            logs: receipt.logs.map(log => ({ ...log, logIndex: String(log.logIndex) })) });
          if (output.isJsonMode()) output.json(result); else output.info(JSON.stringify(result, null, 2));
        } catch (error: any) { output.error(error.message); process.exitCode = 1; }
      }).command('status', 'Inspect pinned recovery facts for an explicit EOA cashout request/deposit', selected, async argv => {
    try { selector(argv); const account = resolveIdentityAddress(argv, { required: true })!;
      const result = await observe(argv, account); const data = { descriptor: result.descriptor, snapshot: result.snapshot, facts: result.facts };
      if (output.isJsonMode()) output.json(data); else output.info(JSON.stringify(data, null, 2));
    } catch (error: any) { output.error(error.message); process.exitCode = 1; }
  }).command('discover', 'Enumerate external cashout candidates; pinned RPC still determines recoverability', y => base(y)
    .option('subgraph', { type: 'string', demandOption: true, describe: 'Explicit single-relay indexed endpoint' })
    .option('page-size', { type: 'number', default: 100, describe: 'Candidate page size (1–1000)' })
    .option('max-pages', { type: 'number', default: 20, describe: 'Finite cap per status stream' }), async argv => {
      try {
        const deployment = descriptor(argv), account = resolveIdentityAddress(argv, { required: true })!;
        const client = new GraphQLClient(argv.subgraph as string);
        const meta = await client.request<any>('query { _meta { block { number hash } } }');
        if (!meta?._meta?.block?.hash) throw new Error('CASHOUT_INDEX_BLOCK_UNAVAILABLE');
        const rpcObservation = await observe({ ...argv, request: ethers.constants.HashZero }, account);
        const indexBlock = await rpcObservation.provider.getBlock(Number(requireRawUint(meta._meta.block.number, 53)));
        if (indexBlock?.hash?.toLowerCase() !== meta._meta.block.hash.toLowerCase()) throw new Error('CASHOUT_INDEX_CHAIN_BINDING_UNPROVEN');
        const source: SourceRef = { chainId: deployment.chainId, account, contract: deployment.relay,
          endpoint: redactSubgraphUrl(argv.subgraph as string) ?? 'cashout-indexed-endpoint', method: 'graph', indexed: true, snapshot: 'pinned',
          block: { number: requireRawUint(meta._meta.block.number), hash: meta._meta.block.hash } };
        if (!Number.isSafeInteger(argv.maxPages) || Number(argv.maxPages) < 1 || Number(argv.maxPages) > 1000) throw new Error('Invalid cashout discovery bounds');
        const result = await readCashoutDiscovery({ descriptor: deployment, source, pageSize: argv.pageSize as number, maxPages: argv.maxPages as number,
          query: (document, variables) => client.request(document, variables) });
        if (output.isJsonMode()) output.json(result); else output.info(JSON.stringify(result, null, 2));
      } catch { output.error('Cashout discovery unavailable; verify the explicit endpoint, chain and relay descriptor.'); process.exitCode = 1; }
    }).command('recover-failed', 'Return a failed cashout request to its EOA owner', y => base(y).option('request', { type: 'string', demandOption: true, describe: 'Exact failed request hash' }),
      async argv => write(argv, 'failed'))
    .command('withdraw-deposit', 'Withdraw the remaining escrow deposit owned by your EOA', y => base(y).option('deposit', { type: 'string', demandOption: true, describe: 'Exact escrow deposit ID' }),
      async argv => write(argv, 'escrow'))
    .demandCommand(1, 'Specify status, discover, recover-failed or withdraw-deposit');
}
async function write(argv: any, kind: 'failed' | 'escrow') {
  try {
    const deployment = descriptor(argv), signerContext = createSigner({ chainId: deployment.chainId, rpcUrl: argv.rpc, privateKey: argv.privateKey, allowCustomChain: true });
    const state = await observe(argv, signerContext.address), facts = state.facts;
    if (facts.state !== 'known' || !facts.value.owner || facts.value.recoverableAmountRaw === '0'
      || facts.value.transactionOnlyCapability.state !== 'known' || !facts.value.transactionOnlyCapability.value) throw new Error('EOA ownership, positive balance or transaction capability is unproven');
    await confirmWrite(argv, { action: kind === 'failed' ? 'recover failed cashout' : 'withdraw escrow deposit', account: signerContext.address,
      amountRaw: facts.value.recoverableAmountRaw, chain: deployment.chainId }, { destructive: true, actionLabel: 'About to recover cashout funds' });
    const intent = kind === 'failed' ? buildRecoverFailed({ descriptor: deployment, requestHash: argv.request })
      : buildWithdrawDeposit({ descriptor: deployment, depositId: argv.deposit });
    const result = await executeIntent(signerContext.signer, intent, { dryRun: argv.dryRun });
    finishWrite(result, { successMsg: 'Cashout funds recovered', fields: { requestHash: argv.request, depositId: argv.deposit,
      amountRaw: facts.value.recoverableAmountRaw, outstandingIntentAmountRaw: facts.value.outstandingIntentAmountRaw, chainId: deployment.chainId } });
  } catch (error: any) { output.error(error.message); process.exitCode = 1; }
}
