/**
 * pop brain retro show — render a single retro as markdown.
 *
 * Loads the retro doc, extracts the requested retro, and runs it
 * through the projection layer. Same shape + schema as projectRetros
 * produces for the full doc snapshot, but scoped to one entry.
 *
 * Pure read path — no daemon routing required.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { openBrainDoc, stopBrainNode } from '../../lib/brain';
import { projectRetros } from '../../lib/brain-projections';
import type { BrainRetro } from '../../lib/brain-projections';
import * as output from '@poa/cli/lib/output';

interface RetroShowArgs {
  retroId: string;
  doc: string;
}

export const retroShowHandler = {
  builder: (yargs: Argv) =>
    yargs
      .positional('retro-id', {
        describe: 'The retro.id to show',
        type: 'string',
      })
      .option('doc', {
        describe: 'Brain document ID (default: pop.brain.retros)',
        type: 'string',
        default: 'pop.brain.retros',
      })
      .demandOption('retro-id'),

  handler: async (argv: ArgumentsCamelCase<RetroShowArgs>) => {
    try {
      const { doc, headCid } = await openBrainDoc(argv.doc);
      const retros: BrainRetro[] = Array.isArray(doc?.retros) ? doc.retros : [];
      const target = retros.find(r => r?.id === argv.retroId);

      if (!target) {
        const candidates = retros
          .map(r => r?.id)
          .filter((id): id is string => typeof id === 'string')
          .slice(0, 8);
        output.error(
          `Retro "${argv.retroId}" not found in ${argv.doc}. ` +
          `Available ids (first 8): ${candidates.join(', ') || '(none)'}`,
        );
        process.exitCode = 1;
        return;
      }

      if (output.isJsonMode()) {
        output.json({
          docId: argv.doc,
          headCid,
          retro: target,
        });
        return;
      }

      // Render the ONE retro through the projection layer by wrapping
      // it in a synthetic single-retro doc. This keeps the output
      // format identical to what `pop brain snapshot` would produce,
      // so reviewers see the same rendered structure whether they're
      // looking at a live retro or a committed snapshot.
      const markdown = projectRetros({ retros: [target] }, headCid);
      console.log(markdown);
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    } finally {
      await stopBrainNode();
    }
  },
};
