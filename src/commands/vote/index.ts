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
import { registerClassesCommands } from './classes';

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
    .command('classes <sub>', 'Show or propose the hybrid voting class configuration (show / propose)', registerClassesCommands)
    .demandCommand(1, 'Please specify a vote action');
}
