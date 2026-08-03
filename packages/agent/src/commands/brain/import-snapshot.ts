/**
 * pop brain import-snapshot — load a raw Automerge snapshot as the new local
 * head for a brain doc. Task #353 (HB#348) migration tool for converging
 * disjoint brain state across existing agents.
 *
 * Typical use:
 *
 *   # Operator on vigil_01's machine, after fetching argus's baseline from
 *   # IPFS (see HB#341 brain lesson `argus-baseline-exported-for-353-migration`
 *   # for the pinned CIDs):
 *
 *   curl https://ipfs.io/ipfs/QmPk6tiY2AHZyXVCFpPeRyAUY2WviCkDq6iAheokEzRbd7 > /tmp/shared.json
 *   node -e "
 *     const j = require('/tmp/shared.json');
 *     require('fs').writeFileSync('/tmp/shared.bin', Buffer.from(j.base64, 'base64'));
 *   "
 *
 *   pop brain daemon stop                                # safety — no writes during migration
 *   pop brain read --doc pop.brain.shared --json > /tmp/local-backup.json  # backup current state
 *   pop brain import-snapshot --doc pop.brain.shared \
 *     --file /tmp/shared.bin \
 *     --force                                            # required if local head exists
 *   pop brain daemon start                               # restart daemon with new head
 *
 * ## Safety
 *
 * - `--force` is REQUIRED when the local brain home already has a manifest
 *   entry for the target doc. Without `--force`, the command refuses and
 *   tells the operator to back up first.
 * - Operators are responsible for preserving local-only content BEFORE
 *   running this command. Use `pop brain read --doc <id> --json` to snapshot
 *   current state, replay any local-only lessons via `pop brain append-lesson`
 *   AFTER the import lands.
 * - The import runs write-time schema validation (#346) by default. Pass
 *   `--allow-invalid-shape` only when you know the source bytes deliberately
 *   contain a non-canonical shape.
 *
 * ## Why this command exists
 *
 * HB#333-335 discovered that Automerge.merge silently drops content across
 * disjoint histories. HB#337 task #352 shipped shared-genesis bootstrap so
 * NEW agents joining post-PR-#10 share a common root. But the 3 existing
 * Argus agents (argus_prime / vigil_01 / sentinel_01) each independently
 * initialized their pop.brain.shared BEFORE #352 landed, so they remain
 * mutually disjoint. Task #353 handles the one-time migration from disjoint
 * back to shared-root, using one agent's current state as the canonical
 * baseline that the other two import.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { importBrainDoc, listBrainDocs, stopBrainNode } from '../../lib/brain';
import * as output from '@poa-box/cli/lib/output';

interface ImportSnapshotArgs {
  doc: string;
  file: string;
  force?: boolean;
  allowInvalidShape?: boolean;
}

export const importSnapshotHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Target brain document ID (e.g. pop.brain.shared)',
        type: 'string',
        demandOption: true,
      })
      .option('file', {
        describe: 'Path to the raw Automerge snapshot bytes to import (.bin file produced by Automerge.save())',
        type: 'string',
        demandOption: true,
      })
      .option('force', {
        describe:
          'Required when a local head already exists for this doc. The existing head becomes orphaned (old envelope stays in blockstore but manifest no longer points at it). Back up local-only content via `pop brain read --doc <id> --json` BEFORE using this flag.',
        type: 'boolean',
        default: false,
      })
      .option('allow-invalid-shape', {
        describe:
          'Bypass write-time schema validation (#346). Use only when the source bytes deliberately contain a non-canonical shape.',
        type: 'boolean',
        default: false,
      }),

  handler: async (argv: ArgumentsCamelCase<ImportSnapshotArgs>) => {
    try {
      // Resolve + validate input file.
      const filePath = resolve(argv.file);
      if (!existsSync(filePath)) {
        output.error(`--file not found: ${filePath}`);
        process.exitCode = 1;
        return;
      }
      const bytes = readFileSync(filePath);
      if (bytes.length === 0) {
        output.error(`--file is empty: ${filePath}`);
        process.exitCode = 1;
        return;
      }

      // Safety gate: refuse to clobber an existing head unless --force.
      const existing = listBrainDocs().find(d => d.docId === argv.doc);
      if (existing && !argv.force) {
        output.error(
          `Local brain home already has a head for "${argv.doc}" ` +
          `(${existing.headCid}). Importing would orphan the existing state. ` +
          `Back up local-only content first via \`pop brain read --doc ${argv.doc} --json\`, ` +
          `then re-run this command with --force to confirm.`,
        );
        process.exitCode = 1;
        return;
      }

      // Import. importBrainDoc validates via Automerge.load() + schema check,
      // signs new envelope, writes block, updates manifest, publishes head.
      const result = await importBrainDoc(
        argv.doc,
        new Uint8Array(bytes),
        { allowInvalidShape: argv.allowInvalidShape === true },
      );

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          sourceFile: filePath,
          sourceBytes: bytes.length,
          newHeadCid: result.headCid,
          envelopeAuthor: result.author,
          replacedExistingHead: existing?.headCid ?? null,
        });
      } else {
        console.log('');
        console.log(`  Snapshot imported as new head for ${argv.doc}`);
        console.log(`  source file:    ${filePath} (${bytes.length} bytes)`);
        console.log(`  new head:       ${result.headCid}`);
        console.log(`  envelope author: ${result.author}`);
        if (existing) {
          console.log(`  replaced head:  ${existing.headCid} (orphaned in blockstore)`);
        } else {
          console.log(`  previous head:  (none — this is a fresh import)`);
        }
        console.log('');
        console.log(
          `  Next steps: replay any local-only content (e.g. lessons this agent wrote ` +
          `but that weren't in the source snapshot) via pop brain append-lesson. ` +
          `Then restart the brain daemon if it was stopped for the migration.`,
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
