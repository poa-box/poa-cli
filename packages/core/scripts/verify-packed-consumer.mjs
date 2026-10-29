#!/usr/bin/env node
// Explicit candidate verification only: this script never builds or packs core.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const script = fileURLToPath(import.meta.url), coreRoot = resolve(dirname(script), '..'), repoRoot = resolve(coreRoot, '../..');
export function parseArguments(args, cwd = process.cwd()) {
  if (args.length !== 1 || args[0].startsWith('-')) throw new Error('USAGE: node packages/core/scripts/verify-packed-consumer.mjs PATH_TO_CORE_TGZ');
  const archive = resolve(cwd, args[0]);
  if (!archive.endsWith('.tgz') || !existsSync(archive) || !lstatSync(archive).isFile()) throw new Error('EXPLICIT_CORE_TARBALL_REQUIRED');
  return { archive };
}
export function assertInside(file, directory) {
  const child = relative(realpathSync(directory), realpathSync(file));
  if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) throw new Error('ISOLATION_RESOLUTION_OUTSIDE_STAGE');
}
export function validatePackage(pkg) {
  if (pkg.name !== '@poa-box/core' || !pkg.version || !pkg.exports?.['./*']) throw new Error('NOT_A_SUPPORTED_CORE_PACKAGE');
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if (/^(?:link:|workspace:|file:)/.test(version)) throw new Error('NONARCHIVE_DEPENDENCY:' + name);
  }
}
export async function verifyBrowserBundle(code) {
  if (/\brequire\s*\(\s*['"](?:node:|fs|crypto|http|https)/.test(code)) throw new Error('BROWSER_NODE_IMPORT_REQUIRED');
  const context = { TextEncoder, TextDecoder, URL, AbortController, setTimeout, clearTimeout, structuredClone, atob, btoa, console,
    fetch: () => { throw new Error('REAL_NETWORK_FORBIDDEN'); } };
  context.window = context; context.self = context;
  // Dependencies may guard optional Node branches with typeof process. Exercise
  // the complete story without supplying Node globals rather than rejecting the
  // mere spelling of those guarded branches in a browser dependency.
  vm.runInNewContext(code, context, { timeout: 30000 });
  const result = await context.fixtureResult;
  if (['process', 'Buffer', 'require'].some(name => name in context)) throw new Error('BROWSER_NODE_GLOBAL_INJECTED');
  if (result?.configuration?.outcome?.data?.next !== 'complete') throw new Error('BROWSER_FIXTURE_FAILED');
  return result;
}
export async function verify(archive) {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('NODE_18_OR_NEWER_REQUIRED');
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const base = join(repoRoot, '.context/registry-integration/consumer');
  mkdirSync(base, { recursive: true });
  // A new run directory preserves all previous verification evidence and installs.
  const stage = join(base, sha256.slice(0, 12) + '-' + Date.now()); mkdirSync(stage);
  const evidence = { schemaVersion: 1, archive, sha256, stage, node: process.version, synthetic: true, status: 'in-progress', checks: [] };
  const save = () => writeFileSync(join(stage, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  const run = (name, executable, args, options = {}) => {
    const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = spawnSync(executable, args, { cwd: stage, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
    writeFileSync(join(stage, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
    evidence.checks.push({ name, passed: result.status === 0 && !result.error, log: join(stage, name + '.log') }); save();
    if (result.status !== 0 || result.error) throw new Error(name === 'install' ? 'OFFLINE_INSTALL_BLOCKED_SEE_LOG' : 'CHECK_FAILED:' + name);
    return result.stdout;
  };
  save();
  try {
    const pkg = JSON.parse(run('archive-metadata', 'tar', ['-xOf', archive, 'package/package.json'])); validatePackage(pkg); evidence.packageVersion = pkg.version;
    cpSync(join(repoRoot, 'examples/role-consumer'), stage, { recursive: true, filter: file => !file.split(sep).includes('node_modules') });
    cpSync(archive, join(stage, 'core.tgz'));
    const app = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
    app.devDependencies = { '@types/node': '^18.19.0', typescript: '^5.6.0', esbuild: '^0.21.3' };
    writeFileSync(join(stage, 'package.json'), JSON.stringify(app, null, 2) + '\n');
    // Resolve only the supplied archive; every registry dependency stays pinned to
    // the committed existing lock and must already be in the Yarn offline cache.
    const sha1 = createHash('sha1').update(readFileSync(archive)).digest('hex');
    const dependencyLines = Object.entries(pkg.dependencies ?? {}).map(([name, version]) => '    ' + JSON.stringify(name) + ' ' + JSON.stringify(version));
    const entry = '\n"@poa-box/core@file:./core.tgz":\n  version ' + JSON.stringify(pkg.version) + '\n  resolved "file:./core.tgz#' + sha1 + '"\n' + (dependencyLines.length ? '  dependencies:\n' + dependencyLines.join('\n') + '\n' : '');
    writeFileSync(join(stage, 'yarn.lock'), readFileSync(join(stage, 'yarn.lock'), 'utf8') + entry);
    run('install', 'yarn', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--non-interactive', '--no-progress']);
    const requireInstalled = createRequire(join(stage, 'package.json'));
    const inside = file => assertInside(file, join(stage, 'node_modules'));
    const imports = ['@poa-box/core/governance/role-operations', '@poa-box/core/reads/authority', '@poa-box/core/authority/permissions', '@poa-box/core/execute/recovery', '@poa-box/core/tx/intent', 'ethers', 'typescript', 'esbuild'];
    evidence.resolvedImports = {};
    for (const specifier of imports) { const file = requireInstalled.resolve(specifier); inside(file); evidence.resolvedImports[specifier] = realpathSync(file); }
    const installedRoot = dirname(requireInstalled.resolve('@poa-box/core/package.json'));
    for (const name of ['README.md', 'docs/role-operations.md', 'docs/agents.md', 'docs/operation-manifest.v1.json', 'docs/operation-manifest.schema.json', 'docs/frontend-adoption.md']) {
      if (!existsSync(join(installedRoot, name))) throw new Error('MISSING_PACKAGED_DOCUMENT:' + name);
    }
    const catalog = JSON.parse(readFileSync(join(installedRoot, 'docs/operation-manifest.v1.json'), 'utf8'));
    if (catalog.packageVersion !== pkg.version) throw new Error('CATALOG_PACKAGE_VERSION_MISMATCH');
    for (const operation of catalog.operations) if (typeof requireInstalled(operation.import)[operation.id] !== 'function') throw new Error('MISSING_CATALOG_EXPORT:' + operation.id);
    for (const reference of catalog.references) for (const name of reference.exports) if (typeof requireInstalled(reference.import)[name] !== 'function') throw new Error('MISSING_REFERENCE_EXPORT:' + name);
    // Resolve the transitive CommonJS closure under the isolated package. No
    // optional executor import is loaded by this consumer.
    const guard = `const Module = require('node:module'); const fs = require('node:fs'); const path = require('node:path');
const resolveModule = Module._resolveFilename;
Module._resolveFilename = function(specifier, parent, ...rest) {
  const resolved = resolveModule.call(this, specifier, parent, ...rest);
  if (!Module.isBuiltin(resolved)) {
    const actual = fs.realpathSync(resolved), rel = path.relative(${JSON.stringify(stage)}, actual);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('RESOLUTION_ESCAPED_ISOLATION');
  }
  return resolved;
};
globalThis.fetch = () => { throw new Error('REAL_NETWORK_FORBIDDEN'); };
for (const name of ['node:http','node:https','node:net','node:tls','node:dgram']) {
  const transport = require(name);
  for (const method of ['request','get','connect','createConnection','createSocket']) if (typeof transport[method] === 'function') transport[method] = () => { throw new Error('REAL_NETWORK_FORBIDDEN'); };
}`;
    writeFileSync(join(stage, 'offline-guard.cjs'), guard);
    run('fixtures', process.execPath, ['--require', './offline-guard.cjs', '--test', 'test/adapters.test.mjs', 'test/consumer.test.mjs']);
    run('default-story', process.execPath, ['--require', './offline-guard.cjs', 'src/main.mjs']);
    const ts = requireInstalled('typescript');
    const declarationFile = join(stage, 'public-api.ts');
    writeFileSync(declarationFile, `import { readRoleOperationEvidence, reviewRoleOperation, prepareRoleOperation, revalidatePreparedRoleOperation, readRoleOperationStatus,
  type RoleOperationScope, type RoleOperationRequest, type RoleOperationSources, type RoleOperationReview, type PreparedRoleOperation }
  from '@poa-box/core/governance/role-operations';
import { buildGovernanceProposal } from '@poa-box/core/tx/governance';
import { encodeIntent, executeIntentWithHost } from '@poa-box/core/tx/intent';
import { reconcileSubmissionRecovery } from '@poa-box/core/execute/recovery';
declare const scope: RoleOperationScope, request: RoleOperationRequest, sources: RoleOperationSources, review: RoleOperationReview, prepared: PreparedRoleOperation;
readRoleOperationEvidence({scope,request,sources}); reviewRoleOperation({scope,request,sources});
prepareRoleOperation({scope,sources,review,currentRequest:request});
revalidatePreparedRoleOperation({scope,sources,review,currentRequest:request,prepared});
readRoleOperationStatus({scope,sources,creation:{transactionHash:'0x00',call:{target:scope.contract,value:'0',calldata:'0x'}}});
void [buildGovernanceProposal,encodeIntent,executeIntentWithHost,reconcileSubmissionRecovery];
`);
    for (const [name, module, moduleResolution] of [['classic', ts.ModuleKind.CommonJS, ts.ModuleResolutionKind.NodeJs], ['Node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16], ['bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler]]) {
      const options = { strict: true, skipLibCheck: false, noEmit: true, esModuleInterop: true, target: ts.ScriptTarget.ES2022, module, moduleResolution,
        types: ['node'], typeRoots: [join(stage, 'node_modules/@types')] };
      const host = ts.createCompilerHost(options);
      host.getCurrentDirectory = () => stage;
      // The stage lives under repository diagnostics. Make its compiler filesystem
      // behave like a standalone install: ancestor node_modules cannot satisfy a
      // missing import (including an optional ambient Node module such as buffer).
      const inStage = file => {
        const child = relative(stage, resolve(file));
        return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
      };
      for (const method of ['fileExists', 'directoryExists']) {
        const original = host[method]?.bind(host);
        if (original) host[method] = file => inStage(file) && original(file);
      }
      const read = host.readFile.bind(host);
      host.readFile = file => inStage(file) ? read(file) : undefined;
      const program = ts.createProgram([declarationFile], options, host), diagnostics = ts.getPreEmitDiagnostics(program);
      for (const file of program.getSourceFiles()) if (file.fileName.includes('node_modules')) inside(file.fileName);
      writeFileSync(join(stage, 'declarations-' + name + '.log'), diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
      evidence.checks.push({ name: 'declarations-' + name, passed: diagnostics.length === 0 }); save();
      if (diagnostics.length) throw new Error('DECLARATION_CHECK_FAILED:' + name);
    }
    // Execute packaged documentation, not a parallel copy of its wallet examples.
    const markdown = readFileSync(join(installedRoot, 'README.md'), 'utf8');
    const wallets = markdown.match(/<!-- sdk-test:wallets -->\s*```js\n([\s\S]*?)```/);
    if (!wallets) throw new Error('MISSING_PACKAGED_EXECUTABLE_SNIPPET');
    const js = ts.transpileModule(wallets[1], { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const sandbox = { exports: {}, require: specifier => specifier === '@poa-box/core/execute/sponsored'
      ? { sendSponsored: (...args) => args } : requireInstalled(specifier) };
    vm.runInNewContext(js, sandbox);
    for (const value of ['1', '9007199254740993']) {
      const intent = { to: '0x' + '12'.repeat(20), abi: ['function pay() payable'], method: 'pay', args: [], value, meta: { domain: 'fixture', action: 'pay' } };
      const api = sandbox.exports;
      const captured = [await api.sendWithEthers(intent, { sendTransaction: call => call }), await api.sendWithViem(intent, { sendTransaction: call => call }),
        await api.sendWithWagmi(intent, call => call), (await api.sendWithSafe(intent, { createTransaction: call => call })).transactions[0],
        (await api.sendWithSponsored(intent, 'synthetic-key', 'org', 1n, {}))[5],
        (await api.sendWithHost(intent, {}, { isCurrent: () => true, execute: request => request })).result];
      if (captured.some(call => String(call.value) !== value)) throw new Error('DOCUMENTED_VALUE_LOST');
      let sent = false;
      try { await api.sendWithValueCapability(intent, { send: () => { sent = true; } }); throw new Error('VALUE_REFUSAL_MISSING'); }
      catch (error) { if (error.message !== 'NATIVE_VALUE_TRANSPORT_UNSUPPORTED' || sent) throw error; }
    }
    evidence.checks.push({ name: 'packaged-payable-docs', passed: true }); save();
    const recipe = readFileSync(join(installedRoot, 'docs/role-operations.md'), 'utf8').match(/<!-- sdk-test:role-envelope -->\s*```js\n([\s\S]*?)```/);
    if (!recipe) throw new Error('MISSING_PACKAGED_ROLE_RECIPE');
    const recipeSandbox = { exports: {}, require: requireInstalled };
    vm.runInNewContext(ts.transpileModule(recipe[1], { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, recipeSandbox);
    const { createFixture } = await import(pathToFileURL(join(stage, 'src/adapters/fixture.mjs')).href);
    const recipeConfig = JSON.parse(readFileSync(join(stage, 'fixtures/role-workflow.v1.json'), 'utf8'));
    for (const change of ['elapsed', 'module']) {
      const adapter = createFixture(structuredClone(recipeConfig));
      const review = await recipeSandbox.exports.reviewRoleOperation({ scope: adapter.scope, sources: adapter.sources, request: adapter.request });
      if (review.status !== 'ready') throw new Error('PACKAGED_RECIPE_REVIEW_FAILED');
      let managerCalls = 0;
      const result = await recipeSandbox.exports.submitReviewedRole({ scope: adapter.scope, sources: adapter.sources,
        request: adapter.request, review: review.data, publishDocument: adapter.publishDocument,
        createdAt: adapter.sources.now() * 1000, isCurrent: () => true, execute: () => { managerCalls++; },
        publishProposalDocument: async json => {
          const receipt = await adapter.publishProposalDocument(json);
          if (change === 'elapsed') adapter.state.now += 61; else adapter.state.authorityExecutor = '0x' + 'ab'.repeat(20);
          return receipt;
        } });
      if (result?.status === 'ready' || managerCalls !== 0) throw new Error('PACKAGED_RECIPE_STALE_HANDOFF');
    }
    evidence.checks.push({ name: 'packaged-role-envelope-zero-stale-handoff', passed: true }); save();
    const esbuild = requireInstalled('esbuild');
    const fixtureJSON = JSON.parse(readFileSync(join(stage, 'fixtures/role-workflow.v1.json'), 'utf8'));
    const browserEntry = `import { createFixture } from './src/adapters/fixture.mjs'; import { runFixtureStory } from './src/consumer.mjs';
      globalThis.fixtureResult = runFixtureStory(createFixture(${JSON.stringify(fixtureJSON)}));`;
    writeFileSync(join(stage, 'browser-entry.mjs'), browserEntry);
    const bundled = await esbuild.build({ absWorkingDir: stage, entryPoints: ['browser-entry.mjs'], bundle: true, platform: 'browser',
      format: 'iife', mainFields: ['browser', 'module', 'main'], write: false, metafile: true });
    writeFileSync(join(stage, 'browser-metafile.json'), JSON.stringify(bundled.metafile, null, 2));
    for (const [input, detail] of Object.entries(bundled.metafile.inputs)) {
      // Browser-field false replacements are virtual empty modules, not files.
      // Every physical input still has to resolve within the isolated install.
      if (input.startsWith('(disabled):')) {
        if (detail.bytes !== 0 || detail.imports.length !== 0) throw new Error('NONEMPTY_DISABLED_BROWSER_MODULE');
        continue;
      }
      assertInside(resolve(stage, input), stage);
      if (/(?:^|\/)(?:viem|permissionless|react|poa-app)(?:\/|$)|execute\/sponsored/.test(input)) throw new Error('BROWSER_DEPENDENCY_FORBIDDEN:' + input);
      for (const imported of detail.imports) if (imported.external) throw new Error('BROWSER_EXTERNAL_IMPORT:' + imported.path);
    }
    const code = bundled.outputFiles[0].text;
    writeFileSync(join(stage, 'browser-bundle.js'), code);
    await verifyBrowserBundle(code);
    evidence.checks.push({ name: 'installed-browser-bundle-and-vm', passed: true });
    evidence.status = 'verified'; save(); return evidence;
  } catch (error) {
    evidence.status = error.message === 'OFFLINE_INSTALL_BLOCKED_SEE_LOG' ? 'blocked' : 'failed'; evidence.error = error.message; save();
    throw Object.assign(error, { evidencePath: join(stage, 'evidence.json') });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    const result = await verify(parseArguments(process.argv.slice(2)).archive);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'failed', code: error.message, ...(error.evidencePath ? { evidencePath: error.evidencePath } : {}) }) + '\n'); process.exitCode = 1;
  }
}
