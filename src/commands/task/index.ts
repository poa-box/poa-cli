import type { Argv } from 'yargs';
import { createHandler } from './create';
import { listHandler } from './list';
import { viewHandler } from './view';
import { claimHandler } from './claim';
import { submitHandler } from './submit';
import { reviewHandler } from './review';
import { cancelHandler } from './cancel';
import { assignHandler } from './assign';
import { applyHandler } from './apply';
import { approveAppHandler } from './approve-application';
import { createBatchHandler } from './create-batch';
import { statsHandler } from './stats';

export function registerTaskCommands(yargs: Argv) {
  return yargs
    .command('create', 'Create a new task', createHandler.builder, createHandler.handler)
    .command('create-batch', 'Create tasks from JSONL file via atomic batch (createTasksBatch contract call — single tx, all-or-nothing semantics)', createBatchHandler.builder, createBatchHandler.handler)
    .command('list', 'List tasks', listHandler.builder, listHandler.handler)
    .command('view', 'View task details', viewHandler.builder, viewHandler.handler)
    .command('claim', 'Claim a task', claimHandler.builder, claimHandler.handler)
    .command('submit', 'Submit work for a task', submitHandler.builder, submitHandler.handler)
    .command('review', 'Approve or reject a submitted task', reviewHandler.builder, reviewHandler.handler)
    .command('cancel', 'Cancel an unclaimed task', cancelHandler.builder, cancelHandler.handler)
    .command('assign', 'Assign a task to a user', assignHandler.builder, assignHandler.handler)
    .command('apply', 'Apply for a task', applyHandler.builder, applyHandler.handler)
    .command('approve-app', 'Approve a task application', approveAppHandler.builder, approveAppHandler.handler)
    .command('stats', 'Show per-member contribution analytics', statsHandler.builder, statsHandler.handler)
    .demandCommand(1, 'Please specify a task action');
}
