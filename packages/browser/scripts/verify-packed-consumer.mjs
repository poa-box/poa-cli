#!/usr/bin/env node
/** Install only the explicit archive; exercise public entry points outside the repository. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repo = resolve(root, '../..');
const archive = process.argv.length === 3 ? resolve(process.argv[2]) : undefined;
if (!archive || !archive.endsWith('.tgz') || !existsSync(archive)) throw new Error('EXPLICIT_BROWSER_ARCHIVE_REQUIRED');
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
const stage = mkdtempSync(join(tmpdir(), 'poa-browser-consumer-'));
const evidenceDir = join(repo, '.context/browser-sdk/consumer', sha256.slice(0, 12) + '-' + Date.now()); mkdirSync(evidenceDir, { recursive: true });
const evidence = { archive, sha256, stage, node: process.version, status: 'running', checks: [] };
const save = () => writeFileSync(join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
function run(name, command, args, options = {}) {
  const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
  const result = spawnSync(command, args, { cwd: stage, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000, ...options });
  writeFileSync(join(evidenceDir, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  evidence.checks.push({ name, passed: result.status === 0 && !result.error }); save();
  if (result.status !== 0 || result.error) throw new Error('BROWSER_CONSUMER_CHECK_FAILED:' + name);
  return result.stdout;
}
function within(file, parent = stage) {
  const rel = relative(realpathSync(parent), realpathSync(file));
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('PACKAGE_RESOLUTION_ESCAPED_STAGE');
}
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]); }
try {
  const pkg = JSON.parse(run('archive-metadata', 'tar', ['-xOf', archive, 'package/package.json']));
  if (pkg.name !== '@poa-box/browser' || pkg.dependencies?.['@poa-box/core'] !== '2.1.0') throw new Error('UNEXPECTED_BROWSER_PACKAGE');
  for (const value of Object.values({ ...pkg.dependencies, ...pkg.peerDependencies })) if (/^(?:link|file|workspace):/.test(value)) throw new Error('LOCAL_PACKAGE_DEPENDENCY');
  cpSync(archive, join(stage, 'browser.tgz'));
  const app = { name: 'poa-browser-packed-verification', version: '1.0.0', private: true, type: 'module',
    dependencies: { '@poa-box/browser': 'file:./browser.tgz', '@poa-box/core': '2.1.0', ethers: '5.7.2' },
    devDependencies: { typescript: '^5.6.0', '@types/node': '^18.19.0', esbuild: '^0.21.3', vitest: '^1.6.0' } };
  writeFileSync(join(stage, 'package.json'), JSON.stringify(app, null, 2));
  const hash = createHash('sha1').update(readFileSync(archive)).digest('hex');
  const entry = '\n"@poa-box/browser@file:./browser.tgz":\n  version ' + JSON.stringify(pkg.version) + '\n  resolved "file:./browser.tgz#' + hash + '"\n  dependencies:\n'
    + Object.entries(pkg.dependencies).map(([name, value]) => '    ' + JSON.stringify(name) + ' ' + JSON.stringify(value)).join('\n') + '\n';
  writeFileSync(join(stage, 'yarn.lock'), readFileSync(join(root, 'yarn.lock'), 'utf8') + entry);
  run('install', 'yarn', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--non-interactive', '--no-progress']);
  const require = createRequire(join(stage, 'package.json'));
  const imports = ['@poa-box/browser', ...['wallet', 'passkeys', 'storage', 'session', 'workflows', 'config', 'observations'].map(name => '@poa-box/browser/' + name), '@poa-box/core', 'ethers', 'typescript', 'esbuild', 'vitest'];
  evidence.imports = Object.fromEntries(imports.map(name => { const file = require.resolve(name); within(file); return [name, file]; })); save();
  const installed = dirname(require.resolve('@poa-box/browser/package.json'));
  for (const file of ['README.md', 'docs/integration.md', 'docs/features.v1.json']) if (!existsSync(join(installed, file))) throw new Error('MISSING_BROWSER_DOC:' + file);
  cpSync(join(repo, 'examples/role-consumer'), join(stage, 'example'), { recursive: true, filter: path => !path.split(sep).includes('node_modules') });
  cpSync(join(root, 'test'), join(stage, 'test'), { recursive: true });
  // Replay behavioural tests against installed JS, never aliased TS source.
  for (const file of walk(join(stage, 'test'))) {
    if (!file.endsWith('.ts')) continue;
    if (file.endsWith('role-parity.test.ts') || file.endsWith('package-contract.test.ts')) { rmSync(file); continue; }
    const source = readFileSync(file, 'utf8').replace(/(['"])\.\.\/\.\.\/src\/([^'"]+)\1/g, (_match, quote, leaf) => quote + '@poa-box/browser/' + leaf.split('/')[0] + quote);
    if (/from ['"](?:\.\.\/)+src\//.test(source)) throw new Error('UNREWRITTEN_SOURCE_IMPORT');
    writeFileSync(file, source.replaceAll('../../../../examples/role-consumer/', '../../example/'));
  }
  // Execute documentation code from the archive, not a maintained duplicate.
  const snippets = new Map();
  for (const file of ['README.md', 'docs/integration.md']) {
    const doc = readFileSync(join(installed, file), 'utf8');
    for (const match of doc.matchAll(/<!-- browser-test:([\w-]+) -->\s*```js\n([\s\S]*?)\n```/g)) {
      if (snippets.has(match[1])) throw new Error('DUPLICATE_DOC_SNIPPET');
      snippets.set(match[1], match[2]); writeFileSync(join(stage, 'doc-' + match[1] + '.mjs'), match[2]);
    }
  }
  if (['connection', 'configuration', 'poll-controller'].some(name => !snippets.has(name))) throw new Error('EXECUTABLE_DOC_EXAMPLES_REQUIRED');
  writeFileSync(join(stage, 'test/docs.test.ts'), `import { expect, test, vi } from 'vitest';
import { connectExistingWallet } from '../doc-connection.mjs';
import { inspectSetup } from '../doc-configuration.mjs';
import { createPollController } from '../doc-poll-controller.mjs';
import { fixture, scope } from './observations/fixture';
import { fixture as hostFixture } from './workflows/fixture';
import { browserStorageFixture } from './storage/browser-storage-fixture';
import { createAccountSession } from '@poa-box/browser/session';
test('documented connection uses selected identity and invalidates account round trips', async () => {
  const storage = browserStorageFixture(), listeners = new Map();
  vi.stubGlobal('indexedDB', storage.indexedDB); vi.stubGlobal('navigator', { locks: storage.locks });
  const ethereum = { request: async ({method}) => method === 'eth_chainId' ? '0x64' : method === 'eth_accounts' ? [scope.account] : (()=>{throw new Error('UNEXPECTED_WALLET_REQUEST:' + method)})(),
    on: (event, callback) => listeners.set(event, callback), removeListener: event => listeners.delete(event) };
  try { const connection = await connectExistingWallet(ethereum), active = connection.session.capture();
    expect(active.scope).toEqual({chainId:100,accountAddress:scope.account});
    listeners.get('accountsChanged')(); expect(active.isCurrent()).toBe(false);
    connection.dispose(); expect(listeners.size).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});
test('documented setup reports unknown configuration without granting authorization', () => {
  const report = inspectSetup({chainId:100,endpoints:{}}, {});
  expect(report.authorization).toBe(false); expect(report.networkChecked).toBe(false);
  expect(report.features.every(row => row.authorization === false)).toBe(true);
});
test('documented complete reader assembly reviews a real policy and catches later account changes', async () => {
  const f = fixture(), host = hostFixture(), session = createAccountSession({initialScope:{chainId:100,accountAddress:scope.account}});
  const workflow = createPollController({workflowId:'doc-poll', connection:{session,journal:host.host.journal,wallet:{...host.host.wallet,getIdentity:async()=>({chainId:100,accountAddress:scope.account})}},
    scope,sources:f.sources,provider:f.provider,query:f.query,confirm:host.host.confirm,documents:host.host.documents});
  const request = {lane:'dd',title:'Community priorities',description:'Choose together.',durationMinutes:'60',optionNames:['A','B'],createdAt:1000000};
  expect((await workflow.review(request)).status).toBe('ready');
  expect(host.control.publishes).toBe(0); expect(host.control.sends).toBe(0);
  session.clear(); expect((await workflow.review(request)).status).not.toBe('ready');
});`);
  writeFileSync(join(stage, 'vitest.config.mjs'), `export default { test: { include: ['test/**/*.test.ts'], pool: 'forks', poolOptions: { forks: { minForks: 1, maxForks: 4 } } } };`);
  const guard = `const Module = require('node:module'), fs = require('node:fs'), path = require('node:path');
const original = Module._resolveFilename;
Module._resolveFilename = function(...args) { const value = original.apply(this,args); if (!Module.isBuiltin(value)) {
 const rel = path.relative(${JSON.stringify(realpathSync(stage))},fs.realpathSync(value)); if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)) throw new Error('RESOLUTION_ESCAPED_PACKED_CONSUMER'); } return value; };
globalThis.fetch=()=>{throw new Error('REAL_NETWORK_FORBIDDEN')};
for(const name of ['node:http','node:https','node:net','node:tls','node:dgram']) {const transport=require(name);for(const method of ['request','get','connect','createConnection','createSocket'])if(typeof transport[method]==='function')transport[method]=()=>{throw new Error('REAL_NETWORK_FORBIDDEN')};}`;
  writeFileSync(join(stage, 'offline.cjs'), guard);
  run('distributed-runtime-and-workflows', process.execPath, ['--require', './offline.cjs', 'node_modules/vitest/vitest.mjs', 'run']);
  // Independent role host uses the exact same exported controller/adapters as
  // applications, while the original core-only quickstart remains installable.
  cpSync(join(repo, 'examples/role-consumer'), join(stage, 'example'), { recursive: true, filter: path => !path.split(sep).includes('node_modules') });
  writeFileSync(join(stage, 'example/src/workflow.mjs'), "export { createRoleWorkflow } from '@poa-box/browser/workflows';\n");
  writeFileSync(join(stage, 'example/src/adapters/ethers-wallet.mjs'), "export { createEthersWalletAdapter } from '@poa-box/browser/wallet';\n");
  writeFileSync(join(stage, 'example/src/adapters/browser-journal.mjs'), "export { createBrowserJournal } from '@poa-box/browser/storage';\n");
  const exampleTests = readdirSync(join(stage, 'example/test')).filter(file => file.endsWith('.test.mjs')).sort().map(file => 'example/test/' + file);
  run('independent-role-host', process.execPath, ['--require', './offline.cjs', '--test', ...exampleTests]);
  run('role-workflow-demo', process.execPath, ['--require', './offline.cjs', 'example/src/main.mjs', '--workflow-fixture']);
  const ts = require('typescript');
  const declarationFile = join(stage, 'consumer.ts');
  writeFileSync(declarationFile, `import * as runtime from '@poa-box/browser';
import { createPasskeyClient } from '@poa-box/browser/passkeys';
import { createEthersWalletAdapter, createSponsoredExecutionAdapter } from '@poa-box/browser/wallet';
import { createBrowserJournal } from '@poa-box/browser/storage';
import { createAccountSession } from '@poa-box/browser/session';
import { createPollWorkflow, createBallotWorkflow, createTaskWorkflow, createEnrollmentWorkflow, createRoleWorkflow, type WorkflowHost } from '@poa-box/browser/workflows';
import { checkBrowserConfiguration, diagnoseBrowserConfiguration } from '@poa-box/browser/config';
import { createWorkflowReaders } from '@poa-box/browser/observations';
void [runtime,createPasskeyClient,createEthersWalletAdapter,createSponsoredExecutionAdapter,createBrowserJournal,createAccountSession,createPollWorkflow,createBallotWorkflow,createTaskWorkflow,createEnrollmentWorkflow,createRoleWorkflow,checkBrowserConfiguration,diagnoseBrowserConfiguration,createWorkflowReaders];
declare const host: WorkflowHost; void host;
`);
  for (const [name, module, moduleResolution] of [['classic', ts.ModuleKind.CommonJS, ts.ModuleResolutionKind.NodeJs], ['Node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16], ['bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler]]) {
    const options = { strict: true, skipLibCheck: false, noEmit: true, esModuleInterop: true, target: ts.ScriptTarget.ES2022, module, moduleResolution,
      types: ['node'], typeRoots: [join(stage, 'node_modules/@types')] };
    const program = ts.createProgram([declarationFile], options), diagnostics = ts.getPreEmitDiagnostics(program);
    for (const file of program.getSourceFiles()) if (file.fileName.includes('node_modules')) within(file.fileName);
    writeFileSync(join(evidenceDir, 'declarations-' + name + '.log'), diagnostics.map(value => ts.flattenDiagnosticMessageText(value.messageText, '\n')).join('\n'));
    evidence.checks.push({ name: 'declarations-' + name, passed: !diagnostics.length }); save();
    if (diagnostics.length) throw new Error('DECLARATIONS_FAILED:' + name);
  }
  const esbuild = require('esbuild');
  const browserEntry = `import { createFixture } from './example/src/adapters/fixture.mjs';
import { createWorkflowFixture, runWorkflowFixture } from './example/src/workflow-fixture.mjs';
import { checkBrowserConfiguration } from '@poa-box/browser/config';
import { createAccountSession } from '@poa-box/browser/session';
globalThis.browserExports = {checkBrowserConfiguration,createAccountSession};
globalThis.fixtureResult = runWorkflowFixture(${readFileSync(join(stage, 'example/fixtures/role-workflow.v1.json'), 'utf8')});`;
  // The demo helper accepts a config and constructs the real package controller.
  writeFileSync(join(stage, 'browser-entry.mjs'), browserEntry);
  const bundle = await esbuild.build({ absWorkingDir: stage, entryPoints: ['browser-entry.mjs'], bundle: true, platform: 'browser', format: 'iife', mainFields: ['browser', 'module', 'main'], write: false, metafile: true });
  for (const input of Object.keys(bundle.metafile.inputs)) {
    if (input.startsWith('(disabled):')) continue; // Browser-map exclusions are esbuild virtual modules.
    within(resolve(stage, input));
  }
  const context = { TextEncoder, TextDecoder, URL, AbortController, setTimeout, clearTimeout, structuredClone, atob, btoa, console,
    fetch: () => { throw new Error('REAL_NETWORK_FORBIDDEN'); } };
  context.window = context; context.self = context;
  vm.runInNewContext(bundle.outputFiles[0].text, context, { timeout: 30000 });
  const story = await context.fixtureResult;
  if (story?.complete !== true || ['process', 'Buffer', 'require'].some(name => name in context)) throw new Error('BROWSER_VM_FAILED');
  writeFileSync(join(evidenceDir, 'browser-bundle.js'), bundle.outputFiles[0].text);
  evidence.checks.push({ name: 'real-package-browser-bundle-and-workflow', passed: true });
  evidence.status = 'verified'; save();
  console.log(JSON.stringify({ status: evidence.status, sha256, stage, evidence: join(evidenceDir, 'evidence.json'), checks: evidence.checks }, null, 2));
} catch (error) {
  evidence.status = 'failed'; evidence.error = error.message; save(); throw error;
}
