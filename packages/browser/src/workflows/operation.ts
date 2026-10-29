import { ethers } from 'ethers';
import { encodeIntent } from '@poa-box/core/tx/intent';
import { cidV0ToBytes32 } from '@poa-box/core/encoding/cid';
import { createSubmissionRecovery, normalizeSubmissionRecovery, reconcileSubmissionRecovery,
  submissionIntentKey, transitionSubmissionRecovery } from '@poa-box/core/execute/recovery';
import type { RecoveryReceipt, SubmissionRecoveryRecord } from '@poa-box/core/execute/recovery';
import type { WorkflowHost, EvidenceReader, OperationDefinition, OperationWorkflow, OperationPlan,
  WorkflowReview, WorkflowPreparation, WorkflowResult, WorkflowJournalStage, PublishedWorkflowDocument,
  WorkflowDocument, WorkflowApproval } from './types';
import { allowed, copy, digest, freeze, known, moduleScope, nonzero, refuse, snapshot } from './shared';
import type { UnsignedCall } from '../wallet';
import { isolateSubmissionReceipt, preparedSubmissionEvent, recoveryCandidateOptions, submissionAcknowledgement } from './transport';

interface Publication extends WorkflowDocument { status: 'submitting' | 'unknown' | 'published' | 'not-published'; cid?: string }
interface Row { version: 1; workflowId: string; operation: string; scopeKey: string; reviewRevision: number;
  nextAttempt: number; publications: Publication[]; stages: Record<string, WorkflowJournalStage>; history?: WorkflowJournalStage[] }
interface Database { workflows: Record<string, Row> }
interface Context { get(): Row; save(value: Row): Promise<void>; barrier(): void; assertActive(): void; isCurrent(): boolean }
const terminal = new Set(['succeeded', 'failed', 'replaced', 'aborted']);
const notSent = (stage: WorkflowJournalStage) => stage.notDispatched?.code === 'WALLET_REFUSED_BEFORE_HANDOFF'
  && stage.notDispatched.attemptId === stage.attemptId && stage.attemptId === stage.submission?.attemptId
  && ['prepared', 'submitting'].includes(stage.submission.phase);
const result = <T>(status: WorkflowResult<T>['status'], data?: T, codes?: readonly string[]): WorkflowResult<T> =>
  ({ status, ...(data === undefined ? {} : { data }), ...(codes ? { codes } : {}) });

/** Shared single-operation lifecycle. Signing/publication/transport are injected;
 * built-in definitions own protocol authorization, not this storage engine. */
export function createOperationWorkflow<R, E, S>(host: WorkflowHost, reader: EvidenceReader<R, E>, definition: OperationDefinition<R, E, S>): OperationWorkflow<R, S> {
  if (!/^[\w-]{1,64}$/.test(host.workflowId) || ['__proto__', 'constructor', 'prototype'].includes(host.workflowId)) throw new Error('WORKFLOW_ID_REQUIRED');
  if (!host.wallet?.getIdentity || !host.journal?.withAccountLock || !host.confirm || !host.isCurrent || !host.simulate) throw new Error('EXPLICIT_HOST_PORTS_REQUIRED');
  const scope = freeze(copy(host.scope)), sources = { ...host.sources }, workflowId = host.workflowId;
  if (!Number.isSafeInteger(scope.chainId) || scope.chainId <= 0 || !scope.orgId || !sources.rpcEndpoint || !sources.indexedEndpoint) throw new Error('WORKFLOW_SCOPE_REQUIRED');
  const account = freeze({ chainId: scope.chainId, accountAddress: nonzero(scope.account).toLowerCase() });
  Object.values(scope.contracts).forEach(nonzero);
  const scopeKey = digest([scope, sources.rpcEndpoint, sources.indexedEndpoint]);
  const reviews = new WeakMap<object, { revision: number; request: Readonly<R>; plan: OperationPlan<S>; binding: string }>();
  const preparations = new WeakMap<object, { revision: number; attemptId: string; request: Readonly<R>; binding: string }>();
  const active = (signal?: AbortSignal, context?: Context) => { context?.assertActive(); if (signal?.aborted) refuse('WORKFLOW_CANCELLED'); if (host.isCurrent() !== true) refuse('WORKFLOW_SCOPE_CHANGED'); };
  const identity = async (signal?: AbortSignal, context?: Context) => { active(signal, context); const actual = await host.wallet.getIdentity({ signal }); active(signal, context);
    if (actual.chainId !== account.chainId || actual.accountAddress?.toLowerCase() !== account.accountAddress) refuse('WALLET_IDENTITY_CHANGED'); };
  const safe = <T, A extends unknown[]>(action: (...args: A) => Promise<WorkflowResult<T>>) => async (...args: A): Promise<WorkflowResult<T>> => {
    try { return await action(...args); } catch (error) {
      const e = error as Error & { workflowState?: 'blocked' | 'unknown'; dispatched?: boolean };
      return result<T>(e.workflowState ?? (e.dispatched === false || e.name === 'AbortError' ? 'blocked' : 'unknown'), undefined,
        [/^[A-Z][A-Z_0-9]+$/.test(e.message) ? e.message : 'HOST_OPERATION_UNAVAILABLE']);
    }
  };
  const locked = <T>(action: (context: Context) => Promise<T>): Promise<T> => host.journal.withAccountLock(account, async session => {
    const assertActive = () => session.assertActive?.();
    const isCurrent = () => { try { assertActive(); return host.isCurrent() === true; } catch { return false; } };
    assertActive(); let envelope = await session.read(); assertActive();
    let database = (envelope?.data ?? { workflows: {} }) as Database;
    if (!database.workflows || typeof database.workflows !== 'object' || Array.isArray(database.workflows)) refuse('INVALID_WORKFLOW_JOURNAL');
    let row: Row = Object.hasOwn(database.workflows, workflowId) ? database.workflows[workflowId] : {
      version: 1, workflowId, operation: definition.name, scopeKey, reviewRevision: 0, nextAttempt: 0, publications: [], stages: {},
    };
    if (row.scopeKey !== scopeKey || row.workflowId !== workflowId || row.operation !== definition.name) refuse('WORKFLOW_SCOPE_MISMATCH');
    const save = async (value: Row) => {
      assertActive();
      envelope = await session.compareAndSwap(envelope, copy({ ...database, workflows: { ...database.workflows, [workflowId]: value } }));
      assertActive();
      database = envelope.data as Database; row = database.workflows[workflowId];
    };
    const barrier = () => {
      assertActive();
      for (const workflow of Object.values(database.workflows)) for (const stage of [...Object.values(workflow.stages ?? {}), ...(workflow.history ?? [])]) {
        if (stage.submission && !notSent(stage) && !terminal.has(normalizeSubmissionRecovery(stage.submission).phase)) refuse('ACCOUNT_RECOVERY_REQUIRED');
      }
      if (row.publications.some(p => ['submitting', 'unknown'].includes(p.status))) refuse('PUBLICATION_RECOVERY_REQUIRED');
    };
    return action({ get: () => { assertActive(); return row; }, save, barrier, assertActive, isCurrent });
  });
  const observe = async (request: Readonly<R>, signal?: AbortSignal, context?: Context) => {
    active(signal, context); const evidence = await reader.read(request, { scope, signal }); active(signal, context);
    const plan = definition.evaluate(request, evidence); active(signal, context); return { evidence, plan, binding: digest(plan.binding) };
  };
  const approve = async (approval: Omit<WorkflowApproval, 'scope' | 'workflowId'>, signal?: AbortSignal, context?: Context) => {
    active(signal, context); const accepted = await host.confirm(freeze({ ...approval, workflowId, scope }), { signal }); active(signal, context);
    if (accepted !== true) refuse('APPROVAL_DECLINED');
  };
  const revalidate = async (request: Readonly<R>, binding: string, signal?: AbortSignal, context?: Context) => {
    await identity(signal, context); const fresh = await observe(request, signal, context);
    if (fresh.binding !== binding) refuse('REVIEW_NO_LONGER_CURRENT'); return fresh;
  };
  const simulate = async (call: Readonly<UnsignedCall>, signal?: AbortSignal, context?: Context) => {
    active(signal, context); const evidence = await host.simulate(call, { scope, signal }); active(signal, context);
    const check = () => {
      const expected = moduleScope(scope, call.to, true), data = snapshot(evidence, expected, sources, false);
      if (data.callKey !== submissionIntentKey([call])) refuse('SIMULATION_CALL_MISMATCH', 'unknown');
      allowed({ state: 'known', value: known(data.succeeds, evidence, expected) });
    };
    check(); return check;
  };
  async function publish(context: Context, document: WorkflowDocument, request: Readonly<R>, summary: S, binding: string, signal?: AbortSignal): Promise<PublishedWorkflowDocument> {
    if (document.digest !== ethers.utils.id(document.json)) refuse('PUBLICATION_BYTES_MISMATCH');
    const previous = context.get().publications.find(p => p.key === document.key && p.digest === document.digest);
    if (previous?.status === 'published') return { key: previous.key, digest: previous.digest, cid: previous.cid! };
    if (previous && previous.status !== 'not-published') refuse('PUBLICATION_RECOVERY_REQUIRED');
    if (!host.documents?.publish) refuse('DOCUMENT_PUBLISHER_REQUIRED');
    await approve({ kind: 'publish', request, summary, documents: [document] }, signal, context);
    const row: Publication = { ...document, status: 'submitting' };
    await context.save({ ...context.get(), publications: [...context.get().publications.filter(p => !(p.key === row.key && p.digest === row.digest)), row] });
    let invoked = false;
    try {
      await revalidate(request, binding, signal, context); active(signal, context); invoked = true;
      const receipt = await host.documents.publish(freeze(copy(document)), { signal }); cidV0ToBytes32(receipt.cid);
      await context.save({ ...context.get(), publications: context.get().publications.map(p => p.key === row.key && p.digest === row.digest ? { ...p, status: 'published', cid: receipt.cid } : p) });
      active(signal, context); return { key: document.key, digest: document.digest, cid: receipt.cid };
    } catch (error) {
      try { await context.save({ ...context.get(), publications: context.get().publications.map(p => p.key === row.key && p.digest === row.digest && p.status !== 'published'
        ? { ...p, status: invoked ? 'unknown' : 'not-published' } : p) }); } catch { /* The durable submitting marker prevents retry. */ }
      throw error;
    }
  }
  const recover = safe(async ({ signal, candidateTxHash, candidateUserOpHash, publicationReceipts = [] }: { signal?: AbortSignal; candidateTxHash?: string; candidateUserOpHash?: string; publicationReceipts?: readonly PublishedWorkflowDocument[] } = {}) => {
    active(signal); return locked(async context => {
      if (!Array.isArray(publicationReceipts) || publicationReceipts.length > 8) refuse('INVALID_PUBLICATION_RECOVERY_BOUND');
      for (const receipt of publicationReceipts) {
        const saved = context.get().publications.find(p => p.key === receipt.key && p.digest === receipt.digest && p.status !== 'published');
        if (!saved || !host.documents?.fetch) refuse('PUBLICATION_PROOF_REQUIRED');
        cidV0ToBytes32(receipt.cid); const content = await host.documents.fetch(receipt.cid, { signal }); active(signal, context);
        if (JSON.stringify(content) !== saved.json) refuse('PUBLICATION_BYTES_MISMATCH');
        await context.save({ ...context.get(), publications: context.get().publications.map(p => p === saved ? { ...p, status: 'published', cid: receipt.cid } : p) });
      }
      if (context.get().publications.some(p => ['submitting', 'unknown'].includes(p.status))) return result('unknown', { next: 'supply-publication-receipt' }, ['PUBLICATION_OUTCOME_UNKNOWN']);
      let stage = context.get().stages.operation;
      if (!stage?.submission) return result('ready', copy(context.get()));
      if (notSent(stage)) return result('blocked', { next: 'review' }, ['SUBMISSION_NOT_DISPATCHED']);
      let record = normalizeSubmissionRecovery(stage.submission);
      let receipt: RecoveryReceipt | undefined;
      if (!terminal.has(record.phase) || record.phase === 'succeeded') {
        // Reconcile even saved success: canonical inclusion may have changed.
        const candidate = record.phase === 'succeeded' ? { ...record, phase: 'submitted' as const } : record;
        const recovered = await reconcileSubmissionRecovery(candidate, host.wallet.recoveryReaders, recoveryCandidateOptions(record, candidateTxHash, candidateUserOpHash)); active(signal, context);
        if (recovered.outcome.status === 'unknown') return result('unknown', { submission: record, next: 'recover' }, [recovered.outcome.code ?? 'SUBMISSION_OUTCOME_UNKNOWN']);
        if (record.phase === 'succeeded' && recovered.outcome.status !== 'succeeded')
          return result('blocked', { submission: record, next: 'recover' }, ['CANONICAL_TRANSACTION_NO_LONGER_SUCCEEDED']);
        if (!terminal.has(record.phase)) {
          record = normalizeSubmissionRecovery({ ...record, ...(recovered.outcome.txHash ? { txHash: recovered.outcome.txHash } : {}) });
          record = transitionSubmissionRecovery(record, record, { type: 'settle', status: recovered.outcome.status });
          stage = { ...stage, submission: record }; await context.save({ ...context.get(), stages: { operation: stage } });
        }
        receipt = recovered.receipt;
      }
      if (record.phase !== 'succeeded') return result('blocked', { submission: record }, [`SUBMISSION_${record.phase.toUpperCase()}`]);
      if (!receipt) return result('unknown', { next: 'recover' }, ['DOMAIN_RECEIPT_REQUIRED']);
      receipt = await isolateSubmissionReceipt(record, receipt, host.wallet.recoveryReaders, stage.callKey, stage.callValue);
      active(signal, context);
      return definition.outcome(freeze(copy(stage.request)) as Readonly<R>, receipt, stage.documents ?? []);
    });
  });
  return {
    inspect: safe(async () => locked(async context => result('ready', copy(context.get())))),
    review: safe(async (inputRequest: R, { signal }: { signal?: AbortSignal } = {}) => {
      const request = freeze(copy(inputRequest)); await identity(signal);
      return locked(async context => {
        context.barrier(); const previous = context.get(), earlier = previous.stages.operation;
        if (earlier?.submission && earlier.submission.phase === 'succeeded') refuse('OPERATION_ALREADY_CONFIRMED');
        const current = await observe(request, signal, context);
        const revision = previous.reviewRevision + 1;
        await context.save({ ...previous, reviewRevision: revision, stages: {}, ...(earlier ? { history: [...(previous.history ?? []), earlier] } : {}) });
        const review = freeze({ kind: 'operation-review' as const, operation: definition.name, request,
          summary: copy(current.plan.summary), documents: copy(current.plan.documents ?? []), fingerprint: digest([request, current.plan]) });
        reviews.set(review, { revision, request, plan: copy(current.plan), binding: current.binding });
        return result('ready', review);
      });
    }),
    prepare: safe(async ({ review, signal }: { review: WorkflowReview<R, S>; signal?: AbortSignal }) => {
      const selected = reviews.get(review); if (!selected) refuse('CURRENT_REVIEW_REQUIRED'); await identity(signal);
      return locked(async context => {
        context.barrier(); if (context.get().reviewRevision !== selected.revision || context.get().stages.operation) refuse('CURRENT_REVIEW_REQUIRED');
        let current = await revalidate(selected.request, selected.binding, signal, context);
        const documents: PublishedWorkflowDocument[] = [];
        for (const document of selected.plan.documents ?? []) documents.push(await publish(context, document, selected.request, selected.plan.summary, selected.binding, signal));
        current = await revalidate(selected.request, selected.binding, signal, context);
        const intent = await definition.build(selected.request, current.evidence, documents,
          async () => { await approve({ kind: 'sign-registration', request: selected.request, summary: selected.plan.summary }, signal, context); await revalidate(selected.request, selected.binding, signal, context); }, signal, context.isCurrent);
        await revalidate(selected.request, selected.binding, signal, context);
        const encoded = encodeIntent(intent), call = freeze({ ...encoded, value: String(encoded.value ?? '0') });
        await simulate(call, signal, context);
        const row = context.get(), nextAttempt = row.nextAttempt + 1, attemptId = `${workflowId}-${nextAttempt}`;
        // Persist only unsigned review inputs and a call digest. Enrollment
        // calldata may contain signatures/assertions and is never journaled.
        await context.save({ ...row, nextAttempt, stages: { operation: { attemptId, request: definition.journalRequest?.(selected.request) ?? selected.request,
          summary: selected.plan.summary, callKey: submissionIntentKey([call]), callValue: call.value, documents } } });
        const prepared = freeze({ kind: 'prepared-operation' as const, operation: definition.name, request: selected.request,
          summary: copy(selected.plan.summary), call, documents });
        preparations.set(prepared, { revision: selected.revision, attemptId, request: selected.request, binding: selected.binding });
        return result('ready', prepared);
      });
    }),
    submit: safe(async ({ prepared, signal }: { prepared: WorkflowPreparation<R, S>; signal?: AbortSignal }) => {
      const selected = preparations.get(prepared); if (!selected) refuse('CURRENT_PREPARATION_REQUIRED'); await identity(signal);
      return locked(async context => {
        context.barrier(); let stage = context.get().stages.operation;
        if (context.get().reviewRevision !== selected.revision || stage?.attemptId !== selected.attemptId || stage.callKey !== submissionIntentKey([prepared.call])) refuse('CURRENT_PREPARATION_REQUIRED');
        if (stage.submission) refuse('OPERATION_ALREADY_SUBMITTED');
        const dispatch = await host.wallet.prepare({ scope: account, call: prepared.call, signal, isCurrent: context.isCurrent }); active(signal, context);
        const event = preparedSubmissionEvent(dispatch, stage.callKey);
        if (dispatch.kind === 'user-operation' && (!host.wallet.recoveryReaders.getUserOperationReceipt || !host.wallet.recoveryReaders.getTransaction))
          refuse('USER_OPERATION_RECEIPT_READERS_REQUIRED');
        await approve({ kind: 'send', request: selected.request, summary: prepared.summary, call: prepared.call, nonce: dispatch.nonce, fromBlock: dispatch.fromBlock }, signal, context);
        const saveRecord = async (record: SubmissionRecoveryRecord) => { stage = { ...context.get().stages.operation, submission: record }; await context.save({ ...context.get(), stages: { operation: stage } }); };
        try {
          let called = false;
          const receipt = await host.wallet.send(dispatch, { signal, isCurrent: context.isCurrent,
            beforeSign: async () => {
              const checkSimulationFreshness = await simulate(prepared.call, signal, context);
              await revalidate(selected.request, selected.binding, signal, context); checkSimulationFreshness(); active(signal, context);
            },
            beforeSend: async () => {
            if (called) refuse('SUBMISSION_ALREADY_PREPARED'); called = true;
            await revalidate(selected.request, selected.binding, signal, context);
            let record = createSubmissionRecovery({ ...account, intentKey: stage.callKey, sessionKey: digest(workflowId), contextKey: scopeKey }, `${workflowId}-host`, selected.attemptId);
            record = transitionSubmissionRecovery(record, record, event);
            await saveRecord(record); active(signal, context);
            record = transitionSubmissionRecovery(record, record, { type: 'broadcast' }); await saveRecord(record);
            // Async durable writes and wallet setup cannot consume the freshness
            // window: this check is the last awaited step before handoff.
            const checkSimulationFreshness = await simulate(prepared.call, signal, context);
            await revalidate(selected.request, selected.binding, signal, context); checkSimulationFreshness(); active(signal, context);
          } });
          if (!called || !stage.submission) refuse('WALLET_FINAL_REVIEW_BYPASSED', 'unknown');
          const acknowledgement = submissionAcknowledgement(dispatch, receipt);
          await saveRecord(transitionSubmissionRecovery(stage.submission, stage.submission, acknowledgement.event));
          return result('pending', { ...acknowledgement.identity, submission: stage.submission, next: 'recover' });
        } catch (error) {
          const e = error as { dispatched?: boolean };
          stage = context.get().stages.operation;
          if (stage?.submission && e.dispatched === false) {
            try { await context.save({ ...context.get(), stages: { operation: { ...stage, notDispatched: { attemptId: selected.attemptId, code: 'WALLET_REFUSED_BEFORE_HANDOFF' } } } });
              return result('blocked', { next: 'review' }, ['SUBMISSION_NOT_DISPATCHED']);
            } catch { return result('unknown', { next: 'recover' }, ['JOURNAL_OUTCOME_UNKNOWN']); }
          }
          if (stage?.submission) {
            try { await saveRecord(transitionSubmissionRecovery(stage.submission, stage.submission, { type: 'unresolved' })); } catch { /* Durable barrier remains. */ }
            return result('unknown', { submission: stage.submission, next: 'recover' }, ['SUBMISSION_OUTCOME_UNKNOWN']);
          }
          throw error;
        }
      });
    }),
    status: recover, recover,
  };
}
