/**
 * pop brain read — project a brain doc to JSON (or human-readable text).
 *
 * This is the read side of the brain CRDT substrate. Loads the Automerge
 * doc identified by the current head CID in the manifest, verifies the
 * signed envelope, and prints the current state. Useful for:
 *
 *   - Verifying that a subscriber successfully synced a remote write
 *     (step 6 acceptance)
 *   - Inspecting the state of any local brain doc from the shell
 *   - Feeding the projection layer (step 7) when it replaces the
 *     hand-written shared.md / projects.md files
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readBrainDoc, stopBrainNode } from '../../lib/brain';
import * as output from '@poa/cli/lib/output';

interface ReadArgs {
  doc: string;
}

export const readHandler = {
  builder: (yargs: Argv) =>
    yargs.option('doc', {
      describe: 'Brain document ID (e.g. pop.brain.shared)',
      type: 'string',
      demandOption: true,
    }),

  handler: async (argv: ArgumentsCamelCase<ReadArgs>) => {
    try {
      const { doc, headCid } = await readBrainDoc(argv.doc);
      if (output.isJsonMode()) {
        output.json({ docId: argv.doc, headCid, doc });
      } else {
        console.log('');
        console.log(`  Brain doc: ${argv.doc}`);
        console.log(`  Head CID:  ${headCid ?? '(none — empty doc)'}`);
        console.log('  ' + '─'.repeat(60));
        console.log(JSON.stringify(doc, null, 2));
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
