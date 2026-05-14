import type { Argv, ArgumentsCamelCase } from 'yargs';
import fs from 'fs';
import { pinFile, pinJson } from '../../lib/ipfs';
import * as output from '../../lib/output';

interface PinArgs {
  file?: string;
  content?: string;
  json?: boolean;
}

/**
 * HB#754 (retro-1098 ipfs-pin-cli-or-pop-org-pin): standalone IPFS-pin
 * wrapper around the existing pinFile / pinJson helpers in src/lib/ipfs.ts.
 *
 * Prior workflow gap (HB#1085 + HB#742): `pop org publish` requires a
 * PRE-EXISTING CID — it converts already-pinned IPFS content to HTML. The
 * fleet had to fall back to:
 *   - `task submit` (which auto-pins the submission text), OR
 *   - ad-hoc node scripts that imported `pinFile` directly (vigil HB#742
 *     used this path for Portfolio v5 markdown pin)
 *
 * This subcommand makes file-pinning a first-class CLI op.
 *
 * Usage:
 *   pop org pin --file path/to/content.md
 *   pop org pin --content "inline string content"
 *   pop org pin --file portfolio-v5.md --json  # for scripting
 */
export const pinHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('file', {
        type: 'string',
        describe: 'Path to local file to pin (read as binary; markdown/JSON/HTML all work)',
      })
      .option('content', {
        type: 'string',
        describe: 'Inline string content to pin (alternative to --file)',
      }),

  handler: async (argv: ArgumentsCamelCase<PinArgs>) => {
    const spin = output.spinner('Pinning to IPFS...');
    spin.start();
    try {
      if (!argv.file && !argv.content) {
        throw new Error('Either --file or --content is required.');
      }
      if (argv.file && argv.content) {
        throw new Error('--file and --content are mutually exclusive.');
      }

      let cid: string;
      let sizeBytes: number;
      let source: string;

      if (argv.file) {
        const buf = fs.readFileSync(argv.file);
        sizeBytes = buf.length;
        cid = await pinFile(buf);
        source = argv.file;
      } else {
        const content = argv.content as string;
        sizeBytes = Buffer.byteLength(content, 'utf8');
        cid = await pinJson(content);
        source = `(inline ${sizeBytes} bytes)`;
      }

      spin.stop();
      output.success('Pinned to IPFS', {
        cid,
        gatewayUrl: `https://ipfs.io/ipfs/${cid}`,
        source,
        sizeBytes,
      });
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
