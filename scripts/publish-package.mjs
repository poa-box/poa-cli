#!/usr/bin/env node
/**
 * Publish one package with its `link:` dependency correctly swapped.
 *
 *   node scripts/publish-package.mjs <dir> [extra npm publish args...]
 *   node scripts/publish-package.mjs packages/agent --access public --provenance
 *
 * The swap happens BEFORE `npm publish` is invoked, because npm reads the
 * manifest it uploads before running prepack — see scripts/lib/link-swap.mjs
 * for the experiment that established this. The link: form is restored in a
 * finally block, so a failed publish never leaves the tree pinned to a range
 * that may not exist.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, withPublishRanges, entryForDir, currentRange } from './lib/link-swap.mjs';

const [dir, ...npmArgs] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node scripts/publish-package.mjs <dir> [npm publish args...]');
  process.exit(1);
}

const result = await withPublishRanges(dir, (range) => {
  const entry = entryForDir(dir);
  if (entry) {
    // Assert the swap actually landed before anything irreversible happens.
    const onDisk = currentRange(entry);
    if (onDisk !== range || /^(link|file):/.test(onDisk)) {
      console.error(`publish-package: refusing to publish — ${entry.dep} is "${onDisk}", expected "${range}"`);
      return { status: 1 };
    }
    console.log(`publish-package: ${dir} → ${entry.dep}@${range}`);
  }
  return spawnSync('npm', ['publish', ...npmArgs], {
    cwd: join(ROOT, dir),
    stdio: 'inherit',
    env: process.env,
  });
});

process.exit(result?.status ?? 1);
