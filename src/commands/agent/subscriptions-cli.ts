/**
 * Subscription editing CLI (Task #513, HB#599).
 *
 *   pop agent subscribe --id ... --doc ... --filter '...' [--priority 0] [--drift-threshold 50]
 *   pop agent unsubscribe --id ...
 *   pop agent subscriptions       (list current)
 *
 * Backed by ~/.pop-agent/brain/Config/subscriptions.json.
 * Atomic write-back via saveSubscriptions() (Q2 peer-poll resolution
 * sentinel HB#968 — saveHeadsManifestV2 pattern).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import {
  loadSubscriptions,
  saveSubscriptions,
  validateFilter,
  type Subscription,
} from '../../lib/subscriptions';
import * as output from '../../lib/output';

interface SubscribeArgs {
  id: string;
  doc: string;
  filter: string;
  priority?: number;
  'drift-threshold'?: number;
}

interface UnsubscribeArgs {
  id: string;
}

export const subscribeHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('id', {
        type: 'string',
        demandOption: true,
        describe: 'Unique subscription id (e.g. vigil-watch-paymaster). Refuses duplicates.',
      })
      .option('doc', {
        type: 'string',
        demandOption: true,
        describe: 'Brain doc to watch (e.g. pop.brain.shared)',
      })
      .option('filter', {
        type: 'string',
        demandOption: true,
        describe:
          'JSON filter object — supported keys: author, delegateTo, tags, titleContains, causedByContains. Multiple keys = AND.',
      })
      .option('priority', {
        type: 'number',
        default: 0,
        describe: 'Surface priority for matched events. Default 0 (PRIORITY_0 above HIGH/MEDIUM).',
      })
      .option('drift-threshold', {
        type: 'number',
        describe:
          'Override drift threshold (HB cycles since last match before WARN). Default 50 (~12.5h at 15-min cadence).',
      }),

  handler: async (argv: ArgumentsCamelCase<SubscribeArgs>) => {
    let parsedFilter: any;
    try {
      parsedFilter = JSON.parse(argv.filter);
    } catch (e: any) {
      output.error(`Invalid --filter JSON: ${e.message}`);
      process.exit(1);
    }
    const filterRes = validateFilter(parsedFilter, '--filter');
    if (filterRes.errors.length > 0) {
      for (const e of filterRes.errors) output.error(e);
      process.exit(1);
    }
    for (const w of filterRes.warnings) output.info(w);

    const { file } = loadSubscriptions();
    if (file.subscriptions.some((s) => s.id === argv.id)) {
      output.error(
        `Subscription id "${argv.id}" already exists. Use a different --id, or run 'pop agent unsubscribe --id ${argv.id}' first.`,
      );
      process.exit(1);
    }
    const newSub: Subscription = {
      id: argv.id,
      docId: argv.doc,
      filter: filterRes.canonical,
      priority: argv.priority ?? 0,
      driftThreshold:
        argv['drift-threshold'] != null ? argv['drift-threshold'] : undefined,
      matchCount: 0,
      lastMatchAt: null,
      lastMatchedLessonId: null,
      createdAt: Math.floor(Date.now() / 1000),
    };
    file.subscriptions.push(newSub);
    saveSubscriptions(file);

    if (output.isJsonMode()) {
      output.json({
        ok: true,
        added: { id: newSub.id, docId: newSub.docId, filter: newSub.filter },
      });
    } else {
      console.log('');
      console.log(`  ✓ Subscription "${newSub.id}" added (watching ${newSub.docId}).`);
      console.log(`    Filter: ${JSON.stringify(newSub.filter)}`);
      console.log(`    Priority: ${newSub.priority} (PRIORITY_0 surfaces above HIGH/MEDIUM)`);
      if (newSub.driftThreshold != null) {
        console.log(`    Drift threshold: ${newSub.driftThreshold} HB cycles`);
      }
      console.log('');
    }
  },
};

export const unsubscribeHandler = {
  builder: (yargs: Argv) =>
    yargs.option('id', {
      type: 'string',
      demandOption: true,
      describe: 'Subscription id to remove',
    }),

  handler: async (argv: ArgumentsCamelCase<UnsubscribeArgs>) => {
    const { file } = loadSubscriptions();
    const idx = file.subscriptions.findIndex((s) => s.id === argv.id);
    if (idx < 0) {
      output.error(`No subscription with id "${argv.id}".`);
      process.exit(1);
    }
    const removed = file.subscriptions.splice(idx, 1)[0];
    saveSubscriptions(file);

    if (output.isJsonMode()) {
      output.json({ ok: true, removed: { id: removed.id, docId: removed.docId } });
    } else {
      console.log('');
      console.log(`  ✓ Subscription "${removed.id}" removed.`);
      console.log('');
    }
  },
};

export const subscriptionsListHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (_argv: ArgumentsCamelCase<{}>) => {
    const { result, file } = loadSubscriptions();

    if (output.isJsonMode()) {
      output.json({
        ok: result.ok,
        warnings: result.warnings,
        count: file.subscriptions.length,
        subscriptions: file.subscriptions,
      });
      return;
    }

    console.log('');
    console.log('  Subscriptions');
    console.log('  ═════════════');
    if (file.subscriptions.length === 0) {
      console.log('  (none) — use `pop agent subscribe` to add one.');
      console.log('');
      return;
    }
    const nowSecs = Math.floor(Date.now() / 1000);
    for (const s of file.subscriptions) {
      const ageStr =
        s.lastMatchAt != null
          ? `${Math.floor((nowSecs - s.lastMatchAt) / 60)}m ago`
          : 'never';
      const driftStr =
        s.driftThreshold != null ? `(threshold: ${s.driftThreshold} HBs)` : '(threshold: 50 HBs default)';
      console.log(`  • ${s.id} → ${s.docId}`);
      console.log(`    filter: ${JSON.stringify(s.filter)}`);
      console.log(`    priority: ${s.priority ?? 0}  matches: ${s.matchCount ?? 0}  last: ${ageStr}  ${driftStr}`);
    }
    console.log('');
  },
};