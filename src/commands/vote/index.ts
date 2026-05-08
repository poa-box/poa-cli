import type { Argv } from 'yargs';
import { createHandler } from './create';
import { castHandler } from './cast';
import { listHandler } from './list';
import { announceHandler } from './announce';
import { executeHandler } from './execute';
import { announceAllHandler } from './announce-all';
import { proposeQuorumHandler } from './propose-quorum';
import { proposeConfigHandler } from './propose-config';
import { analyzeHandler } from './analyze';
import { resultsHandler } from './results';
import { simulateHandler } from './simulate';
import { postMortemHandler } from './post-mortem';
import { discussHandler } from './discuss';
import { conflictsHandler } from './conflicts';

export function registerVoteCommands(yargs: Argv) {
  return yargs
    .command('create', 'Create a proposal', createHandler.builder, createHandler.handler)
    .command('cast', 'Cast a vote', castHandler.builder, castHandler.handler)
    .command('list', 'List proposals', listHandler.builder, listHandler.handler)
    .command('announce', 'Announce proposal winner', announceHandler.builder, announceHandler.handler)
    .command('execute', 'Execute a passed proposal\'s calls', executeHandler.builder, executeHandler.handler)
    .command('announce-all', 'Announce all ended proposals', announceAllHandler.builder, announceAllHandler.handler)
    .command('propose-quorum', 'Create a proposal to change voting quorum', proposeQuorumHandler.builder, proposeQuorumHandler.handler)
    .command('propose-config', 'Create a proposal to change a governance config parameter', proposeConfigHandler.builder, proposeConfigHandler.handler)
    .command('analyze', 'Analyze a hybrid vote — power breakdown and counterfactuals', analyzeHandler.builder, analyzeHandler.handler)
    .command('results', 'Show vote results with option names and rankings', resultsHandler.builder, resultsHandler.handler)
    .command('simulate', 'Simulate proposal execution calls against forked chain state via Foundry', simulateHandler.builder, simulateHandler.handler)
    .command('post-mortem', 'Walk debug_traceTransaction call-tree to identify root-cause frame on failed announce/execute (companion to simulate; catches failures AFTER on-chain revert)', postMortemHandler.builder, postMortemHandler.handler)
    .command('discuss', 'Proposal discussion system — IPFS-indexed comments with cross-agent merge', discussHandler.builder, discussHandler.handler)
    .command('conflicts', 'Detect resource-claim conflicts across active proposals (vigil auditor-lens)', conflictsHandler.builder, conflictsHandler.handler)
    .demandCommand(1, 'Please specify a vote action');
}
