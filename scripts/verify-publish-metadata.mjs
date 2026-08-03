#!/usr/bin/env node
/**
 * Prove what `npm publish` would send to the REGISTRY — without publishing.
 *
 * Runs a real `npm publish` against a capture-only HTTP server on localhost
 * that records the PUT body and rejects it, so nothing is ever uploaded
 * anywhere. The captured body is the exact document npm would have written to
 * the registry, so this checks the artifact that actually breaks consumers.
 *
 *   node scripts/verify-publish-metadata.mjs
 *
 * Why not just inspect the tarball: npm reads the manifest it publishes BEFORE
 * running prepack, so a prepack-based `link:` swap fixes the tarball and
 * leaves the registry metadata broken. `@poa-box/agent@0.1.0` shipped that way
 * — `npm view @poa-box/agent@0.1.0 dependencies` still returns
 * `{"@poa-box/cli": "link:../.."}` — and a tarball check cannot see it.
 *
 * Exit 0 = the metadata npm would publish is clean.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, LINKED_PACKAGES, withPublishRanges } from './lib/link-swap.mjs';

/** Packages to check: everything publishable, linked or not. */
const PACKAGES = ['packages/core', '.', 'packages/agent'];

const BAD_RANGE = /^(link:|file:|portal:|workspace:|\^?$)/;

function startCaptureServer(capturePath) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (req.method !== 'PUT') {
          // npm fetches the packument BEFORE publishing to see which versions
          // exist. It must look like "this package is new" (404) — any other
          // status aborts the publish before the PUT we are here to capture.
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        try { writeFileSync(capturePath, body); } catch { /* reported below */ }
        // Reject the upload — this server must never look like a successful
        // publish, even by accident. 400 rather than 5xx because npm RETRIES
        // 5xx with exponential backoff, stalling each package for minutes.
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'capture-only registry: nothing is published here' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Run npm asynchronously. MUST NOT be spawnSync: the capture server lives in
 * this process, and spawnSync blocks the event loop, so the server could
 * never answer npm's requests — npm would fail before sending the PUT and the
 * check would report a false "npm sent no PUT".
 */
function runNpm(args, cwd) {
  return new Promise((resolve) => {
    // Strip the GitHub OIDC variables. Under trusted publishing npm sees them
    // and tries to exchange an OIDC token for the target registry — against
    // this capture server that exchange fails and npm aborts BEFORE the PUT,
    // which would make this check report a false "npm sent no PUT" in CI.
    const env = { ...process.env };
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    delete env.NODE_AUTH_TOKEN;
    const child = spawn('npm', args, { cwd, env });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ status: 1, stderr: String(err) }); });
  });
}

const work = mkdtempSync(join(tmpdir(), 'poa-publish-meta-'));
const { server, port } = await startCaptureServer(join(work, 'captured.json'));
const registry = `http://127.0.0.1:${port}`;

let failures = 0;
try {
  for (const dir of PACKAGES) {
    const capture = join(work, 'captured.json');
    if (existsSync(capture)) rmSync(capture);

    await withPublishRanges(dir, async () => {
      const res = await runNpm([
        'publish',
        '--registry', registry,
        // `key=value`, NOT a space-separated pair: nopt would treat the next
        // argv entry as the package SPEC to publish rather than this value.
        `--${registry.replace(/^https?:/, '')}/:_authToken=capture-only-not-a-real-token`,
        '--access', 'public',
        '--fetch-retries', '0',       // the capture server always rejects; never retry
        '--ignore-scripts',           // the manifest is what matters, not a rebuild
      ], join(ROOT, dir));
      if (process.env.DEBUG_PUBLISH_META) {
        console.error(`--- ${dir} status=${res.status} ---\n${String(res.stderr).slice(-1200)}`);
      }
      // A rejection from the capture server is the EXPECTED outcome; a run
      // that succeeded would mean we were not talking to the fake server.
      if (res.status === 0) {
        console.error(`  ✗ ${dir}: publish unexpectedly SUCCEEDED — the capture registry was bypassed`);
        failures++;
      }
    });

    if (!existsSync(capture)) {
      console.error(`  ✗ ${dir}: npm sent no PUT — cannot verify publish metadata`);
      failures++;
      continue;
    }

    const doc = JSON.parse(readFileSync(capture, 'utf8'));
    const version = Object.keys(doc.versions ?? {})[0];
    const manifest = doc.versions?.[version] ?? {};
    const deps = manifest.dependencies ?? {};
    const linked = LINKED_PACKAGES.filter(e => e.dir === dir);

    const bad = Object.entries(deps).filter(([, range]) => BAD_RANGE.test(String(range)));
    if (bad.length) {
      for (const [name, range] of bad) {
        console.error(`  ✗ ${doc.name}@${version}: would publish ${name} = "${range}" — consumers cannot install this`);
      }
      failures++;
      continue;
    }

    const shown = linked.map(e => `${e.dep}=${deps[e.dep]}`).join(', ') || 'no linked deps';
    console.log(`  ✓ ${doc.name}@${version}: ${shown}`);
  }
} finally {
  server.closeAllConnections?.();
  server.close();
  rmSync(work, { recursive: true, force: true });
}

if (failures) {
  console.error(`\nverify-publish-metadata: ${failures} package(s) would publish unusable metadata.\n`);
  process.exit(1);
}
console.log('\nverify-publish-metadata: registry metadata is clean for every package.\n');
