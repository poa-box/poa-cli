/**
 * pop brain allowlist — list/add/remove operator commands for the
 * agent/brain/Config/brain-allowlist.json file.
 *
 * These are thin CLI wrappers over direct JSON writes. The security
 * boundary stays at git: the file is git-tracked, changes land via
 * PR + review, and the current 3-agent Argus setup treats any write
 * as needing peer approval. The commands just reduce friction vs
 * hand-editing JSON.
 *
 * Runtime vs build-time: the allowlist is read via `readFileSync`
 * on every `isAllowedAuthor` call (see `brain-signing.ts loadAllowlist`).
 * A git pull is enough to pick up new entries — agents do NOT need
 * to rebuild dist/ just because an address was added. Rebuild only
 * matters when `brain-signing.ts` itself changes.
 *
 * Not in scope for this command:
 * - `pop brain allowlist sync` — propagating changes via the brain
 *   layer itself (chicken-and-egg: the allowlist change would need
 *   to come from an allowlisted author, which gives you zero benefit
 *   over the current git flow for a new-agent onboarding).
 * - Governance-backed allowlist changes — each edit going through a
 *   formal `pop vote` would be a clean pattern but is heavy for MVP.
 *   Current review-via-git approximates it.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { ethers } from 'ethers';
import {
  loadAllowlist,
  getAllowlistPath,
  type AllowlistEntry,
} from '../../lib/brain-signing';
import * as output from '@poa-box/cli/lib/output';

interface AllowlistListArgs {}
interface AllowlistAddArgs {
  address: string;
  name?: string;
  note?: string;
}
interface AllowlistRemoveArgs {
  address: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Normalize an address input: must match the standard hex format, and
 * gets lowercased before storage/comparison. Throws with a clean error
 * message on malformed input (yargs catches and reports).
 */
function normalizeAddress(raw: string): string {
  if (!ADDRESS_RE.test(raw)) {
    throw new Error(
      `Invalid address "${raw}" — must be a 0x-prefixed 40-character hex string.`,
    );
  }
  return raw.toLowerCase();
}

/**
 * Read the full allowlist file (not just via loadAllowlist which
 * normalizes the shape). Preserves every field that's on disk,
 * including any addedNote / future extensions. Returns an empty
 * array if the file doesn't exist yet.
 */
function readRawAllowlist(): AllowlistEntry[] {
  const p = getAllowlistPath();
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.entries)) return raw.entries;
    return [];
  } catch (err: any) {
    throw new Error(`Failed to read allowlist at ${p}: ${err.message}`);
  }
}

function writeAllowlist(entries: AllowlistEntry[]): void {
  writeFileSync(getAllowlistPath(), JSON.stringify(entries, null, 2) + '\n');
}

const listHandler = {
  builder: (yargs: Argv) => yargs,
  handler: async (_argv: ArgumentsCamelCase<AllowlistListArgs>) => {
    const entries = loadAllowlist();
    if (output.isJsonMode()) {
      output.json({ status: 'ok', count: entries.length, entries });
      return;
    }
    console.log('');
    console.log(`  Brain allowlist (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`);
    console.log('  ' + '─'.repeat(70));
    if (entries.length === 0) {
      console.log('  (empty)');
      console.log('');
      return;
    }
    for (const e of entries) {
      const name = e.name ?? '(no name)';
      console.log(`  ${e.address}  ${name}`);
      if (e.addedAt) console.log(`    addedAt: ${e.addedAt}`);
      if (e.addedBy) console.log(`    addedBy: ${e.addedBy}`);
    }
    console.log('');
    console.log(`  File: ${getAllowlistPath()}`);
    console.log('');
  },
};

const addHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('address', {
        describe: '0x-prefixed 40-char hex address to allowlist',
        type: 'string',
        demandOption: true,
      })
      .option('name', {
        describe: 'Human label (e.g. agent username)',
        type: 'string',
      })
      .option('note', {
        describe: 'Optional addedNote field recorded on the entry',
        type: 'string',
      }),
  handler: async (argv: ArgumentsCamelCase<AllowlistAddArgs>) => {
    try {
      const address = normalizeAddress(argv.address);
      const entries = readRawAllowlist();

      if (entries.some(e => String(e.address).toLowerCase() === address)) {
        output.error(`Address ${address} is already in the allowlist.`);
        process.exitCode = 1;
        return;
      }

      // Derive addedBy from POP_PRIVATE_KEY if available so the entry
      // records WHICH existing allowlisted agent is performing the
      // add. Falls back to 'unknown' if no key is set (e.g. running
      // the command on a fresh machine that hasn't configured a key
      // yet — legitimate during bootstrap).
      let addedBy: string;
      const key = process.env.POP_PRIVATE_KEY;
      if (key) {
        try {
          addedBy = new ethers.Wallet(key).address.toLowerCase();
        } catch {
          addedBy = 'unknown';
        }
      } else {
        addedBy = 'unknown';
      }

      const entry: AllowlistEntry & { addedNote?: string } = {
        address,
        name: argv.name,
        addedAt: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
        addedBy,
      };
      if (argv.note) entry.addedNote = argv.note;

      entries.push(entry);
      writeAllowlist(entries);

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          added: entry,
          count: entries.length,
          path: getAllowlistPath(),
        });
      } else {
        console.log('');
        console.log(`  Added ${address} to the allowlist.`);
        if (entry.name) console.log(`  name:    ${entry.name}`);
        console.log(`  addedAt: ${entry.addedAt}`);
        console.log(`  addedBy: ${entry.addedBy}`);
        if (entry.addedNote) console.log(`  note:    ${entry.addedNote}`);
        console.log('');
        console.log('  The change is local until committed. Next:');
        console.log('    git add agent/brain/Config/brain-allowlist.json');
        console.log(`    git commit -m "Allowlist ${entry.name ?? address}"`);
        console.log('    git push  # PR for review');
        console.log('');
        console.log('  Once other agents git pull, the new address is live —');
        console.log('  no rebuild required (loadAllowlist reads the file at runtime).');
        console.log('');
      }
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    }
  },
};

const removeHandler = {
  builder: (yargs: Argv) =>
    yargs.option('address', {
      describe: '0x-prefixed 40-char hex address to remove',
      type: 'string',
      demandOption: true,
    }),
  handler: async (argv: ArgumentsCamelCase<AllowlistRemoveArgs>) => {
    try {
      const address = normalizeAddress(argv.address);
      const entries = readRawAllowlist();
      const idx = entries.findIndex(e => String(e.address).toLowerCase() === address);
      if (idx === -1) {
        const existing = entries.map(e => String(e.address).toLowerCase()).slice(0, 8);
        output.error(
          `Address ${address} not in allowlist. Existing (first 8): ${existing.join(', ') || '(empty)'}`,
        );
        process.exitCode = 1;
        return;
      }
      const removed = entries.splice(idx, 1)[0];
      writeAllowlist(entries);

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          removed,
          count: entries.length,
          path: getAllowlistPath(),
        });
      } else {
        console.log('');
        console.log(`  Removed ${address} from the allowlist.`);
        if (removed.name) console.log(`  was: ${removed.name}`);
        console.log(`  ${entries.length} entries remain.`);
        console.log('');
        console.log('  The change is local until committed. Next:');
        console.log('    git add agent/brain/Config/brain-allowlist.json');
        console.log(`    git commit -m "Remove ${removed.name ?? address} from allowlist"`);
        console.log('    git push  # PR for review');
        console.log('');
      }
    } catch (err: any) {
      output.error(err.message);
      process.exitCode = 1;
    }
  },
};

export const allowlistHandler = {
  builder: (yargs: Argv) =>
    yargs
      .command('list', 'Show current brain allowlist entries', listHandler.builder, listHandler.handler)
      .command('add', 'Add an address to the brain allowlist', addHandler.builder, addHandler.handler)
      .command('remove', 'Remove an address from the brain allowlist', removeHandler.builder, removeHandler.handler)
      .demandCommand(1, 'Please specify a brain allowlist action (list/add/remove)'),
  handler: () => {
    // Top-level dispatch — the subcommand handlers do the actual work.
  },
};
