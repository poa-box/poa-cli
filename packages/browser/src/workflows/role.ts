import type { RoleOperationScope, RoleOperationSources, RoleOperationRequest, RoleOperationReview, RoleOperationEvidence, RoleOperationStatus } from '@poa-box/core/governance/role-operation-types';
import type { TxIntent } from '@poa-box/core/tx/intent';
import type { ExecutionCall } from '@poa-box/core/tx/governance';
import type { BrowserJournal } from '../storage';
import type { AccountTransport } from '../wallet';
import type { WorkflowResult } from './types';

export interface RoleWorkflowOptions {
  workflowId: string; scope: RoleOperationScope; sources: RoleOperationSources;
  wallet: AccountTransport; journal: BrowserJournal<unknown>; isCurrent(): boolean;
  documents?: {
    fetch?(cid: string, options: { signal?: AbortSignal }): Promise<unknown | null>;
    publish?(document: Readonly<{ key: string; json: string; digest: string }>, options: { signal?: AbortSignal }): Promise<{ cid: string }>;
  };
  confirm(approval: Readonly<{ workflowId: string; scope: RoleOperationScope; kind: 'publish' | 'send'; stage: 'creation' | 'configuration'; [key: string]: unknown }>, options: { signal?: AbortSignal }): Promise<boolean>;
}
export interface RoleWorkflowPreparation {
  readonly kind: 'prepared-role-workflow'; readonly workflowId: string; readonly stage: 'creation' | 'configuration';
  readonly intent: TxIntent; readonly batch: readonly ExecutionCall[]; readonly requiresConfiguration: boolean;
  readonly documents: readonly { key: string; digest: string; cid: string }[];
}
export interface RoleWorkflow {
  capabilities(request: RoleOperationRequest, options?: { signal?: AbortSignal }): Promise<WorkflowResult<RoleOperationEvidence>>;
  inspect(): Promise<WorkflowResult>;
  review(request: RoleOperationRequest, options?: { signal?: AbortSignal }): Promise<WorkflowResult<RoleOperationReview>>;
  prepare(input: { review: RoleOperationReview; proposal: { title: string; description: string; durationMinutes: string | number }; signal?: AbortSignal }): Promise<WorkflowResult<RoleWorkflowPreparation>>;
  submit(input: { prepared: RoleWorkflowPreparation; signal?: AbortSignal }): Promise<WorkflowResult>;
  recover(options?: { signal?: AbortSignal; candidateTxHash?: string; candidateUserOpHash?: string; publicationReceipts?: readonly { key: string; digest: string; cid: string }[]; abandonPrepared?: boolean }): Promise<WorkflowResult<RoleOperationStatus & { requiresConfiguration: boolean; complete: boolean }>>;
  status(options?: { signal?: AbortSignal; candidateTxHash?: string; candidateUserOpHash?: string }): Promise<WorkflowResult<RoleOperationStatus & { requiresConfiguration: boolean; complete: boolean }>>;
  continuation(options?: { signal?: AbortSignal }): Promise<WorkflowResult<{ creation: RoleOperationStatus['creation']; request?: RoleOperationRequest; complete?: boolean }>>;
}
/** Promoted verbatim host lifecycle from the independently tested role consumer.
 * Protocol review, preparation, and separate creation/configuration proof remain
 * in core. Browser ports add durable consent, exact dispatch and recovery. */
export function createRoleWorkflow(options: RoleWorkflowOptions): RoleWorkflow {
  const workflow = createRoleWorkflowImplementation(options);
  return { ...workflow, status: workflow.recover } as RoleWorkflow;
}
const values = (value: any): any[] => Object.values(value);
/** Copyable host controller. Core owns protocol decisions; injected ports own
 * identity, consent, documents, durable storage/locking and wallet transport. */
import { ethers } from 'ethers';
import { readRoleOperationEvidence, reviewRoleOperation, prepareRoleOperation, revalidatePreparedRoleOperation, readRoleOperationStatus } from '@poa-box/core/governance/role-operations';
import { buildProposalMetadata, serializeProposalMetadata } from '@poa-box/core/metadata/proposal';
import { buildGovernanceProposal } from '@poa-box/core/tx/governance';
import { encodeIntent } from '@poa-box/core/tx/intent';
import { cidV0ToBytes32 } from '@poa-box/core/encoding/cid';
import { createSubmissionRecovery, transitionSubmissionRecovery, normalizeSubmissionRecovery, reconcileSubmissionRecovery, submissionIntentKey, canAbandonSubmissionRecovery } from '@poa-box/core/execute/recovery';
import { exactSubmissionOperation, preparedSubmissionEvent, recoveryCandidateOptions, submissionAcknowledgement } from './transport';
const terminal = new Set(['succeeded', 'failed', 'replaced', 'aborted']);
const notSent = (stage: any) => stage?.notDispatched?.code === 'WALLET_REFUSED_BEFORE_HANDOFF'
    && stage.notDispatched.attemptId === stage.attemptId && stage.attemptId === stage.submission?.attemptId
    && ['prepared', 'submitting'].includes(stage.submission.phase);
const copy = (value: any) => JSON.parse(JSON.stringify(value));
const intentData = (value: any): any => ethers.BigNumber.isBigNumber(value) ? value.toString() : ArrayBuffer.isView(value) ? ethers.utils.hexlify(value as Uint8Array)
    : Array.isArray(value) ? value.map(intentData) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([name, item]: any) => [name, intentData(item)])) : value;
function freeze(value: any) { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    values(value).forEach(freeze);
    Object.freeze(value);
} return value; }
function canonical(value: any): any {
    return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().filter((key: any) => value[key] !== undefined).map((key: any) => [key, canonical(value[key])])) : value;
}
const key = (value: any) => ethers.utils.id(JSON.stringify(canonical(value)));
function refuse(code: any): never { throw Object.assign(new Error(code), { workflowRefusal: true }); }
const result = (status: any, data?: any, codes?: any) => ({ status, ...(data === undefined ? {} : { data }), ...(codes ? { codes } : {}) });
function failure(error: any) {
    return result(error?.workflowRefusal || error?.dispatched === false || error?.name === 'AbortError' ? 'blocked' : 'unknown', undefined, [error?.name === 'AbortError' ? 'WORKFLOW_CANCELLED' : /^[A-Z][A-Z_0-9]+$/.test(error?.message ?? '') ? error.message : 'HOST_OPERATION_UNAVAILABLE']);
}
function createRoleWorkflowImplementation({ workflowId, scope: inputScope, sources: inputSources, wallet, journal, documents = {}, confirm, isCurrent }: any) {
    if (!/^[\w-]{1,64}$/.test(workflowId ?? '') || ['__proto__', 'constructor', 'prototype'].includes(workflowId))
        throw new Error('WORKFLOW_ID_REQUIRED');
    if (!journal?.withAccountLock || !wallet?.getIdentity || typeof isCurrent !== 'function')
        throw new Error('EXPLICIT_HOST_PORTS_REQUIRED');
    const sources = { indexed: { ...inputSources.indexed }, rpc: { ...inputSources.rpc }, now: inputSources.now };
    const scope = freeze(copy(inputScope)), account = { chainId: scope.chainId, accountAddress: scope.account.toLowerCase() };
    const scopeKey = key([scope, sources.indexed.endpoint, sources.rpc.endpoint]);
    const reviews = new WeakMap(), preparations = new WeakMap();
    const active = (signal: any, context?: any) => { context?.assertActive(); if (signal?.aborted) {
        const error = new Error('WORKFLOW_CANCELLED');
        error.name = 'AbortError';
        throw error;
    } if (isCurrent() !== true)
        refuse('WORKFLOW_SCOPE_CHANGED'); };
    const identity = async (signal: any, context?: any) => {
        active(signal, context);
        const actual = await wallet.getIdentity({ signal });
        active(signal, context);
        if (actual.chainId !== account.chainId || actual.accountAddress?.toLowerCase() !== account.accountAddress)
            refuse('WALLET_IDENTITY_CHANGED');
    };
    const safe = (operation: any) => async (...args: any) => { try {
        return await operation(...args);
    }
    catch (error: any) {
        return failure(error);
    } };
    const locked = (action: any) => journal.withAccountLock(account, async (session: any) => {
        const assertActive = () => session.assertActive?.();
        const current = () => { try { assertActive(); return isCurrent() === true; } catch { return false; } };
        assertActive();
        let envelope = await session.read(), database = envelope?.data ?? { workflows: {} };
        assertActive();
        if (!database.workflows || typeof database.workflows !== 'object' || Array.isArray(database.workflows))
            refuse('INVALID_WORKFLOW_JOURNAL');
        let workflow = Object.hasOwn(database.workflows, workflowId) ? database.workflows[workflowId] : {
            version: 1, workflowId, scopeKey, scope, reviewRevision: 0, nextAttempt: 0, publications: [], stages: {},
        };
        if (workflow.scopeKey !== scopeKey || workflow.workflowId !== workflowId)
            refuse('WORKFLOW_SCOPE_MISMATCH');
        const save = async (next: any) => {
            assertActive();
            const data = copy({ ...database, workflows: { ...database.workflows, [workflowId]: next } });
            envelope = await session.compareAndSwap(envelope, data);
            assertActive();
            database = envelope.data;
            workflow = database.workflows[workflowId];
            return workflow;
        };
        const barrier = () => {
            assertActive();
            for (const row of values(database.workflows))
                for (const stage of [...values(row.stages ?? {}), ...(row.history ?? [])]) {
                    if (stage.submission && !notSent(stage) && !terminal.has(normalizeSubmissionRecovery(stage.submission).phase))
                        refuse('ACCOUNT_RECOVERY_REQUIRED');
                }
        };
        return action({ get: () => { assertActive(); return workflow; }, save, barrier, assertActive, isCurrent: current });
    });
    const reviewInput = (request: any, signal: any) => ({ scope, sources, request, fetchDocument: documents.fetch, signal });
    const reference = (stage: any): any => stage?.submission?.txHash ? { transactionHash: stage.submission.txHash,
        ...(stage.name === 'creation' ? { call: stage.batch[0] } : { batch: stage.batch }),
        ...(exactSubmissionOperation(stage.submission) ? { operation: exactSubmissionOperation(stage.submission) } : {}) } : undefined;
    const status = (workflow: any, signal: any, includeConfiguration: any = true) => {
        const creation = reference(workflow.stages.creation);
        if (!creation)
            refuse('CREATION_REFERENCE_UNAVAILABLE');
        return readRoleOperationStatus({ scope, sources, creation, ...(includeConfiguration && reference(workflow.stages.configuration)
                ? { configuration: reference(workflow.stages.configuration) } : {}), fetchDocument: documents.fetch, signal });
    };
    const approved = async (approval: any, signal: any, context?: any) => {
        active(signal, context);
        if (typeof confirm !== 'function')
            refuse('EXPLICIT_APPROVAL_REQUIRED');
        const accepted = await confirm(freeze({ workflowId, scope, ...approval }), { signal });
        active(signal, context);
        if (accepted !== true)
            refuse('APPROVAL_DECLINED');
    };
    async function publish(context: any, document: any, signal: any, beforePublish: any) {
        active(signal, context);
        if (typeof document.json !== 'string' || document.digest !== ethers.utils.id(document.json))
            refuse('PUBLICATION_BYTES_MISMATCH');
        const existing = context.get().publications.find((row: any) => row.key === document.key && row.digest === document.digest);
        if (existing?.status === 'published')
            return { cid: existing.cid };
        if (existing && existing.status !== 'not-published')
            refuse('PUBLICATION_RECOVERY_REQUIRED');
        if (typeof documents.publish !== 'function')
            refuse('DOCUMENT_PUBLISHER_REQUIRED');
        const row = { ...copy(document), status: 'submitting' };
        await context.save({ ...context.get(), publications: existing ? context.get().publications.map((saved: any) => saved === existing ? row : saved) : [...context.get().publications, row] });
        let invoked = false, receipt: any;
        try {
            await beforePublish();
            active(signal, context);
            invoked = true;
            receipt = await documents.publish(freeze(copy(document)), { signal });
            cidV0ToBytes32(receipt?.cid);
            await context.save({ ...context.get(), publications: context.get().publications.map((saved: any) => saved.key === row.key && saved.digest === row.digest
                    ? { ...saved, status: 'published', cid: receipt.cid } : saved) });
            active(signal, context);
            return { cid: receipt.cid };
        }
        catch (error: any) {
            // A publisher may have accepted bytes before losing its response. Never retry.
            const latest = context.get().publications.find((saved: any) => saved.key === row.key && saved.digest === row.digest);
            if (latest?.status !== 'published') {
                try {
                    await context.save({ ...context.get(), publications: context.get().publications.map((saved: any) => saved.key === row.key && saved.digest === row.digest
                            ? { ...saved, status: invoked ? 'unknown' : 'not-published', ...(typeof receipt?.cid === 'string' ? { candidateCid: receipt.cid } : {}) } : saved) });
                }
                catch { /* The durable submitting marker still blocks another publication. */ }
            }
            throw error;
        }
    }
    return {
        capabilities: safe(async (request: any, { signal }: any = {}) => {
            await identity(signal);
            return readRoleOperationEvidence({ scope, sources, request: copy(request), purpose: 'capabilities', signal });
        }),
        inspect: safe(async () => locked(async (context: any) => result('ready', copy(context.get())))),
        review: safe(async (inputRequest: any, { signal }: any = {}) => {
            const request = freeze(copy(inputRequest));
            await identity(signal);
            return locked(async (context: any) => {
                context.barrier();
                const previous = context.get(), stage = request.mode === 'create' ? 'creation' : request.mode === 'existing' ? 'configuration' : undefined;
                if (!stage)
                    refuse('STAGED_ROLE_REQUEST_REQUIRED');
                const earlier = previous.stages[stage];
                if (earlier?.submission && !notSent(earlier) && !['failed', 'replaced', 'aborted'].includes(earlier.submission.phase)) {
                    const outcome = await status(previous, signal, stage === 'configuration');
                    active(signal, context);
                    if (outcome.status !== 'ready')
                        return outcome;
                    const domain = stage === 'creation' ? outcome.data.creation : outcome.data.configuration;
                    if (!domain || !['failed', 'rejected'].includes(domain.state))
                        refuse('STAGE_ALREADY_SUBMITTED');
                }
                if (stage === 'configuration') {
                    const observed = await status(previous, signal, false);
                    active(signal, context);
                    if (observed.status !== 'ready')
                        return observed;
                    if (observed.data.creation.state !== 'created' || previous.requiresConfiguration !== true
                        || request.subjectId !== observed.data.creation.subjectId || key(request.continuation) !== key(reference(previous.stages.creation)))
                        refuse('ACTUAL_CREATED_SUBJECT_REQUIRED');
                }
                const observed = await reviewRoleOperation(reviewInput(request, signal));
                active(signal, context);
                if (observed.status !== 'ready')
                    return observed;
                const revision = previous.reviewRevision + 1;
                const stages = { ...previous.stages };
                if (earlier)
                    delete stages[stage];
                await context.save({ ...previous, stages, ...(earlier ? { history: [...(previous.history ?? []), earlier] } : {}), reviewRevision: revision, ...(stage === 'creation' ? { originalRequest: request, requiresConfiguration: observed.data.requiresConfiguration } : {}) });
                reviews.set(observed.data, { request, stage, revision });
                return observed;
            });
        }),
        prepare: safe(async ({ review, proposal: inputProposal, signal }: any = {}) => {
            const selected = reviews.get(review);
            if (!selected)
                refuse('CURRENT_REVIEW_REQUIRED');
            const proposal = freeze(copy(inputProposal ?? {}));
            if (typeof proposal.title !== 'string' || !proposal.title.trim() || typeof proposal.description !== 'string')
                refuse('PROPOSAL_DETAILS_REQUIRED');
            // Validate envelope inputs before any approval or irreversible publication.
            buildGovernanceProposal({ votingAddress: scope.contracts.hybridVoting, votingAbiName: 'HybridVotingNew', title: proposal.title,
                descriptionHash: ethers.constants.HashZero, durationMinutes: proposal.durationMinutes, numOptions: 2, batches: [[], []] });
            await identity(signal);
            return locked(async (context: any) => {
                context.barrier();
                let current = context.get();
                if (current.reviewRevision !== selected.revision || current.stages[selected.stage]?.submission)
                    refuse('CURRENT_REVIEW_REQUIRED');
                if (current.publications.some((row: any) => ['submitting', 'unknown'].includes(row.status)))
                    refuse('PUBLICATION_RECOVERY_REQUIRED');
                const json = serializeProposalMetadata(buildProposalMetadata({ description: proposal.description, optionNames: ['Yes', 'No'], createdAt: sources.now() * 1000 }));
                const document = { key: 'proposal-metadata', json, digest: ethers.utils.id(json) };
                await approved({ kind: 'publish', stage: selected.stage, request: selected.request, review, proposal,
                    documents: [...review.documents, { key: document.key, digest: document.digest }] }, signal, context);
                await identity(signal, context);
                const beforePublish = async () => {
                    await identity(signal, context);
                    const renewed = await reviewRoleOperation(reviewInput(selected.request, signal));
                    active(signal, context);
                    if (renewed.status !== 'ready' || renewed.data.fingerprint !== review.fingerprint || key(renewed.data.documents) !== key(review.documents))
                        refuse('PUBLICATION_REVIEW_NO_LONGER_CURRENT');
                };
                const input = { scope, sources, review, currentRequest: selected.request, fetchDocument: documents.fetch,
                    publishDocument: (doc: any) => publish(context, doc, signal, beforePublish), signal };
                const prepared = await prepareRoleOperation(input);
                active(signal, context);
                if (prepared.status !== 'ready')
                    return prepared;
                const { cid } = await publish(context, document, signal, beforePublish);
                const intent = freeze(intentData(buildGovernanceProposal({ votingAddress: scope.contracts.hybridVoting, votingAbiName: 'HybridVotingNew',
                    title: proposal.title, descriptionHash: cidV0ToBytes32(cid), durationMinutes: proposal.durationMinutes,
                    numOptions: 2, batches: [[...prepared.data.batch], []], orgId: scope.orgId })));
                const fresh = await revalidatePreparedRoleOperation({ ...input, prepared: prepared.data });
                active(signal, context);
                if (fresh.status !== 'ready')
                    return fresh;
                current = context.get();
                const count = current.nextAttempt + 1, attemptId = `${workflowId}-${selected.stage}-${count}`;
                const saved = { name: selected.stage, attemptId, request: selected.request, batch: fresh.data.batch, call: encodeIntent(intent) };
                await context.save({ ...current, nextAttempt: count, stages: { ...current.stages, [selected.stage]: saved } });
                const handle = freeze({ kind: 'prepared-role-workflow', workflowId, stage: selected.stage, intent, batch: fresh.data.batch,
                    requiresConfiguration: current.requiresConfiguration, documents: context.get().publications.filter((row: any) => row.status === 'published').map(({ key, digest, cid }: any) => ({ key, digest, cid })) });
                preparations.set(handle, { ...selected, attemptId, core: fresh.data, input, call: saved.call });
                return result('ready', handle);
            });
        }),
        submit: safe(async ({ prepared, signal }: any = {}) => {
            const selected = preparations.get(prepared);
            if (!selected)
                refuse('CURRENT_PREPARATION_REQUIRED');
            await identity(signal);
            return locked(async (context: any) => {
                context.barrier();
                let stage = context.get().stages[selected.stage];
                if (context.get().reviewRevision !== selected.revision || stage?.attemptId !== selected.attemptId || key(stage.call) !== key(selected.call))
                    refuse('CURRENT_PREPARATION_REQUIRED');
                if (stage.submission)
                    refuse('STAGE_ALREADY_SUBMITTED');
                const dispatch = await wallet.prepare({ scope: account, call: selected.call, signal, isCurrent: context.isCurrent });
                active(signal, context);
                const submissionEvent = preparedSubmissionEvent(dispatch, submissionIntentKey([selected.call]));
                if (dispatch.kind === 'user-operation' && (!wallet.recoveryReaders.getUserOperationReceipt || !wallet.recoveryReaders.getTransaction))
                    refuse('USER_OPERATION_RECEIPT_READERS_REQUIRED');
                await approved({ kind: 'send', stage: selected.stage, request: selected.request, intent: prepared.intent,
                    call: selected.call, nonce: dispatch.nonce, fromBlock: dispatch.fromBlock }, signal, context);
                let broadcast = false, txHash;
                try {
                    const receipt = await wallet.send(dispatch, { signal, isCurrent: context.isCurrent,
                        beforeSign: async () => {
                            active(signal, context);
                            await identity(signal, context);
                            const fresh = await revalidatePreparedRoleOperation({ ...selected.input, signal, prepared: selected.core });
                            if (fresh.status !== 'ready') refuse('PREPARATION_NO_LONGER_CURRENT');
                            active(signal, context);
                        }, beforeSend: async () => {
                            active(signal, context);
                            if (context.get().stages[selected.stage]?.submission)
                                refuse('SUBMISSION_ALREADY_PREPARED');
                            const fresh = await revalidatePreparedRoleOperation({ ...selected.input, signal, prepared: selected.core });
                            if (fresh.status !== 'ready')
                                refuse('PREPARATION_NO_LONGER_CURRENT');
                            active(signal, context);
                            const intentKey = submissionIntentKey([selected.call]);
                            let record = createSubmissionRecovery({ chainId: account.chainId, accountAddress: account.accountAddress,
                                intentKey, sessionKey: key(workflowId), contextKey: scopeKey }, `${workflowId}-host`, selected.attemptId);
                            record = transitionSubmissionRecovery(record, record, submissionEvent);
                            const saveRecord = async (next: any) => {
                                stage = { ...context.get().stages[selected.stage], submission: next };
                                await context.save({ ...context.get(), stages: { ...context.get().stages, [selected.stage]: stage } });
                            };
                            await saveRecord(record);
                            active(signal, context);
                            // Only after this durable write may the wallet adapter dispatch once.
                            record = transitionSubmissionRecovery(record, record, { type: 'broadcast' });
                            await saveRecord(record);
                            broadcast = true;
                            active(signal, context);
                            // Durable writes can consume the entire freshness window. Nothing
                            // asynchronous follows this last protocol check before wallet handoff.
                            const final = await revalidatePreparedRoleOperation({ ...selected.input, signal, prepared: selected.core });
                            if (final.status !== 'ready')
                                refuse('PREPARATION_NO_LONGER_CURRENT');
                            active(signal, context);
                        } });
                    const acknowledgement = submissionAcknowledgement(dispatch, receipt);
                    txHash = 'txHash' in acknowledgement.identity ? acknowledgement.identity.txHash : undefined;
                    stage = context.get().stages[selected.stage];
                    const record = transitionSubmissionRecovery(stage.submission, stage.submission, acknowledgement.event);
                    await context.save({ ...context.get(), stages: { ...context.get().stages, [selected.stage]: { ...stage, submission: record } } });
                    return result('pending', { workflowId, stage: selected.stage, ...acknowledgement.identity, submission: record, next: 'recover' });
                }
                catch (error: any) {
                    stage = context.get().stages[selected.stage];
                    if (stage?.submission && error?.dispatched === false) {
                        // This is an attestation from the injected trusted wallet port, never
                        // an input flag or a conclusion drawn from a missing receipt.
                        try {
                            await context.save({ ...context.get(), stages: { ...context.get().stages, [selected.stage]: { ...stage,
                                        notDispatched: { attemptId: selected.attemptId, code: 'WALLET_REFUSED_BEFORE_HANDOFF' } } } });
                            return result('blocked', { workflowId, stage: selected.stage, submission: stage.submission, next: 'review' }, ['SUBMISSION_NOT_DISPATCHED']);
                        }
                        catch {
                            return result('unknown', { workflowId, stage: selected.stage, submission: stage.submission, next: 'recover' }, ['JOURNAL_OUTCOME_UNKNOWN']);
                        }
                    }
                    if (broadcast || stage?.submission) {
                        try {
                            const record = transitionSubmissionRecovery(stage.submission, stage.submission, { type: 'unresolved' });
                            await context.save({ ...context.get(), stages: { ...context.get().stages, [selected.stage]: { ...stage, submission: record } } });
                        }
                        catch { /* Existing durable barrier remains authoritative. */ }
                        return result('unknown', { workflowId, stage: selected.stage, ...(txHash ? { txHash } : {}), submission: context.get().stages[selected.stage]?.submission, next: 'recover' }, ['SUBMISSION_OUTCOME_UNKNOWN']);
                    }
                    throw error;
                }
            });
        }),
        recover: safe(async ({ signal, candidateTxHash, candidateUserOpHash, publicationReceipts = [], abandonPrepared = false }: any = {}) => {
            active(signal);
            return locked(async (context: any) => {
                if (!Array.isArray(publicationReceipts) || publicationReceipts.length > 3)
                    refuse('INVALID_PUBLICATION_RECOVERY_BOUND');
                for (const receipt of publicationReceipts) {
                    const saved = context.get().publications.find((row: any) => row.key === receipt.key && row.digest === receipt.digest && row.status !== 'published');
                    if (!saved || typeof documents.fetch !== 'function')
                        refuse('PUBLICATION_PROOF_REQUIRED');
                    cidV0ToBytes32(receipt.cid);
                    active(signal, context);
                    const content = await documents.fetch(receipt.cid, { signal });
                    active(signal, context);
                    if (JSON.stringify(content) !== saved.json)
                        refuse('PUBLICATION_BYTES_MISMATCH');
                    await context.save({ ...context.get(), publications: context.get().publications.map((row: any) => row.key === saved.key && row.digest === saved.digest
                            ? { ...row, status: 'published', cid: receipt.cid } : row) });
                }
                if (context.get().publications.some((row: any) => ['submitting', 'unknown'].includes(row.status)))
                    return result('unknown', { publications: context.get().publications, next: 'supply-publication-receipt' }, ['PUBLICATION_OUTCOME_UNKNOWN']);
                for (const name of ['creation', 'configuration']) {
                    let stage = context.get().stages[name];
                    if (!stage?.submission)
                        continue;
                    let record = normalizeSubmissionRecovery(stage.submission);
                    if (notSent(stage))
                        return result('blocked', { submission: record, next: 'review' }, ['SUBMISSION_NOT_DISPATCHED']);
                    if (abandonPrepared && canAbandonSubmissionRecovery(record)) {
                        record = transitionSubmissionRecovery(record, record, { type: 'abort' });
                        await context.save({ ...context.get(), stages: { ...context.get().stages, [name]: { ...stage, submission: record } } });
                        return result('blocked', { submission: record }, ['PREPARED_SUBMISSION_ABANDONED']);
                    }
                    if (!terminal.has(record.phase)) {
                        const recovered = await reconcileSubmissionRecovery(record, wallet.recoveryReaders, recoveryCandidateOptions(record, candidateTxHash, candidateUserOpHash));
                        active(signal, context);
                        if (!['succeeded', 'failed', 'replaced'].includes(recovered.outcome.status))
                            return result('unknown', { submission: record, outcome: recovered.outcome, next: 'recover' }, [recovered.outcome.code ?? 'SUBMISSION_OUTCOME_UNKNOWN']);
                        record = normalizeSubmissionRecovery({ ...record, ...(recovered.outcome.txHash ? { txHash: recovered.outcome.txHash } : {}) });
                        record = transitionSubmissionRecovery(record, record, { type: 'settle', status: recovered.outcome.status as 'succeeded' | 'failed' | 'replaced' });
                        stage = { ...stage, submission: record };
                        await context.save({ ...context.get(), stages: { ...context.get().stages, [name]: stage } });
                    }
                    if (record.phase !== 'succeeded')
                        return result('blocked', { submission: record }, [`SUBMISSION_${record.phase.toUpperCase()}`]);
                }
                if (!reference(context.get().stages.creation))
                    return result('ready', copy(context.get()));
                const observed = await status(context.get(), signal);
                active(signal, context);
                if (observed.status !== 'ready')
                    return observed;
                const proof = observed.data, domain = proof.configuration ?? proof.creation;
                if (domain.state === 'pending')
                    return result('pending', { ...proof, next: 'recover' });
                if (['failed', 'rejected'].includes(domain.state))
                    return result('blocked', proof, [`ROLE_STAGE_${domain.state.toUpperCase()}`]);
                return result('confirmed', { ...proof, requiresConfiguration: context.get().requiresConfiguration,
                    complete: !!proof.configuration || context.get().requiresConfiguration === false });
            });
        }),
        continuation: safe(async ({ signal }: any = {}) => {
            active(signal);
            return locked(async (context: any) => {
                const workflow = context.get();
                if (workflow.stages.configuration?.submission && !terminal.has(workflow.stages.configuration.submission.phase) && !notSent(workflow.stages.configuration))
                    return result('unknown', { submission: workflow.stages.configuration.submission, next: 'recover' }, ['ACCOUNT_RECOVERY_REQUIRED']);
                const configuration = workflow.stages.configuration;
                const skipConfiguration = notSent(configuration) || ['failed', 'replaced', 'aborted'].includes(configuration?.submission?.phase);
                const observed = await status(workflow, signal, !skipConfiguration);
                active(signal, context);
                if (observed.status !== 'ready')
                    return observed;
                if (observed.data.creation.state !== 'created')
                    return result(observed.data.creation.state === 'pending' ? 'pending' : 'blocked', observed.data);
                if (observed.data.configuration && ['executed', 'pending'].includes(observed.data.configuration.state))
                    return result(observed.data.configuration.state === 'executed' ? 'confirmed' : 'pending', observed.data);
                if (workflow.requiresConfiguration === false)
                    return result('confirmed', { ...observed.data, complete: true });
                return result('ready', { creation: observed.data.creation, request: { ...copy(workflow.originalRequest), mode: 'existing',
                        subjectId: observed.data.creation.subjectId, continuation: reference(workflow.stages.creation) } });
            });
        }),
    };
}
