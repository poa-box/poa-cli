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
import { proposeFinalizeHandler } from './propose-finalize';

export function registerTreasuryCommands(yargs: Argv) {
  return yargs
    .command('view', 'View treasury overview', viewHandler.builder, viewHandler.handler)
    .command('balance', 'Show token holdings', balanceHandler.builder, balanceHandler.handler)
    .command('deposit', 'Deposit ERC20 tokens to treasury', depositHandler.builder, depositHandler.handler)
    .command('propose-swap', 'Propose a token swap via governance vote', proposeSwapHandler.builder, proposeSwapHandler.handler)
    .command('claim', 'Claim from a distribution with a manual amount + proof (prefer claim-mine)', claimHandler.builder, claimHandler.handler)
    .command('distributions', 'List distributions with finalized/finalizable state', distributionsHandler.builder, distributionsHandler.handler)
    .command('opt-out', 'Opt out of distributions', optOutHandler.builder, optOutHandler.handler)
    .command('opt-in', 'Opt back into distributions', optOutHandler.builderIn, optOutHandler.handlerIn)
    .command('compute-merkle', 'Compute merkle tree for PT-based distribution', computeMerkleHandler.builder, computeMerkleHandler.handler)
    .command('propose-distribution', 'Propose a distribution via governance vote', proposeDistributionHandler.builder, proposeDistributionHandler.handler)
    .command('claim-mine', 'Auto-claim from all unclaimed distributions (recommended claim path)', claimMineHandler.builder, claimMineHandler.handler)
    .command('send', 'Propose a transfer from Executor via governance', sendHandler.builder, sendHandler.handler)
    .command('propose-sdai', 'Propose depositing xDAI into sDAI for yield', proposeSdaiHandler.builder, proposeSdaiHandler.handler)
    .command('propose-finalize', 'Propose closing a distribution via governance (returns unclaimed funds to the treasury)', proposeFinalizeHandler.builder, proposeFinalizeHandler.handler)
    .demandCommand(1, 'Please specify a treasury action')
    .epilogue('Guide: see docs/guides/treasury-and-tokens.md');
}
