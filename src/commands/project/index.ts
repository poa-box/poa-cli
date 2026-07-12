import type { Argv } from 'yargs';
import { createHandler } from './create';
import { listHandler } from './list';
import { deleteHandler } from './delete';
import { proposeHandler } from './propose';

export function registerProjectCommands(yargs: Argv) {
  return yargs
    .command('create', 'Create a new project (direct tx; creator-hat/executor)', createHandler.builder, createHandler.handler)
    .command('propose', 'Propose a new project via governance vote', proposeHandler.builder, proposeHandler.handler)
    .command('list', 'List projects', listHandler.builder, listHandler.handler)
    .command('delete', 'Delete a project (destructive; creator-hat/executor)', deleteHandler.builder, deleteHandler.handler)
    .demandCommand(1, 'Please specify a project action')
    .epilogue('Guide: see docs/guides/tasks.md');
}
