import type { Argv } from 'yargs';
import { statusHandler } from './status';
import { subscribeHandler } from './subscribe';
import { readHandler } from './read';
import { listHandler } from './list';
import { snapshotHandler } from './snapshot';
import { migrateHandler } from './migrate';
import { appendLessonHandler } from './append-lesson';
import { editLessonHandler } from './edit-lesson';
import { removeLessonHandler } from './remove-lesson';
import { searchHandler } from './search';
import { tagHandler } from './tag';
import {
  brainstormStartHandler,
  brainstormRespondHandler,
  brainstormPromoteHandler,
  brainstormCloseHandler,
  brainstormRemoveHandler,
} from './brainstorm';
import { newProjectHandler } from './new-project';
import { advanceStageHandler } from './advance-stage';
import { removeProjectHandler } from './remove-project';
import { allowlistHandler } from './allowlist';
import { migrateProjectsHandler } from './migrate-projects';
import { doctorHandler } from './doctor';
import { importSnapshotHandler } from './import-snapshot';
import { daemonHandler } from './daemon';
import { retroStartHandler } from './retro-start';
import { retroListHandler } from './retro-list';
import { retroShowHandler } from './retro-show';
import { retroRespondHandler } from './retro-respond';
import { retroFileTasksHandler } from './retro-file-tasks';
import { retroMarkChangeHandler } from './retro-mark-change';
import { retroRemoveHandler } from './retro-remove';

export function registerBrainCommands(yargs: Argv) {
  return yargs
    .command('status', 'Show local brain layer state (Helia + CRDT sync)', statusHandler.builder, statusHandler.handler)
    .command('subscribe', 'Subscribe to a doc topic; fetch + merge announced blocks (or --log-only)', subscribeHandler.builder, subscribeHandler.handler)
    .command('read', 'Load a brain doc from local state and print its contents', readHandler.builder, readHandler.handler)
    .command('list', 'List all known brain docs with their current head CIDs', listHandler.builder, listHandler.handler)
    .command('snapshot', 'Project a brain doc to markdown on disk (step 7)', snapshotHandler.builder, snapshotHandler.handler)
    .command('migrate', 'Import a hand-written markdown file into a brain doc (step 8)', migrateHandler.builder, migrateHandler.handler)
    .command('append-lesson', 'Append a lesson to a brain doc (signed + gossipsub-published)', appendLessonHandler.builder, appendLessonHandler.handler)
    .command('edit-lesson', 'Update fields on an existing brain lesson (in-place)', editLessonHandler.builder, editLessonHandler.handler)
    .command('remove-lesson', 'Soft-delete a brain lesson (tombstone; filtered from snapshot output)', removeLessonHandler.builder, removeLessonHandler.handler)
    .command('search', 'Filter lessons in a brain doc by query / tag / author / timestamp', searchHandler.builder, searchHandler.handler)
    .command('tag', 'Add or remove tags on an existing brain lesson', tagHandler.builder, tagHandler.handler)
    .command('brainstorm-start', 'Open a new cross-agent brainstorm (task #354 — forward-looking ideation surface)', brainstormStartHandler.builder, brainstormStartHandler.handler)
    .command('brainstorm-respond', 'Post a message, add an idea, or cast votes on an existing brainstorm', brainstormRespondHandler.builder, brainstormRespondHandler.handler)
    .command('brainstorm-promote', 'Promote a brainstorm idea to a pop.brain.projects entry (link via promotedToProjectIds)', brainstormPromoteHandler.builder, brainstormPromoteHandler.handler)
    .command('brainstorm-close', 'Close a brainstorm without promoting any idea', brainstormCloseHandler.builder, brainstormCloseHandler.handler)
    .command('brainstorm-remove', 'Soft-delete a brainstorm (tombstone; filtered from projection output)', brainstormRemoveHandler.builder, brainstormRemoveHandler.handler)
    .command('new-project', 'Create a project entry in pop.brain.projects (signed + gossipsub-published)', newProjectHandler.builder, newProjectHandler.handler)
    .command('advance-stage', 'Move a project forward in the lifecycle (propose → discuss → ... → ship)', advanceStageHandler.builder, advanceStageHandler.handler)
    .command('remove-project', 'Soft-delete a project entry (tombstone; filtered from snapshot output)', removeProjectHandler.builder, removeProjectHandler.handler)
    .command('allowlist <action>', 'Manage the brain allowlist (list/add/remove)', allowlistHandler.builder, allowlistHandler.handler)
    .command('migrate-projects', 'Import projects.md into a pop.brain.projects doc (sprint-3 follow-up to step 8)', migrateProjectsHandler.builder, migrateProjectsHandler.handler)
    .command('doctor', 'Health check for brain layer setup (env, keys, libp2p init, allowlist, manifest)', doctorHandler.builder, doctorHandler.handler)
    .command('import-snapshot', 'Load a raw Automerge snapshot file as the new local head for a brain doc (#353 migration tool for converging disjoint agents onto a shared baseline)', importSnapshotHandler.builder, importSnapshotHandler.handler)
    .command('daemon <action>', 'Manage the persistent brain daemon (start/stop/status/logs) — keeps libp2p alive so gossipsub announcements actually propagate', daemonHandler.builder as any, daemonHandler.handler as any)
    .command(
      'retro <action>',
      'Manage session retros in pop.brain.retros (start/list/show) — recurring self-reflection cycles with proposed changes and cross-agent discussion',
      (yargs) =>
        yargs
          .command(
            'start',
            'Start a new retro with observations + proposed changes',
            retroStartHandler.builder as any,
            retroStartHandler.handler as any,
          )
          .command(
            'list',
            'List retros in pop.brain.retros (optionally filter by --status)',
            retroListHandler.builder as any,
            retroListHandler.handler as any,
          )
          .command(
            'show <retro-id>',
            'Render a single retro as markdown',
            retroShowHandler.builder as any,
            retroShowHandler.handler as any,
          )
          .command(
            'respond',
            'Append a discussion entry (optionally with per-change votes) to an open retro',
            retroRespondHandler.builder as any,
            retroRespondHandler.handler as any,
          )
          .command(
            'file-tasks',
            'Convert agreed retro changes into on-chain tasks (idempotent)',
            retroFileTasksHandler.builder as any,
            retroFileTasksHandler.handler as any,
          )
          .command(
            'mark-change <retro-id> <change-id>',
            'Manually set a proposed-change status (e.g. agreed / rejected / modified) before running file-tasks',
            retroMarkChangeHandler.builder as any,
            retroMarkChangeHandler.handler as any,
          )
          .command(
            'remove <retro-id>',
            'Soft-delete a retro (tombstone; filtered from projection) — useful for test retros and retros started in error',
            retroRemoveHandler.builder as any,
            retroRemoveHandler.handler as any,
          )
          .demandCommand(1, 'Please specify a retro action: start, list, show, respond, file-tasks, mark-change, remove'),
      () => { /* parent command handler is a no-op; subcommands handle it */ },
    )
    .demandCommand(1, 'Please specify a brain action');
}
