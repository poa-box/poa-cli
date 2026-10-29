import type { TxIntent } from '@poa-box/core/tx/intent';
import type { Fact, SourceSnapshot } from '@poa-box/core/data/facts';
import type { RecoveryReceipt, SubmissionRecoveryRecord } from '@poa-box/core/execute/recovery';
import type { AccountTransport, UnsignedCall } from '../wallet';
import type { BrowserJournal } from '../storage';

export interface WorkflowScope {
  chainId: number; orgId: string; account: string;
  contracts: Readonly<Record<string, string>>;
}
export interface WorkflowSources {
  rpcEndpoint: string; indexedEndpoint: string;
  /** Unix seconds, injected so review freshness is deterministic. */
  now(): number; maxAgeSeconds?: number;
}
export interface WorkflowDocument { key: string; json: string; digest: string }
export interface PublishedWorkflowDocument { key: string; digest: string; cid: string }
export interface WorkflowApproval {
  kind: 'publish' | 'send' | 'sign-registration'; workflowId: string;
  scope: Readonly<WorkflowScope>; request: unknown; summary: unknown;
  documents?: readonly WorkflowDocument[]; call?: Readonly<UnsignedCall>;
  nonce?: string; fromBlock?: string;
}
export interface WorkflowHost {
  workflowId: string; scope: WorkflowScope; sources: WorkflowSources;
  wallet: AccountTransport; journal: BrowserJournal<unknown>; isCurrent(): boolean;
  /** eth_call/callStatic, pinned by the host. True is a revert prediction for
   * this exact call/account, not a substitute for policy authorization. */
  simulate(call: Readonly<UnsignedCall>, options: { scope: Readonly<WorkflowScope>; signal?: AbortSignal }): Promise<SourceSnapshot<{ callKey: string; succeeds: Fact<boolean> }>>;
  confirm(approval: Readonly<WorkflowApproval>, options: { signal?: AbortSignal }): Promise<boolean>;
  documents?: {
    publish(document: Readonly<WorkflowDocument>, options: { signal?: AbortSignal }): Promise<{ cid: string }>;
    fetch?(cid: string, options: { signal?: AbortSignal }): Promise<unknown>;
  };
}
export type WorkflowStatus = 'ready' | 'blocked' | 'unknown' | 'pending' | 'confirmed';
export interface WorkflowResult<T = unknown> { status: WorkflowStatus; data?: T; codes?: readonly string[] }
export interface WorkflowReview<R, S> {
  readonly kind: 'operation-review'; readonly operation: string;
  readonly request: Readonly<R>; readonly summary: Readonly<S>;
  readonly documents: readonly WorkflowDocument[]; readonly fingerprint: string;
}
export interface WorkflowPreparation<R, S> {
  readonly kind: 'prepared-operation'; readonly operation: string;
  readonly request: Readonly<R>; readonly summary: Readonly<S>;
  readonly call: Readonly<UnsignedCall>; readonly documents: readonly PublishedWorkflowDocument[];
}
export interface OperationWorkflow<R, S> {
  review(request: R, options?: { signal?: AbortSignal }): Promise<WorkflowResult<WorkflowReview<R, S>>>;
  prepare(input: { review: WorkflowReview<R, S>; signal?: AbortSignal }): Promise<WorkflowResult<WorkflowPreparation<R, S>>>;
  submit(input: { prepared: WorkflowPreparation<R, S>; signal?: AbortSignal }): Promise<WorkflowResult>;
  inspect(): Promise<WorkflowResult>;
  status(options?: { signal?: AbortSignal; candidateTxHash?: string; candidateUserOpHash?: string }): Promise<WorkflowResult>;
  recover(options?: { signal?: AbortSignal; candidateTxHash?: string; candidateUserOpHash?: string; publicationReceipts?: readonly PublishedWorkflowDocument[] }): Promise<WorkflowResult>;
}
/** These ports provide observations, never authorization booleans. Built-in
 * workflows validate their source scopes and evaluate core protocol policies. */
export interface EvidenceReader<R, E> {
  read(request: Readonly<R>, options: { scope: Readonly<WorkflowScope>; signal?: AbortSignal }): Promise<E>;
}
export interface OperationPlan<S> {
  /** Stable semantic facts that require another review if they change. */
  binding: unknown; summary: S; documents?: readonly WorkflowDocument[];
}
export interface OperationDefinition<R, E, S> {
  name: string;
  evaluate(request: Readonly<R>, evidence: E): OperationPlan<S>;
  build(request: Readonly<R>, evidence: E, documents: readonly PublishedWorkflowDocument[],
    approval: () => Promise<void>, signal?: AbortSignal, isCurrent?: () => boolean): TxIntent | Promise<TxIntent>;
  /** Redact public credential material when a domain does not need it to recover. */
  journalRequest?(request: Readonly<R>): unknown;
  outcome(request: Readonly<R>, receipt: RecoveryReceipt, documents: readonly PublishedWorkflowDocument[]): WorkflowResult;
}
export interface WorkflowJournalStage {
  attemptId: string; request: unknown; summary: unknown; callKey: string; callValue: string;
  documents: readonly PublishedWorkflowDocument[];
  submission?: SubmissionRecoveryRecord; notDispatched?: { attemptId: string; code: string };
}
export type Snapshot<T> = SourceSnapshot<T>;
