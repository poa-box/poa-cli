/**
 * pop brain retro list — list retros in pop.brain.retros.
 *
 * Filters:
 *   --status open|discussed|shipped    only show retros at this status
 *   --doc <doc-id>                     default: pop.brain.retros
 *
 * JSON mode emits a machine-readable array; human mode prints a table.
 *
 * Always reads in-process (no daemon routing) because this is a
 * pure-read path and concurrent reads against the helia blockstore
 * work fine alongside a running daemon (HB#323 verification).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { openBrainDoc, stopBrainNode } from '../../lib/brain';
import type { BrainRetro, RetroStatus } from '../../lib/brain-projections';
import * as output from '@poa-box/cli/lib/output';

interface RetroListArgs {
  doc: string;
  status?: RetroStatus;
}

const VALID_STATUSES: RetroStatus[] = ['open', 'discussed', 'shipped'];

export const retroListHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (default: pop.brain.retros)',
        type: 'string',
        default: 'pop.brain.retros',
      })
      .option('status', {
        describe: 'Filter by retro status',
        type: 'string',
        choices: VALID_STATUSES,
      }),

  handler: async (argv: ArgumentsCamelCase<RetroListArgs>) => {
    try {
      const { doc } = await openBrainDoc(argv.doc);
      const retros: BrainRetro[] = Array.isArray(doc?.retros) ? doc.retros : [];
      const live = retros.filter(r => r?.removed !== true);
      const filtered = argv.status
        ? live.filter(r => r?.status === argv.status)
        : live;

      if (output.isJsonMode()) {
        output.json({
          docId: argv.doc,
          statusFilter: argv.status ?? null,
          count: filtered.length,
          retros: filtered.map(r => ({
            id: r.id,
            author: r.author,
            hb: r.hb,
            window: r.window,
            status: r.status ?? 'open',
            changeCount: Array.isArray(r.proposedChanges) ? r.proposedChanges.length : 0,
            discussionCount: Array.isArray(r.discussion) ? r.discussion.length : 0,
            createdAt: r.createdAt,
            closedAt: r.closedAt,
          })),
        });
        return;
      }

      if (filtered.length === 0) {
        console.log(
          argv.status
            ? `No retros in ${argv.doc} with status='${argv.status}'.`
            : `No retros in ${argv.doc} yet. Start one with: pop brain retro start --window-from N --window-to M --changes-file <path>`,
        );
        return;
      }

      console.log('');
      console.log(`  Retros in ${argv.doc}${argv.status ? ` (status=${argv.status})` : ''}`);
      console.log('');
      console.log('  ID                              Author         Window       Status     Changes');
      console.log('  ' + '─'.repeat(80));
      for (const r of filtered) {
        const id = (r.id ?? '(no id)').padEnd(32).slice(0, 32);
        const author = (r.author ?? '(unknown)').slice(0, 12).padEnd(14);
        const windowLabel = r.window
          ? `#${r.window.from ?? '?'}..#${r.window.to ?? '?'}`.padEnd(12)
          : '(no window)'.padEnd(12);
        const status = (r.status ?? 'open').padEnd(10);
        const changeCount = Array.isArray(r.proposedChanges) ? r.proposedChanges.length : 0;
        console.log(`  ${id}${author}${windowLabel}${status} ${changeCount}`);
      }
      console.log('');
      console.log(`  ${filtered.length} retro${filtered.length === 1 ? '' : 's'}. Run "pop brain retro show <id>" for full detail.`);
      console.log('');
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    } finally {
      await stopBrainNode();
    }
  },
};
