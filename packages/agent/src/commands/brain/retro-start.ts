/**
 * pop brain retro start — create a new retrospective entry in pop.brain.retros.
 *
 * Input:
 *   --window-from <HB#>        lower bound of the HB window covered
 *   --window-to <HB#>          upper bound of the HB window covered
 *   --observations-file <path> markdown file with "## What worked" and
 *                              "## What didn't work" sections (both optional)
 *   --changes-file <path>      JSON or markdown file listing proposed
 *                              changes. JSON shape is an array of
 *                              {id, summary, details?} objects;
 *                              markdown shape is `- **change-1** — summary`
 *                              lines (details on the next indented line).
 *   --id <retro-id>            optional override (default: retro-<hb>-<unix>)
 *   --author <label>           optional override (default: signing address)
 *   --doc <doc-id>             default: pop.brain.retros
 *
 * The retro is written via routedDispatch so it lands in a running daemon
 * when present and falls back to in-process applyBrainChange otherwise.
 * Schema validation happens inside dispatchOp at write time — empty
 * changes list, bad window, duplicate change ids all fail fast with a
 * clear error.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { ethers } from 'ethers';
import { stopBrainNode } from '../../lib/brain';
import { routedDispatch } from '../../lib/brain-ops';
import type { RetroChangeInput } from '../../lib/brain-ops';
import * as output from '@poa/cli/lib/output';

interface RetroStartArgs {
  doc: string;
  windowFrom: number;
  windowTo: number;
  observationsFile?: string;
  changesFile: string;
  id?: string;
  author?: string;
  hb?: number;
}

/**
 * Parse the observations file. Expects a markdown document with
 * `## What worked` and `## What didn't work` sections. Both sections
 * are optional; sections outside those two are ignored.
 */
function parseObservationsFile(content: string): { worked?: string; didntWork?: string } {
  const result: { worked?: string; didntWork?: string } = {};
  // Split into sections on H2 headers. The regex keeps the header text
  // as a capture so we can dispatch on it.
  const sections = content.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const nl = section.indexOf('\n');
    if (nl < 0) continue;
    const header = section.slice(0, nl).trim().toLowerCase();
    const body = section.slice(nl + 1).trim();
    if (!body) continue;
    if (/worked/i.test(header) && !/didn/i.test(header)) {
      result.worked = body;
    } else if (/didn.?t\s*work|didntwork|not\s*work/i.test(header)) {
      result.didntWork = body;
    }
    // Silently drop other sections — they might be "Next actions" or
    // similar that don't belong in observations.
  }
  return result;
}

/**
 * Parse the proposed-changes file. Supports two shapes:
 *
 * 1. JSON: `[{"id": "change-1", "summary": "...", "details": "..."}, ...]`
 * 2. Markdown: `- **change-1** — summary\n  details (indented)\n- **change-2** — ...`
 *
 * JSON is tried first. If parse fails, fall back to markdown scanning.
 */
function parseChangesFile(content: string): RetroChangeInput[] {
  // Try JSON first.
  const trimmed = content.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const items = Array.isArray(parsed) ? parsed : parsed.changes ?? [];
      return items.map((item: any) => {
        if (!item.id || !item.summary) {
          throw new Error(
            `change entry missing id or summary: ${JSON.stringify(item)}`,
          );
        }
        const out: RetroChangeInput = {
          id: String(item.id),
          summary: String(item.summary),
        };
        if (item.details) out.details = String(item.details);
        return out;
      });
    } catch (err: any) {
      throw new Error(`Failed to parse changes file as JSON: ${err.message}`);
    }
  }

  // Markdown: bullet lines that start with `- **<id>**`. Anything
  // indented under a bullet belongs to that change's details.
  const changes: RetroChangeInput[] = [];
  const lines = content.split('\n');
  let current: RetroChangeInput | null = null;
  const detailLines: string[] = [];
  const commit = () => {
    if (!current) return;
    if (detailLines.length > 0) {
      current.details = detailLines.join('\n').trim();
    }
    changes.push(current);
    current = null;
    detailLines.length = 0;
  };
  const bulletRe = /^-\s+\*\*([^*]+)\*\*\s*[—–-]\s*(.+)$/;
  for (const rawLine of lines) {
    const m = rawLine.match(bulletRe);
    if (m) {
      commit();
      current = { id: m[1].trim(), summary: m[2].trim() };
      continue;
    }
    if (current && /^\s+\S/.test(rawLine)) {
      detailLines.push(rawLine.replace(/^\s+/, ''));
    }
  }
  commit();
  if (changes.length === 0) {
    throw new Error(
      'Failed to parse changes file as markdown — expected bullet lines ' +
      'like `- **change-1** — summary`. Try JSON format instead.',
    );
  }
  return changes;
}

export const retroStartHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Target brain document ID (default: pop.brain.retros)',
        type: 'string',
        default: 'pop.brain.retros',
      })
      .option('window-from', {
        describe: 'First HB number covered by this retro',
        type: 'number',
        demandOption: true,
      })
      .option('window-to', {
        describe: 'Last HB number covered by this retro',
        type: 'number',
        demandOption: true,
      })
      .option('observations-file', {
        describe:
          'Markdown file with `## What worked` and `## What didn\'t work` sections',
        type: 'string',
      })
      .option('changes-file', {
        describe:
          'JSON or markdown file listing proposed changes. JSON: array of {id, summary, details?}. Markdown: bullet list with `- **id** — summary`.',
        type: 'string',
        demandOption: true,
      })
      .option('id', {
        describe: 'Override the auto-generated retro id (default: retro-<hb>-<unix>)',
        type: 'string',
      })
      .option('author', {
        describe: 'Override the author label (default: signing wallet address)',
        type: 'string',
      })
      .option('hb', {
        describe: 'Heartbeat number at retro start (default: window-to)',
        type: 'number',
      }),

  handler: async (argv: ArgumentsCamelCase<RetroStartArgs>) => {
    try {
      if (argv.windowFrom > argv.windowTo) {
        output.error(
          `--window-from (${argv.windowFrom}) must be <= --window-to (${argv.windowTo})`,
        );
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

      // Read observations file if provided.
      let observations: { worked?: string; didntWork?: string } = {};
      if (argv.observationsFile) {
        const p = resolve(argv.observationsFile);
        if (!existsSync(p)) {
          output.error(`--observations-file not found: ${p}`);
          process.exitCode = 1;
          return;
        }
        const content = readFileSync(p, 'utf8');
        observations = parseObservationsFile(content);
      }

      // Read + parse changes file.
      const changesPath = resolve(argv.changesFile);
      if (!existsSync(changesPath)) {
        output.error(`--changes-file not found: ${changesPath}`);
        process.exitCode = 1;
        return;
      }
      const changesContent = readFileSync(changesPath, 'utf8');
      let proposedChanges: RetroChangeInput[];
      try {
        proposedChanges = parseChangesFile(changesContent);
      } catch (err: any) {
        output.error(err.message);
        process.exitCode = 1;
        return;
      }
      if (proposedChanges.length === 0) {
        output.error('Changes file produced zero entries — retros must have at least one proposed change');
        process.exitCode = 1;
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const hb = argv.hb ?? argv.windowTo;
      const retroId = argv.id ?? `retro-${hb}-${now}`;

      const result = await routedDispatch({
        type: 'startRetro',
        docId: argv.doc,
        retroId,
        author: authorLabel,
        hb,
        window: { from: argv.windowFrom, to: argv.windowTo },
        observations,
        proposedChanges,
        createdAt: now,
      });

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          docId: argv.doc,
          retroId,
          hb,
          window: { from: argv.windowFrom, to: argv.windowTo },
          author: authorLabel,
          changeCount: proposedChanges.length,
          changeIds: proposedChanges.map(c => c.id),
          headCid: result.headCid,
          envelopeAuthor: result.envelopeAuthor,
          routedViaDaemon: result.routedViaDaemon,
        });
      } else {
        console.log('');
        console.log(`  Retro started in ${argv.doc}`);
        console.log(`  id:        ${retroId}`);
        console.log(`  window:    HB#${argv.windowFrom}..HB#${argv.windowTo}`);
        console.log(`  author:    ${authorLabel}`);
        console.log(`  changes:   ${proposedChanges.length} proposed`);
        for (const c of proposedChanges) {
          console.log(`    - ${c.id}: ${c.summary}`);
        }
        console.log(`  head:      ${result.headCid}`);
        console.log(`  routed:    ${result.routedViaDaemon ? 'via brain daemon' : 'in-process (no daemon)'}`);
        console.log('');
        console.log(
          `  Next steps: other agents run "pop brain retro respond --to ${retroId}" ` +
          `to discuss proposed changes. When changes are agreed, run ` +
          `"pop brain retro file-tasks --retro ${retroId}" to convert them to on-chain tasks.`,
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
