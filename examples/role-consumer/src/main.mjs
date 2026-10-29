import { readFile } from 'node:fs/promises';
import { createFixture } from './adapters/fixture.mjs';
import { createReadOnlyAdapter } from './adapters/read-only.mjs';
import { runFixtureStory, readOrganizationAndPermissions } from './consumer.mjs';

const args = process.argv.slice(2);
try {
  let result;
  if (!args.length || (args.length === 1 && args[0] === '--fixture')) {
    const config = JSON.parse(await readFile(new URL('../fixtures/role-workflow.v1.json', import.meta.url), 'utf8'));
    result = await runFixtureStory(createFixture(config));
  } else if (args.length === 3 && args[0] === '--read-only' && args[1] === '--input') {
    const input = JSON.parse(await readFile(args[2], 'utf8'));
    const adapter = createReadOnlyAdapter(input, { fetch: globalThis.fetch, now: () => Math.floor(Date.now() / 1000), signal: AbortSignal.timeout(20000) });
    result = { synthetic: false, mode: 'explicit-public-read-only', observations: await readOrganizationAndPermissions(adapter) };
  } else throw new Error('Usage: node src/main.mjs [--fixture | --read-only --input PUBLIC_INPUT.json]');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  // Avoid dumping credentials/URLs/transport bodies from host exceptions.
  process.stderr.write(JSON.stringify({ status: 'failed', code: 'CONSUMER_FAILED', detail: String(error.message).startsWith('Usage:') ? error.message : 'See scoped test evidence; no signing or retry was attempted.' }) + '\n');
  process.exitCode = 1;
}
