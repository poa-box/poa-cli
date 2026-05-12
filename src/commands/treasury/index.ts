import type { Argv } from 'yargs';
import { viewHandler } from './view';
import { balanceHandler } from './balance';
import { depositHandler } from './deposit';
import { proposeSwapHandler } from './propose-swap';
import { claimHandler } from './claim';
import { distributionsHandler } from './distributions';
import { optOutHandler } from './opt-out';
import { computeMerkleHandler } from './compute-merkle';
import { proposeDistributionHandler } from './propose-distribution';
import { claimMineHandler } from './claim-mine';
import { sendHandler } from './send';
import { proposeSdaiHandler } from './propose-sdai';
import { incomingHandler } from './incoming';
import { bridgeHandler } from './bridge';
import { healthHandler } from './health';

export function registerTreasuryCommands(yargs: Argv) {
  return yargs
    .command('view', 'View treasury overview', viewHandler.builder, viewHandler.handler)
    .command('balance', 'Show token holdings', balanceHandler.builder, balanceHandler.handler)
    .command('health', 'Treasury runway + sDAI yield projection + status flag (HB#659 Sprint 21 project A D2)', healthHandler.builder, healthHandler.handler)
    .command('deposit', 'Deposit ERC20 tokens to treasury', depositHandler.builder, depositHandler.handler)
    .command('propose-swap', 'Propose a token swap via governance vote', proposeSwapHandler.builder, proposeSwapHandler.handler)
    .command('claim', 'Claim from a distribution', claimHandler.builder, claimHandler.handler)
    .command('distributions', 'List distributions', distributionsHandler.builder, distributionsHandler.handler)
    .command('opt-out', 'Opt out of distributions', optOutHandler.builder, optOutHandler.handler)
    .command('opt-in', 'Opt back into distributions', optOutHandler.builderIn, optOutHandler.handlerIn)
    .command('compute-merkle', 'Compute merkle tree for PT-based distribution', computeMerkleHandler.builder, computeMerkleHandler.handler)
    .command('propose-distribution', 'Propose a distribution via governance vote', proposeDistributionHandler.builder, proposeDistributionHandler.handler)
    .command('claim-mine', 'Auto-claim from all unclaimed distributions', claimMineHandler.builder, claimMineHandler.handler)
    .command('send', 'Propose a transfer from Executor via governance', sendHandler.builder, sendHandler.handler)
    .command('propose-sdai', 'Propose depositing xDAI into sDAI for yield', proposeSdaiHandler.builder, proposeSdaiHandler.handler)
    .command('incoming', 'List recent incoming token transfers to Executor (recovered HB#615 from unwired state)', incomingHandler.builder, incomingHandler.handler)
    .command('bridge', 'Propose cross-chain bridge transfer via governance (recovered HB#615 from unwired state)', bridgeHandler.builder, bridgeHandler.handler)
    .demandCommand(1, 'Please specify a treasury action');
}
