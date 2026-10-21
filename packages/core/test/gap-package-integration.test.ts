import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { resolve } from 'path';
import * as root from '../src/index';
import * as reads from '../src/reads';
import * as recovery from '../src/execute/recovery';
import * as cashout from '../src/integrations/cashout';

describe('gap APIs retain their public import routes', () => {
  it('exports pure recovery and indexed/provenance APIs without aggregating external cashout', () => {
    expect(root.submissionRecovery.reconcileSubmissionRecovery).toBe(recovery.reconcileSubmissionRecovery);
    expect(root.reads.memberTotals.readCurrentMemberTotals).toBe(reads.memberTotals.readCurrentMemberTotals);
    expect(root.reads.token.readTokenHolderTotals).toBeTypeOf('function');
    expect(root.reads.education.readEducationCompletionTotals).toBeTypeOf('function');
    expect(reads.readCanonicalTransaction).toBeTypeOf('function');
    expect(root.governance.readSubjectCreationProvenance).toBeTypeOf('function');
    expect(root.email.migratePendingEmailCredential).toBeTypeOf('function');
    expect(root.documents.indexedCompletenessDocuments.FETCH_CURRENT_MEMBER_TOTAL_PAGE).toBeTypeOf('string');
    expect(cashout.readCashoutDiscovery).toBeTypeOf('function');
    expect(root).not.toHaveProperty('readCashoutDiscovery');
    expect(root).not.toHaveProperty('integrations');
  });

  it.each([
    ['classic', ts.ModuleKind.CommonJS, ts.ModuleResolutionKind.NodeJs],
    ['Node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16],
    ['bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ] as const)('compiles built public declarations with strict library checking under %s', (_name, module, moduleResolution) => {
    const file = resolve(__dirname, '__gap_public_consumer__.ts');
    const source = `
      import * as core from '@poa-box/core';
      import { type IndexedTotalOptions } from '@poa-box/core/data';
      import { readCurrentMemberTotals } from '@poa-box/core/reads/member-totals';
      import { readTokenHolderTotals } from '@poa-box/core/reads/token';
      import { listAllCompletionsComplete, readEducationCompletionTotals } from '@poa-box/core/reads/education';
      import { readCashoutDiscovery } from '@poa-box/core/integrations';
      import { readCashoutDiscovery as leafCashout } from '@poa-box/core/integrations/cashout';
      import { readCanonicalTransaction, type ProvenanceProvider } from '@poa-box/core/reads';
      import { readSubjectCreationProvenance, recoverSubjectCreationHistory } from '@poa-box/core/governance';
      import { readPendingEmailRecovery, migratePendingEmailCredential, pendingEmailRestartGuidance } from '@poa-box/core/email';
      import { reconcileSubmissionRecovery, type SubmissionRecoveryRecord, type SubmissionRecoveryReaders,
        type SubmissionRecoveryOptions, type RecoveryReceipt } from '@poa-box/core/execute/recovery';
      import { FETCH_ALL_COMPLETIONS_PAGE } from '@poa-box/core/graph/documents/indexed-completeness';
      const member: typeof readCurrentMemberTotals = core.reads.memberTotals.readCurrentMemberTotals;
      const holder: typeof readTokenHolderTotals = core.reads.token.readTokenHolderTotals;
      const education: typeof readEducationCompletionTotals = core.reads.education.readEducationCompletionTotals;
      const pages: typeof listAllCompletionsComplete = core.reads.education.listAllCompletionsComplete;
      const canonical: typeof readCanonicalTransaction = core.reads.readCanonicalTransaction;
      const historical: typeof readSubjectCreationProvenance = core.governance.readSubjectCreationProvenance;
      const recovered: typeof recoverSubjectCreationHistory = core.governance.recoverSubjectCreationHistory;
      const email: typeof readPendingEmailRecovery = core.email.readPendingEmailRecovery;
      const migrate: typeof migratePendingEmailCredential = core.email.migratePendingEmailCredential;
      const restart: typeof pendingEmailRestartGuidance = core.email.pendingEmailRestartGuidance;
      const reconcile: typeof reconcileSubmissionRecovery = core.submissionRecovery.reconcileSubmissionRecovery;
      const external: typeof leafCashout = readCashoutDiscovery;
      const document: string = FETCH_ALL_COMPLETIONS_PAGE;
      declare const options: IndexedTotalOptions;
      const rootOptions: core.IndexedTotalOptions = options;
      member(options); holder(options); education(options); pages(options);
      // @ts-expect-error page bounds must be explicit
      const unbounded: IndexedTotalOptions = { source: options.source, query: options.query };
      declare const record: SubmissionRecoveryRecord;
      declare const readers: SubmissionRecoveryReaders;
      const recoveryOptions: SubmissionRecoveryOptions = { maxBlocks: 16, candidateTxHash: '0x00' };
      reconcile(record, readers, recoveryOptions);
      const receipt: RecoveryReceipt = { status: 1, blockNumber: 1n, blockHash: '0x00' };
      // @ts-expect-error external relay integration is intentionally not aggregated into root
      core.readCashoutDiscovery;
    `;
    const options: ts.CompilerOptions = { strict: true, skipLibCheck: false, noEmit: true, esModuleInterop: true,
      target: ts.ScriptTarget.ES2022, module, moduleResolution, types: ['node'] };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.getSourceFile = (path, version, onError, fresh) => path === file ? ts.createSourceFile(path, source, version, true) : original(path, version, onError, fresh);
    const program = ts.createProgram([file], options, host);
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  });
});
