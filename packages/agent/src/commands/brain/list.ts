/**
 * pop brain list — enumerate all known brain docs with their current head CIDs.
 *
 * Thin wrapper over listBrainDocs() which reads the manifest file directly
 * (no Helia process required). Useful for:
 *
 *   - Discovering what docs an agent has locally without knowing the ID
 *   - Sanity-checking that a subscribe session actually merged a remote head
 *   - Feeding `pop brain read --doc <id>` for any doc returned here
 *
 * Implementation intentionally avoids spinning up a Helia node — listing
 * is a pure manifest read.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { listBrainDocs } from '../../lib/brain';
import * as output from '@poa-box/cli/lib/output';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ListArgs {}

export const listHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (_argv: ArgumentsCamelCase<ListArgs>) => {
    try {
      const docs = listBrainDocs();
      if (output.isJsonMode()) {
        output.json({ count: docs.length, docs });
        return;
      }
      console.log('');
      if (docs.length === 0) {
        console.log('  No brain docs found in local manifest.');
        console.log('  (Write one via applyBrainChange or sync via `pop brain subscribe`.)');
        console.log('');
        return;
      }
      console.log(`  Brain docs (${docs.length}):`);
      console.log('  ' + '─'.repeat(60));
      for (const { docId, headCid } of docs) {
        console.log(`  ${docId}`);
        console.log(`    head: ${headCid}`);
      }
      console.log('');
      console.log('  Inspect any doc: pop brain read --doc <docId>');
      console.log('');
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    }
  },
};
