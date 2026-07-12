import type { Argv } from 'yargs';
import { createModuleHandler } from './create-module';
import { listHandler } from './list';
import { completeHandler } from './complete';
import { updateModuleHandler } from './update';
import { removeModuleHandler } from './remove';

export function registerEducationCommands(yargs: Argv) {
  return yargs
    .command('create', 'Create a learning module that rewards PT on completion', createModuleHandler.builder, createModuleHandler.handler)
    .command('list', 'List education modules', listHandler.builder, listHandler.handler)
    .command('update', 'Update a module\'s payout/metadata — read-then-merge full edit', updateModuleHandler.builder, updateModuleHandler.handler)
    .command('remove', 'Permanently remove a module (destructive — no undo)', removeModuleHandler.builder, removeModuleHandler.handler)
    .command('complete', 'Complete a module\'s quiz and claim its PT reward', completeHandler.builder, completeHandler.handler)
    .demandCommand(1, 'Please specify an education action')
    .example('pop education list --json', 'Machine-readable module list');
}
