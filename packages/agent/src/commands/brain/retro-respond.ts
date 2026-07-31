/**
 * pop brain retro respond — append a discussion entry to an existing retro.
 *
 * Usage:
 *
 *   pop brain retro respond --to retro-327-1776... \
 *     --message "Change 1 makes sense. Change 2 needs more research on Diamond ABI extraction."
 *
 *   # With per-change votes:
 *   pop brain retro respond --to retro-327-1776... \
 *     --message "..." \
 *     --vote change-1=agree,change-2=modify
 *
 * The response lands in the retro's `discussion` array. The first
 * response on an open retro auto-advances status from 'open' to
 * 'discussed' (enforced by the respondToRetro op inside dispatchOp).
 *
 * Vote validation: vote change-ids must refer to real proposedChanges
 * on the retro. Typos / unknown change-ids fail fast with a list of
 * available change-ids in the error message.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { ethers } from 'ethers';
import { stopBrainNode } from '../../lib/brain';
import { routedDispatch } from '../../lib/brain-ops';
import type { RetroVote } from '../../lib/brain-projections';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
} from '@poa/cli/lib/idempotency';
import * as output from '@poa/cli/lib/output';

interface RetroRespondArgs {
  doc: string;
  to: string;
  message?: string;
  messageFile?: string;
  vote?: string;
  author?: string;
  hb?: number;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

const VALID_VOTES: RetroVote[] = ['agree', 'modify', 'reject'];

/**
 * Parse the --vote flag value. Expected shape is a comma-separated
 * list of `change-id=vote` pairs, e.g. `change-1=agree,change-2=modify`.
 * Returns a map of {changeId: vote}, or throws on a bad value.
 */
function parseVoteFlag(raw: string): Record<string, RetroVote> {
  const result: Record<string, RetroVote> = {};
  const pairs = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) {
      throw new Error(`--vote pair "${pair}" must be in "change-id=vote" format`);
    }
    const changeId = pair.slice(0, eq).trim();
    const voteRaw = pair.slice(eq + 1).trim().toLowerCase();
    if (!changeId) {
      throw new Error(`--vote pair "${pair}" has empty change-id`);
    }
    if (!VALID_VOTES.includes(voteRaw as RetroVote)) {
      throw new Error(
        `--vote pair "${pair}" has invalid vote "${voteRaw}" — must be one of: ${VALID_VOTES.join(', ')}`,
      );
    }
    result[changeId] = voteRaw as RetroVote;
  }
  return result;
}

export const retroRespondHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (default: pop.brain.retros)',
        type: 'string',
        default: 'pop.brain.retros',
      })
      .option('to', {
        describe: 'The retro.id to respond to',
        type: 'string',
        demandOption: true,
      })
      .option('message', {
        describe: 'The response message (inline). Use --message-file for long content.',
        type: 'string',
      })
      .option('message-file', {
        describe: 'Path to a file whose contents are the response message',
        type: 'string',
      })
      .option('vote', {
        describe:
          'Per-change votes as "change-id=vote,change-id=vote" (votes: agree, modify, reject). Example: change-1=agree,change-2=modify',
        type: 'string',
      })
      .option('author', {
        describe: 'Override the author label (default: signing wallet address)',
        type: 'string',
      })
      .option('hb', {
        describe: 'Heartbeat number at response time (optional metadata)',
        type: 'number',
      })
      .option('idempotency-key', { type: 'string', describe: 'Task #375 (HB#217) idempotency cache.' })
      .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache.' })
      .check((argv) => {
        if (!argv.message && !argv['message-file']) {
          throw new Error('Must supply --message or --message-file');
        }
        return true;
      }),

  handler: async (argv: ArgumentsCamelCase<RetroRespondArgs>) => {
    try {
      // Resolve message content.
      let message: string;
      if (argv.messageFile) {
        const p = resolve(argv.messageFile);
        if (!existsSync(p)) {
          output.error(`--message-file not found: ${p}`);
          process.exitCode = 1;
          return;
        }
        message = readFileSync(p, 'utf8').trim();
      } else {
        message = (argv.message ?? '').trim();
      }
      if (!message) {
        output.error('Response message is empty.');
        process.exitCode = 1;
        return;
      }

      // Resolve author.
      let authorLabel: string;
      if (argv.author) {
        authorLabel = argv.author;
      } else {
        const key = process.env.POP_PRIVATE_KEY;
        if (!key) {
          output.error(
            'POP_PRIVATE_KEY not set — cannot derive default author. Pass --author explicitly.',
          );
          process.exitCode = 1;
          return;
        }
        authorLabel = new ethers.Wallet(key).address.toLowerCase();
      }

      // Parse votes if provided.
      let votePerChange: Record<string, RetroVote> | undefined;
      if (argv.vote) {
        try {
          votePerChange = parseVoteFlag(argv.vote);
        } catch (err: any) {
          output.error(err.message);
          process.exitCode = 1;
          return;
        }
      }

      const now = Math.floor(Date.now() / 1000);

      // Task #375 idempotency check, agent-scoped
      const idempKey = (argv as any).idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
      if (!(argv as any).noIdempotency) {
        const cached = checkIdempotencyCache(authorLabel, 'brain.retroRespond', idempKey);
        if (cached) {
          if (output.isJsonMode()) output.json({ status: 'ok', cached: true, ...cached });
          else console.log(`  Retro response already recorded (idempotency cache hit). head: ${cached.headCid}`);
          return;
        }
      }

      const result = await routedDispatch({
        type: 'respondToRetro',
        docId: argv.doc,
        retroId: argv.to,
        author: authorLabel,
        hb: argv.hb,
        message,
        votePerChange,
        timestamp: now,
      });

      if (!(argv as any).noIdempotency) {
        recordIdempotentResult(authorLabel, 'brain.retroRespond', idempKey, {
          docId: argv.doc,
          retroId: argv.to,
          headCid: result.headCid,
        });
      }

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          retroId: argv.to,
          author: authorLabel,
          hb: argv.hb ?? null,
          votes: votePerChange ?? null,
          headCid: result.headCid,
          envelopeAuthor: result.envelopeAuthor,
          routedViaDaemon: result.routedViaDaemon,
        });
      } else {
        console.log('');
        console.log(`  Response appended to retro "${argv.to}"`);
        console.log(`  author:    ${authorLabel}`);
        if (argv.hb !== undefined) console.log(`  hb:        #${argv.hb}`);
        if (votePerChange) {
          console.log(`  votes:`);
          for (const [changeId, vote] of Object.entries(votePerChange)) {
            console.log(`    - ${changeId}: ${vote}`);
          }
        }
        console.log(`  new head:  ${result.headCid}`);
        console.log(`  routed:    ${result.routedViaDaemon ? 'via brain daemon' : 'in-process (no daemon)'}`);
        console.log('');
        console.log(
          `  The retro's status advances from 'open' to 'discussed' on the first ` +
          `response. When proposed changes are agreed, run "pop brain retro file-tasks ` +
          `--retro ${argv.to}" to convert them to on-chain tasks.`,
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
