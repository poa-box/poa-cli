/**
 * Optional-peer isolation at the TYPE level.
 *
 * viem and permissionless are optional peers: a consumer that only reads (or
 * only uses the plain-EOA executor) may not have them installed. With
 * skipLibCheck:false, ANY `from 'viem'` in the .d.ts closure of an entry
 * point is a TS2307 for that consumer — so the closures of the root barrel
 * and of execute/ethers must never reference them. Only execute/sponsored
 * (and the execute barrel that includes it) may.
 *
 * Runs against dist/, so `yarn build` must precede `yarn test` when
 * declarations changed (build regenerates them; CI runs build first).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import ts from 'typescript';

const DIST = resolve(__dirname, '..', 'dist');

/** Transitive closure of relative imports/re-exports in built declarations. */
function declarationClosure(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    if (!existsSync(file)) throw new Error(`Missing public declaration: ${file}`);
    const src = readFileSync(file, 'utf-8');
    seen.set(file, src);
    for (const specifier of moduleSpecifiers(src)) {
      if (!specifier.startsWith('.')) continue;
      let p = join(dirname(file), specifier);
      if (!p.endsWith('.d.ts')) {
        p = existsSync(p + '.d.ts') ? p + '.d.ts' : join(p, 'index.d.ts');
      }
      queue.push(p);
    }
  }
  return seen;
}

/** Includes import types and import-equals, which a `from` regex misses. */
function moduleSpecifiers(src: string): string[] {
  const out: string[] = [];
  const file = ts.createSourceFile('fixture.d.ts', src, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) out.push(node.argument.literal.text);
    if (ts.isExternalModuleReference(node) && node.expression && ts.isStringLiteral(node.expression)) out.push(node.expression.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return out;
}

function externalOffenders(closure: Map<string, string>, forbidden: RegExp): string[] {
  const offenders: string[] = [];
  for (const [file, src] of closure) {
    if (moduleSpecifiers(src).some(spec => forbidden.test(spec))) offenders.push(file.slice(DIST.length + 1));
  }
  return offenders;
}

const VIEM_RE = /^(?:viem|permissionless)(?:\/|$)/;

describe('viem/permissionless never enter dependency-free declaration closures', () => {
  it('root barrel (index.d.ts)', () => {
    const offenders = externalOffenders(declarationClosure(join(DIST, 'index.d.ts')), VIEM_RE);
    expect(offenders, `viem-typed declarations reachable from the root barrel: ${offenders.join(', ')}`).toEqual([]);
  });

  it('plain-EOA executor (execute/ethers.d.ts)', () => {
    const offenders = externalOffenders(declarationClosure(join(DIST, 'execute', 'ethers.d.ts')), VIEM_RE);
    expect(offenders, `viem-typed declarations reachable from execute/ethers: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the sponsored path itself still uses real viem types (sanity: the regex works)', () => {
    const sponsored = readFileSync(join(DIST, 'execute', 'sponsored.d.ts'), 'utf-8');
    expect(moduleSpecifiers(sponsored).some(spec => VIEM_RE.test(spec))).toBe(true);
  });

  it('detects optional imports in nested import types and import-equals', () => {
    const specifiers = moduleSpecifiers(`export type Client = import('viem').Client;
      import accounts = require('permissionless/accounts');
      export type Local = import('./local').Local;
      // import('viem/comment') is not a declaration dependency`);
    expect(specifiers.filter(spec => VIEM_RE.test(spec))).toEqual(['viem', 'permissionless/accounts']);
    expect(specifiers).toContain('./local');
  });

  it.each(['accounts/constants', 'governance/validation', 'encoding/legacy-pointer'])('%s declarations exclude full ethers, Node and optional executors', leaf => {
    const closure = declarationClosure(join(DIST, leaf + '.d.ts'));
    expect(externalOffenders(closure, /^(?:(?:ethers|viem|permissionless)(?:\/|$)|node:|@types\/node(?:\/|$))/)).toEqual([]);
    expect([...closure.keys()].filter(file => /\/(?:execute|abis)\//.test(file))).toEqual([]);
  });
  it.each(['tx/user', 'tx/zkemail', 'tx/enrollment', 'email/allowlist', 'authority/indexed-cap', 'governance/role-planning',
    'treasury/inflows', 'treasury/indexed-inflows', 'graph/documents/inflows', 'governance/dd-authorization',
    'reads/vote', 'tx/paymaster', 'graph/documents/authority', 'graph/documents/voting-classes'])('%s public declarations exclude optional peers and Node', leaf => {
    const closure = declarationClosure(join(DIST, leaf + '.d.ts'));
    expect(externalOffenders(closure, /^(?:(?:viem|permissionless)(?:\/|$)|node:|@types\/node(?:\/|$))/)).toEqual([]);
    expect([...closure.keys()].filter(file => /\/execute\//.test(file))).toEqual([]);
  });

  it.each(['tasks/project-creator', 'tasks/policy', 'reads/task', 'graph/documents/task'])('%s declarations exclude optional peers and Node', leaf => {
    const closure = declarationClosure(join(DIST, leaf + '.d.ts'));
    expect(externalOffenders(closure, /^(?:(?:viem|permissionless)(?:\/|$)|node:|@types\/node(?:\/|$))/)).toEqual([]);
    expect([...closure.keys()].filter(file => /\/execute\//.test(file))).toEqual([]);
  });

  it.each([
    ['classic', ts.ModuleKind.CommonJS, ts.ModuleResolutionKind.NodeJs],
    ['Node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16],
  ] as const)('project creator/application public types compile strictly under %s', (_name, module, moduleResolution) => {
    const file = resolve(DIST, '../test/__project_applications_type_regression__.ts');
    const consumer = `
      import { deriveProjectCreatorAuthorization, type ProjectCreatorInput, type ProjectCreatorFacts, type ProjectCreatorSources } from '@poa-box/core/tasks/project-creator';
      import { deriveProjectCreatorAuthorization as barrelCreator } from '@poa-box/core/tasks';
      import { decideTaskActions, type TaskPolicyInput } from '@poa-box/core/tasks/policy';
      import { listTaskApplicationsComplete, projectTaskApplicant, type TaskApplicationPageOptions,
        type TaskApplicationData, type TaskApplicantInput } from '@poa-box/core/reads/task';
      import { FETCH_TASK_APPLICATIONS_PAGE } from '@poa-box/core/graph/documents/task';
      import { requireCompleteSnapshot, type Fact, type SourceSnapshot } from '@poa-box/core/data/facts';
      import type { IndexedRow } from '@poa-box/core/reads/protocol';
      declare const policy: ProjectCreatorInput;
      const creator: ProjectCreatorFacts = deriveProjectCreatorAuthorization(policy);
      const member: Fact<boolean> = barrelCreator(policy).creator;
      declare const sources: ProjectCreatorSources;
      declare const indexedTask: TaskPolicyInput;
      const lifecycle = decideTaskActions({ ...indexedTask, projectCreator: { ...policy, sources } }).deleteProject;
      const createProjectGate: Fact<boolean> = deriveProjectCreatorAuthorization({ ...policy, sources }).authorized;
      // @ts-expect-error mixed policy composition requires explicit expected sources
      decideTaskActions({ ...indexedTask, projectCreator: policy });
      // @ts-expect-error the selected canonical block must include a hash
      const unproven: ProjectCreatorSources = { ...sources, block: { number: '1000' } };
      declare const options: TaskApplicationPageOptions;
      const applications: Promise<SourceSnapshot<TaskApplicationData>> = listTaskApplicationsComplete(options);
      declare const applicant: TaskApplicantInput;
      const applied: Fact<boolean> = projectTaskApplicant(applicant);
      const rows: readonly IndexedRow[] = requireCompleteSnapshot(applicant.applications).applications;
      const document: string = FETCH_TASK_APPLICATIONS_PAGE;
      // @ts-expect-error application pages require explicit bounds
      const unbounded: TaskApplicationPageOptions = { source: options.source, query: options.query, task: '1' };
      // @ts-expect-error exact IDs never use rounded Numbers
      listTaskApplicationsComplete({ ...options, task: 9007199254740992 });
      // @ts-expect-error host must select an expected block
      projectTaskApplicant({ applications: applicant.applications, scope: applicant.scope, task: '1' });
    `;
    const options: ts.CompilerOptions = { strict: true, skipLibCheck: false, noEmit: true, esModuleInterop: true,
      target: ts.ScriptTarget.ES2022, module, moduleResolution, types: ['node'] };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.getSourceFile = (path, version, onError, fresh) => path === file ? ts.createSourceFile(path, consumer, version, true) : original(path, version, onError, fresh);
    const program = ts.createProgram([file], options, host);
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  });

  it.each([
    ['classic', ts.ModuleKind.CommonJS, ts.ModuleResolutionKind.NodeJs],
    ['Node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16],
  ] as const)('display/ballot/DD/donation public types compile strictly under %s', (_name, module, moduleResolution) => {
    const file = resolve(DIST, '../test/__authority_display_type_regression__.ts');
    const consumer = `
      import { readProposalBallotFacts, type ProposalBallotOptions } from '@poa-box/core/reads/vote';
      import { FETCH_AUTHORITY_MEMBERSHIP_EVENTS_RECENT, FETCH_AUTHORITY_CONFIG_LINTS_RECENT } from '@poa-box/core/graph/documents/authority';
      import { FETCH_HYBRID_PROPOSAL_BALLOTS_PAGE, FETCH_DD_PROPOSAL_BALLOTS_PAGE } from '@poa-box/core/graph/documents/voting-classes';
      import { deriveDirectDemocracyAuthorization, type DirectDemocracyAuthorizationInput } from '@poa-box/core/governance/dd-authorization';
      import { buildDonateToSolidarity, type DonateToSolidarityArgs } from '@poa-box/core/tx/paymaster';
      import { encodeIntent } from '@poa-box/core/tx/intent';
      import type { Fact, SourceSnapshot } from '@poa-box/core/data/facts';
      import type { IndexedRow } from '@poa-box/core/reads/protocol';
      declare const options: ProposalBallotOptions;
      const ballots: Promise<SourceSnapshot<readonly IndexedRow[]>> = readProposalBallotFacts(options);
      const documents: readonly string[] = [FETCH_AUTHORITY_MEMBERSHIP_EVENTS_RECENT, FETCH_AUTHORITY_CONFIG_LINTS_RECENT,
        FETCH_HYBRID_PROPOSAL_BALLOTS_PAGE, FETCH_DD_PROPOSAL_BALLOTS_PAGE];
      declare const policy: DirectDemocracyAuthorizationInput;
      const authorization: Fact<boolean> = deriveDirectDemocracyAuthorization(policy);
      const donation: DonateToSolidarityArgs = { paymasterHubAddress: '0x1111111111111111111111111111111111111111', amountWei: 1n };
      const value: string = encodeIntent(buildDonateToSolidarity(donation)).value;
      // @ts-expect-error cursor reader requires explicit bounds
      const unbounded: ProposalBallotOptions = { source: options.source, query: options.query, lane: 'dd', proposalId: '1' };
      // @ts-expect-error proposal ID is never a rounded Number
      readProposalBallotFacts({ ...options, proposalId: 9007199254740992 });
    `;
    const options: ts.CompilerOptions = { strict: true, skipLibCheck: false, noEmit: true, esModuleInterop: true,
      target: ts.ScriptTarget.ES2022, module, moduleResolution, types: ['node'] };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.getSourceFile = (path, version, onError, fresh) => path === file ? ts.createSourceFile(path, consumer, version, true) : original(path, version, onError, fresh);
    const program = ts.createProgram([file], options, host);
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  });

  it.each([
    ['classic', ts.ModuleKind.CommonJS, ts.ModuleResolutionKind.NodeJs],
    ['Node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16],
  ] as const)('recorded-inflow public types compile strictly under %s and preserve legacy inputs', (_name, module, moduleResolution) => {
    const file = resolve(DIST, '../test/__recorded_inflows_type_regression__.ts');
    const consumer = `
      import { readHistoricalPotFacts, normalizeRecordedInflows, type HistoricalPot,
        type HistoricalPaymasterHubPot, type RecordedInflows } from '@poa-box/core/treasury/inflows';
      import { readHistoricalPaymasterHubPotFacts, readIndexedNativeInflowFacts,
        normalizeIndexedRecordedInflows, type InflowPageOptions, type HistoricalInflowPotFacts,
        type IndexedNativeInflowEvent, type IndexedRecordedInflows } from '@poa-box/core/treasury/indexed-inflows';
      import type { SourceSnapshot } from '@poa-box/core/data/facts';
      import type { InflowEventChunk } from '@poa-box/core/treasury/inflows';
      declare const options: InflowPageOptions;
      declare const legacy: SourceSnapshot<readonly HistoricalPot[]>;
      declare const chunks: readonly SourceSnapshot<InflowEventChunk>[];
      async function example() {
        const pots: HistoricalInflowPotFacts = { ...await readHistoricalPotFacts(options),
          'paymaster-hub': await readHistoricalPaymasterHubPotFacts(options) };
        const collections = ['payments', 'paymasterDepositEvents', 'solidarityEvents'] as const;
        const streams = await Promise.all(collections.map(collection =>
          readIndexedNativeInflowFacts({ ...options, collection, fromBlock: '1' })));
        const recorded: IndexedRecordedInflows = normalizeIndexedRecordedInflows({ pots, streams, chunks,
          fromBlock: '1', block: options.source.block!,
          nativeAsset: { chainId: options.source.chainId, address: '0x0000000000000000000000000000000000000000', decimals: 18 } });
        const old: RecordedInflows = normalizeRecordedInflows({ pots: legacy, chunks, fromBlock: '1', block: options.source.block! });
        return [recorded, old];
      }
      declare const hub: HistoricalPaymasterHubPot;
      // @ts-expect-error global hubs have no organization
      const fakeOrg: HistoricalPaymasterHubPot = { ...hub, orgId: 'fake' };
      declare const event: IndexedNativeInflowEvent;
      // @ts-expect-error opaque entity rows have no logIndex
      const fakeIndex = event.logIndex;
      // @ts-expect-error new readers require explicit page bounds
      const noBounds: InflowPageOptions = { source: options.source, query: options.query };
    `;
    const options: ts.CompilerOptions = { strict: true, skipLibCheck: false, noEmit: true, esModuleInterop: true,
      target: ts.ScriptTarget.ES2022, module, moduleResolution, types: ['node'] };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.getSourceFile = (path, version, onError, fresh) => path === file ? ts.createSourceFile(path, consumer, version, true) : original(path, version, onError, fresh);
    const program = ts.createProgram([file], options, host);
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  });
});
