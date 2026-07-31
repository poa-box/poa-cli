/**
 * pop zkemail build-allowlist — compute an allowlist doc + merkle root, optionally pin it.
 *
 * This is the local half of publishing an invite list. It is deliberately separate from the
 * governance write: the root/CID must exist before a proposal can commit them, and an operator
 * should be able to inspect the computed root before anything is broadcast.
 *
 * The doc format, Poseidon identifier hashes, and merkle leaf encoding all come from
 * src/lib/zkemail.ts, whose conformance is pinned against the live on-chain ceremony root.
 * Getting any of them wrong yields an allowlist that pins fine and then silently rejects
 * every claim, so this command never invents its own encoding.
 *
 * Input file — a JSON array (or an existing allowlist doc, to re-publish it):
 *   [
 *     { "type": "domain", "identifier": "anthropic.com", "hatIds": ["0x1f..."], "roleIndexes": [0] },
 *     { "type": "email",  "identifier": "alice@org.com", "hatIds": ["0x1f..."] }
 *   ]
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import * as fs from 'fs';
import { resolveOrgId } from '../../lib/resolve';
import { buildAllowlist, parseEntriesFile, type AllowlistInputEntry } from '../../lib/zkemail';
import { fetchRoleNames, labelHat } from './helpers';
import { pinJson } from '../../lib/ipfs';
import { ipfsCidToBytes32 } from '../../lib/encoding';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface BuildArgs {
  org?: string;
  chain?: number;
  file?: string;
  domain?: string[];
  email?: string[];
  hat?: string[];
  pin?: boolean;
  out?: string;
}

export const buildAllowlistHandler = {
  builder: (yargs: Argv) => yargs
    .option('file', { type: 'string', describe: 'JSON file of allowlist entries (or an existing allowlist doc to re-publish)' })
    .option('domain', { type: 'string', array: true, describe: 'Invite a whole domain, e.g. --domain anthropic.com (repeatable)' })
    .option('email', { type: 'string', array: true, describe: 'Invite a specific address, e.g. --email alice@org.com (repeatable)' })
    .option('hat', { type: 'string', array: true, describe: 'Hat ID(s) granted to every --domain/--email entry (repeatable)' })
    .option('pin', { type: 'boolean', default: false, describe: 'Pin the allowlist to IPFS (otherwise compute locally only)' })
    .option('out', { type: 'string', describe: 'Write the allowlist JSON to this path' })
    .example('pop zkemail build-allowlist --domain anthropic.com --hat 0x1f… --pin', 'Invite a whole domain and pin the file')
    .example('pop zkemail build-allowlist --file entries.json --out allowlist.json', 'Compute locally from a file, no network writes')
    .epilogue('Publish the result with: pop zkemail propose-allowlist --root <root> --cid <cid>'),

  handler: async (argv: ArgumentsCamelCase<BuildArgs>) => {
    const spin = output.spinner('Building allowlist...');
    spin.start();

    try {
      const orgId = await resolveOrgId(argv.org, argv.chain);

      let entries: AllowlistInputEntry[];
      if (argv.file) {
        entries = parseEntriesFile(fs.readFileSync(argv.file, 'utf8'), argv.file);
      } else {
        const domains = argv.domain ?? [];
        const emails = argv.email ?? [];
        const hats = argv.hat ?? [];
        if (domains.length === 0 && emails.length === 0) {
          throw new CliError(
            'Nothing to build — pass --file, or at least one --domain/--email.',
            EXIT.USAGE
          );
        }
        if (hats.length === 0) {
          throw new CliError(
            'Each allowlist entry must grant at least one role hat — pass --hat <hatId>.',
            EXIT.USAGE,
            'List the org\'s role hat IDs with: pop org roles --json'
          );
        }
        entries = [
          ...domains.map((d): AllowlistInputEntry => ({ type: 'domain', identifier: d, hatIds: hats })),
          ...emails.map((e): AllowlistInputEntry => ({ type: 'email', identifier: e, hatIds: hats })),
        ];
      }

      const { doc, json, root } = await buildAllowlist({ orgId, entries });

      let cid: string | null = null;
      let cidDigest: string | null = null;
      if (argv.pin) {
        spin.text = 'Pinning allowlist to IPFS...';
        cid = await pinJson(json);
        cidDigest = ipfsCidToBytes32(cid);
      }

      if (argv.out) {
        fs.writeFileSync(argv.out, JSON.stringify(doc, null, 2));
      }

      spin.stop();

      if (output.isJsonMode()) {
        output.json({
          orgId,
          merkleRoot: root,
          cid,
          cidDigest,
          pinned: Boolean(argv.pin),
          outFile: argv.out ?? null,
          entryCount: doc.entries.length,
          entries: doc.entries,
          nextStep: cid
            ? `pop zkemail propose-allowlist --root ${root} --cid ${cid}`
            : 'Re-run with --pin to publish the file, then propose-allowlist',
        });
        return;
      }

      // Only the human table needs role names, so this subgraph round-trip stays off the --json path.
      const roleNames = await fetchRoleNames(orgId, argv.chain);
      output.table(
        ['Type', 'Identifier', 'Leaf id', 'Grants'],
        doc.entries.map(e => [
          e.type,
          e.identifier,
          (e.emailHash ?? e.domainHash ?? '').slice(0, 14) + '…',
          e.hatIds.map(h => labelHat(h, roleNames)).join(', '),
        ])
      );

      output.keyValueBlock('Allowlist', {
        entries: doc.entries.length,
        merkleRoot: root,
        cid: cid ?? '(not pinned — pass --pin)',
        cidDigest: cidDigest ?? '(n/a)',
        outFile: argv.out ?? '(not written — pass --out)',
      });

      if (cid) {
        output.success('Allowlist pinned');
        output.info(`Publish it: pop zkemail propose-allowlist --root ${root} --cid ${cid}`);
      } else {
        output.info('Nothing was written on-chain or to IPFS. Re-run with --pin to publish the file.');
      }
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      if (err?.code === 'ENOENT') {
        output.error(`File not found: ${argv.file}`);
        process.exit(EXIT.USAGE);
      }
      output.error(err?.message || String(err));
      process.exit(EXIT.USAGE);
    }
  },
};
