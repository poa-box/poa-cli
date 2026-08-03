/**
 * pop brain brainstorm-* — cross-agent ideation surface commands.
 *
 * Task #354 phase (b) (HB#208). Forward-looking companion to
 * pop.brain.retros (reactive session retrospectives) and
 * pop.brain.projects (lifecycle state machine for existing projects).
 *
 * The brainstorm surface is the missing deliberation primitive for
 * new ideation: agents post a theme/question, debate it via messages +
 * ideas + per-agent votes (support/explore/oppose), and top-ranked
 * ideas get promoted to pop.brain.projects at the `propose` stage.
 * Promotion links back via the `promotedToProjectIds` array.
 *
 * All commands dispatch through routedDispatch so they work with or
 * without the brain daemon. Schema validation (#346) catches malformed
 * writes at applyBrainChange time.
 *
 * Five sub-commands registered from src/commands/brain/index.ts:
 *   pop brain brainstorm-start      — open a new brainstorm
 *   pop brain brainstorm-respond    — post message / add idea / cast vote
 *   pop brain brainstorm-promote    — promote an idea to a brain project
 *   pop brain brainstorm-close      — close a brainstorm with no promotion
 *   pop brain brainstorm-remove     — soft-delete tombstone
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { openBrainDoc, stopBrainNode } from '../../lib/brain';
import { routedDispatch } from '../../lib/brain-ops';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '@poa-box/cli/lib/idempotency';
import * as output from '@poa-box/cli/lib/output';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveAuthor(argvAuthor: string | undefined): string {
  if (argvAuthor) return argvAuthor;
  const key = process.env.POP_PRIVATE_KEY;
  if (!key) {
    throw new Error('POP_PRIVATE_KEY not set — cannot derive default author. Pass --author explicitly.');
  }
  return new ethers.Wallet(key).address.toLowerCase();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// pop brain brainstorm-start
// ---------------------------------------------------------------------------

interface StartArgs {
  doc: string;
  title: string;
  prompt: string;
  author?: string;
  id?: string;
  windowFromHb?: number;
  windowToHb?: number;
}

export const brainstormStartHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (default: pop.brain.brainstorms)',
        type: 'string',
        default: 'pop.brain.brainstorms',
      })
      .option('title', {
        describe: 'Short brainstorm title (used as default slug for id)',
        type: 'string',
        demandOption: true,
      })
      .option('prompt', {
        describe: 'Longer description / question being brainstormed',
        type: 'string',
        demandOption: true,
      })
      .option('author', {
        describe: 'Override the author address (default: signing wallet)',
        type: 'string',
      })
      .option('id', {
        describe: 'Override the auto-generated brainstorm id',
        type: 'string',
      })
      .option('window-from-hb', {
        describe: 'Starting HB number of the brainstorm window',
        type: 'number',
      })
      .option('window-to-hb', {
        describe: 'Ending HB number of the brainstorm window',
        type: 'number',
      })
      .option('idempotency-key', { type: 'string', describe: 'Task #375 (HB#217) idempotency cache.' })
      .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache.' }),

  handler: async (argv: ArgumentsCamelCase<StartArgs>) => {
    try {
      const author = resolveAuthor(argv.author);
      const now = Math.floor(Date.now() / 1000);
      const id = argv.id ?? `${slugify(argv.title) || 'brainstorm'}-${now}`;

      // Task #375 idempotency check, agent-scoped
      const idempKey = (argv as any).idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!(argv as any).noIdempotency) {
        const cached = checkIdempotencyCache(author, 'brain.brainstormStart', idempKey);
        if (cached) {
          if (output.isJsonMode()) output.json({ status: 'ok', cached: true, ...cached });
          else console.log(`  Brainstorm already opened (idempotency cache hit). id: ${cached.brainstormId} head: ${cached.headCid}`);
          return;
        }
      }

      const result = await routedDispatch({
        type: 'startBrainstorm',
        docId: argv.doc,
        brainstormId: id,
        title: argv.title,
        prompt: argv.prompt,
        author,
        openedAt: now,
        windowFromHB: argv.windowFromHb,
        windowToHB: argv.windowToHb,
      });

      if (!(argv as any).noIdempotency) {
        recordIdempotentResult(author, 'brain.brainstormStart', idempKey, {
          docId: argv.doc,
          brainstormId: id,
          headCid: result.headCid,
        });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          brainstormId: id,
          headCid: result.headCid,
          author,
          routedViaDaemon: result.routedViaDaemon,
        });
      } else {
        console.log('');
        console.log(`  Brainstorm opened in ${argv.doc}`);
        console.log(`  id:       ${id}`);
        console.log(`  title:    ${argv.title}`);
        console.log(`  author:   ${author}`);
        console.log(`  head:     ${result.headCid}`);
        console.log(`  routed:   ${result.routedViaDaemon ? 'via brain daemon' : 'in-process (no daemon)'}`);
        console.log('');
        console.log(
          `  Other agents respond via pop brain brainstorm-respond --id ${id} ` +
            `[--message M] [--add-idea M] [--vote idea-id=stance].`,
        );
        console.log('');
      }
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    } finally {
      await stopBrainNode();
    }
  },
};

// ---------------------------------------------------------------------------
// pop brain brainstorm-respond
// ---------------------------------------------------------------------------

interface RespondArgs {
  doc: string;
  id: string;
  author?: string;
  message?: string;
  addIdea?: string;
  vote?: string[];
}

export const brainstormRespondHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        type: 'string',
        default: 'pop.brain.brainstorms',
      })
      .option('id', {
        describe: 'Brainstorm id to respond to',
        type: 'string',
        demandOption: true,
      })
      .option('author', {
        describe: 'Override the author address',
        type: 'string',
      })
      .option('message', {
        describe: 'Free-form discussion message to post',
        type: 'string',
      })
      .option('add-idea', {
        describe: 'Add a new idea with this text (id auto-generated from a slug)',
        type: 'string',
      })
      .option('vote', {
        describe: 'Cast a vote: <idea-id>=<support|explore|oppose>. Repeatable.',
        type: 'array',
        string: true,
      })
      .option('idempotency-key', { type: 'string', describe: 'Task #375 (HB#217) idempotency cache.' })
      .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache.' })
      .check((argv) => {
        if (!argv.message && !argv.addIdea && (!argv.vote || argv.vote.length === 0)) {
          throw new Error('Must supply at least one of --message / --add-idea / --vote');
        }
        return true;
      }),

  handler: async (argv: ArgumentsCamelCase<RespondArgs>) => {
    try {
      const author = resolveAuthor(argv.author);
      const now = Math.floor(Date.now() / 1000);

      // Pre-flight lookup to fail fast with candidate ids if missing
      const { doc: currentDoc } = await openBrainDoc(argv.doc);
      const brainstorms: any[] = Array.isArray(currentDoc?.brainstorms) ? currentDoc.brainstorms : [];
      const target = brainstorms.find((b: any) => b && b.id === argv.id);
      if (!target) {
        const candidates = brainstorms
          .map((b: any) => b?.id)
          .filter((id: any) => typeof id === 'string')
          .slice(0, 8);
        output.error(
          `Brainstorm "${argv.id}" not found in ${argv.doc}. ` +
            `Available ids (first 8): ${candidates.join(', ') || '(none)'}`,
        );
        process.exitCode = 1;
        return;
      }

      // Parse --vote entries into { ideaId: stance }
      const votes: Record<string, 'support' | 'explore' | 'oppose'> = {};
      for (const entry of argv.vote ?? []) {
        const [ideaId, stance] = entry.split('=').map((s) => s.trim());
        if (!ideaId || !stance) {
          throw new Error(`Malformed --vote "${entry}" — expected format <idea-id>=<stance>`);
        }
        if (stance !== 'support' && stance !== 'explore' && stance !== 'oppose') {
          throw new Error(`Invalid stance "${stance}" in --vote "${entry}" — must be support|explore|oppose`);
        }
        votes[ideaId] = stance;
      }

      // If adding an idea, generate a new idea id from a slug
      let addIdeaPayload: { id: string; message: string } | undefined;
      if (argv.addIdea) {
        const ideaId = `${slugify(argv.addIdea) || 'idea'}-${now}`;
        addIdeaPayload = { id: ideaId, message: argv.addIdea };
      }

      // Task #375 idempotency check, agent-scoped
      const idempKey = (argv as any).idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!(argv as any).noIdempotency) {
        const cached = checkIdempotencyCache(author, 'brain.brainstormRespond', idempKey);
        if (cached) {
          if (output.isJsonMode()) output.json({ status: 'ok', cached: true, ...cached });
          else console.log(`  Brainstorm response already recorded (idempotency cache hit). head: ${cached.headCid}`);
          return;
        }
      }

      const result = await routedDispatch({
        type: 'respondToBrainstorm',
        docId: argv.doc,
        brainstormId: argv.id,
        author,
        message: argv.message,
        addIdea: addIdeaPayload,
        votes: Object.keys(votes).length > 0 ? votes : undefined,
        timestamp: now,
      });

      if (!(argv as any).noIdempotency) {
        recordIdempotentResult(author, 'brain.brainstormRespond', idempKey, {
          docId: argv.doc,
          brainstormId: argv.id,
          headCid: result.headCid,
        });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          brainstormId: argv.id,
          ideaAdded: addIdeaPayload?.id ?? null,
          votesCast: Object.keys(votes),
          message: argv.message ? 'posted' : null,
          headCid: result.headCid,
          author,
          routedViaDaemon: result.routedViaDaemon,
        });
      } else {
        console.log('');
        console.log(`  Responded to brainstorm "${argv.id}" in ${argv.doc}`);
        if (argv.message) console.log(`  message: posted`);
        if (addIdeaPayload) console.log(`  new idea: ${addIdeaPayload.id}`);
        if (Object.keys(votes).length > 0) {
          console.log(`  votes:`);
          for (const [ideaId, stance] of Object.entries(votes)) {
            console.log(`    ${ideaId} = ${stance}`);
          }
        }
        console.log(`  head:    ${result.headCid}`);
        console.log('');
      }
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    } finally {
      await stopBrainNode();
    }
  },
};

// ---------------------------------------------------------------------------
// pop brain brainstorm-promote
// ---------------------------------------------------------------------------

interface PromoteArgs {
  doc: string;
  id: string;
  ideaId: string;
  projectId: string;
  author?: string;
}

export const brainstormPromoteHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        type: 'string',
        default: 'pop.brain.brainstorms',
      })
      .option('id', {
        describe: 'Brainstorm id containing the idea to promote',
        type: 'string',
        demandOption: true,
      })
      .option('idea-id', {
        describe: 'Idea id to promote to a brain project',
        type: 'string',
        demandOption: true,
      })
      .option('project-id', {
        describe: 'Existing pop.brain.projects id to link to (create the project via `pop brain new-project` first)',
        type: 'string',
        demandOption: true,
      })
      .option('author', {
        describe: 'Override the author address',
        type: 'string',
      })
      .option('idempotency-key', { type: 'string', describe: 'Task #375 (HB#217) idempotency cache.' })
      .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache.' }),

  handler: async (argv: ArgumentsCamelCase<PromoteArgs>) => {
    try {
      const author = resolveAuthor(argv.author);
      const now = Math.floor(Date.now() / 1000);

      const idempKey = (argv as any).idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!(argv as any).noIdempotency) {
        const cached = checkIdempotencyCache(author, 'brain.brainstormPromote', idempKey);
        if (cached) {
          if (output.isJsonMode()) output.json({ status: 'ok', cached: true, ...cached });
          else console.log(`  Idea already promoted (idempotency cache hit). head: ${cached.headCid}`);
          return;
        }
      }

      const result = await routedDispatch({
        type: 'promoteIdea',
        docId: argv.doc,
        brainstormId: argv.id,
        ideaId: argv.ideaId,
        promotedProjectId: argv.projectId,
        promotedBy: author,
        promotedAt: now,
      });

      if (!(argv as any).noIdempotency) {
        recordIdempotentResult(author, 'brain.brainstormPromote', idempKey, {
          docId: argv.doc,
          brainstormId: argv.id,
          ideaId: argv.ideaId,
          headCid: result.headCid,
        });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          brainstormId: argv.id,
          ideaId: argv.ideaId,
          promotedProjectId: argv.projectId,
          headCid: result.headCid,
          author,
          routedViaDaemon: result.routedViaDaemon,
        });
      } else {
        console.log('');
        console.log(`  Idea "${argv.ideaId}" promoted from brainstorm "${argv.id}" to project "${argv.projectId}"`);
        console.log(`  promotedBy: ${author}`);
        console.log(`  head:       ${result.headCid}`);
        console.log('');
      }
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    } finally {
      await stopBrainNode();
    }
  },
};

// ---------------------------------------------------------------------------
// pop brain brainstorm-close
// ---------------------------------------------------------------------------

interface CloseArgs {
  doc: string;
  id: string;
  reason?: string;
  author?: string;
}

export const brainstormCloseHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        type: 'string',
        default: 'pop.brain.brainstorms',
      })
      .option('id', {
        describe: 'Brainstorm id to close',
        type: 'string',
        demandOption: true,
      })
      .option('reason', {
        describe: 'Reason for closing without promoting',
        type: 'string',
      })
      .option('author', {
        type: 'string',
      })
      .option('idempotency-key', { type: 'string', describe: 'Task #375 (HB#217) idempotency cache.' })
      .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache.' }),

  handler: async (argv: ArgumentsCamelCase<CloseArgs>) => {
    try {
      const author = resolveAuthor(argv.author);
      const now = Math.floor(Date.now() / 1000);

      const idempKey = (argv as any).idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!(argv as any).noIdempotency) {
        const cached = checkIdempotencyCache(author, 'brain.brainstormClose', idempKey);
        if (cached) {
          if (output.isJsonMode()) output.json({ status: 'ok', cached: true, ...cached });
          else console.log(`  Brainstorm "${argv.id}" already closed (idempotency cache hit). head: ${cached.headCid}`);
          return;
        }
      }

      const result = await routedDispatch({
        type: 'closeBrainstorm',
        docId: argv.doc,
        brainstormId: argv.id,
        closedBy: author,
        closedAt: now,
        reason: argv.reason,
      });

      if (!(argv as any).noIdempotency) {
        recordIdempotentResult(author, 'brain.brainstormClose', idempKey, {
          docId: argv.doc,
          brainstormId: argv.id,
          headCid: result.headCid,
        });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          brainstormId: argv.id,
          headCid: result.headCid,
          author,
          routedViaDaemon: result.routedViaDaemon,
        });
      } else {
        console.log('');
        console.log(`  Brainstorm "${argv.id}" closed in ${argv.doc}`);
        console.log(`  closedBy: ${author}`);
        if (argv.reason) console.log(`  reason:   ${argv.reason}`);
        console.log(`  head:     ${result.headCid}`);
        console.log('');
      }
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    } finally {
      await stopBrainNode();
    }
  },
};

// ---------------------------------------------------------------------------
// pop brain brainstorm-remove
// ---------------------------------------------------------------------------

interface RemoveArgs {
  doc: string;
  id: string;
  reason?: string;
  author?: string;
}

export const brainstormRemoveHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        type: 'string',
        default: 'pop.brain.brainstorms',
      })
      .option('id', {
        describe: 'Brainstorm id to soft-delete',
        type: 'string',
        demandOption: true,
      })
      .option('reason', {
        describe: 'Removal reason',
        type: 'string',
      })
      .option('author', {
        type: 'string',
      })
      .option('idempotency-key', { type: 'string', describe: 'Task #375 (HB#217) idempotency cache.' })
      .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache.' }),

  handler: async (argv: ArgumentsCamelCase<RemoveArgs>) => {
    try {
      const author = resolveAuthor(argv.author);
      const now = Math.floor(Date.now() / 1000);

      const idempKey = (argv as any).idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!(argv as any).noIdempotency) {
        const cached = checkIdempotencyCache(author, 'brain.brainstormRemove', idempKey);
        if (cached) {
          if (output.isJsonMode()) output.json({ status: 'ok', cached: true, ...cached });
          else console.log(`  Brainstorm "${argv.id}" already removed (idempotency cache hit). head: ${cached.headCid}`);
          return;
        }
      }

      const result = await routedDispatch({
        type: 'removeBrainstorm',
        docId: argv.doc,
        brainstormId: argv.id,
        removedBy: author,
        removedAt: now,
        removedReason: argv.reason,
      });

      if (!(argv as any).noIdempotency) {
        recordIdempotentResult(author, 'brain.brainstormRemove', idempKey, {
          docId: argv.doc,
          brainstormId: argv.id,
          headCid: result.headCid,
        });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          brainstormId: argv.id,
          headCid: result.headCid,
          author,
          routedViaDaemon: result.routedViaDaemon,
        });
      } else {
        console.log('');
        console.log(`  Brainstorm "${argv.id}" soft-deleted in ${argv.doc}`);
        console.log(`  removedBy: ${author}`);
        if (argv.reason) console.log(`  reason:    ${argv.reason}`);
        console.log(`  head:      ${result.headCid}`);
        console.log('');
      }
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    } finally {
      await stopBrainNode();
    }
  },
};
