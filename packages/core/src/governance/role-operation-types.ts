import type { ethers } from 'ethers';
import type { Fact, PlanConsequence, PlanPrerequisite, PlanScope, SourceSnapshot } from '../data/facts';
import type { SubjectAllocation, SubjectCreationProposal } from '../authority/ids';
import type { AuthoritySnapshotData, AuthoritySnapshotQuery } from '../reads/authority';
import type { ExactOperationIdentity, ProvenanceProvider } from '../reads/provenance';
import type { ExecutionCall } from '../tx/governance';
import type { PlanningFreshness, RoleConfigurationRequest, RolePlanningContext } from './role-planning';
import type { RoleConfigurationOutcome, RoleContinuationResult } from './role-continuation';

export type RoleOperationScope = PlanScope & { orgId: string; contract: string; account: string;
  contracts: { membershipAuthority: string; hybridVoting: string; executor: string } & Readonly<Record<string, string>> };
export type RoleOperationRole = Omit<RoleConfigurationRequest, 'email'> & {
  emailAdditions?: readonly { type: 'domain' | 'email'; identifier: string }[];
};
export type RoleOperationRequest = ({ mode: 'create' } | { mode: 'existing'; subjectId: string; continuation?: RoleCreationReference }
  | { mode: 'compound' }) & { role: RoleOperationRole; metadata?: { name: string; description: string } };
export interface RoleOperationSources {
  indexed: { endpoint: string; query: AuthoritySnapshotQuery };
  rpc: { endpoint: string; provider: ProvenanceProvider & Pick<ethers.providers.Provider, 'call'> };
  now: () => number;
}
export interface RoleOperationReadBounds {
  authorityPageSize?: number; authorityMaxPages?: number; authorityMaxRows?: number;
  proposalPageSize?: number; proposalMaxPages?: number; maxAccounts?: number;
  maxCompoundSubjects?: number; maxProvenanceCandidates?: number;
  /** Optional finite budget across every underlying RPC method in one observation. */
  maxRpcCalls?: number;
}
export interface ReadRoleOperationEvidenceInput {
  scope: RoleOperationScope; request: RoleOperationRequest; sources: RoleOperationSources;
  /** Defaults to operation. Capabilities observes configured modules for options,
   * without subject/history/holder work or authority to review/prepare a change. */
  purpose?: 'operation' | 'capabilities';
  authoritySnapshot?: SourceSnapshot<AuthoritySnapshotData>; bounds?: RoleOperationReadBounds; signal?: AbortSignal;
}
export interface ReviewRoleOperationInput extends Omit<ReadRoleOperationEvidenceInput, 'purpose'> {
  fetchDocument?: (cid: string, options: { signal?: AbortSignal }) => Promise<unknown | null>;
}
export interface RoleOperationEvidence {
  purpose: 'operation' | 'capabilities';
  scope: RoleOperationScope; mode: 'create' | 'existing' | 'compound'; subjectId?: string;
  freshness: PlanningFreshness; context: SourceSnapshot<RolePlanningContext>;
  authoritySnapshot: SourceSnapshot<AuthoritySnapshotData>;
  allocations?: SourceSnapshot<readonly SubjectAllocation[]>;
  proposals?: SourceSnapshot<readonly SubjectCreationProposal[]>;
  activeAllowlist?: SourceSnapshot<{ root: Fact<string>; cid: Fact<string> }>;
}
/** digest is keccak256 of the exact UTF-8 json bytes. A publisher's CID is its
 * adapter attestation, not a claim that this digest is an IPFS DAG digest. */
export interface RoleOperationDocument { key: 'role-metadata' | 'email-allowlist'; json: string; digest: string }
/** Protocol fields applied at this stage or retained for a separately reviewed stage. */
export interface RoleOperationEffect { field: keyof RoleOperationRole | 'metadata'; }
declare const roleReviewBrand: unique symbol;
export type RoleOperationReview = Readonly<{
  readonly [roleReviewBrand]: true; kind: 'role-operation-review'; requestKey: string; fingerprint: string;
  mode: 'create' | 'existing' | 'compound'; subjectId?: string; predictedSubjectId?: string;
  requiresConfiguration: boolean; consequences: readonly PlanConsequence[];
  documents: readonly Pick<RoleOperationDocument, 'key' | 'digest'>[];
  currentEffects: readonly RoleOperationEffect[]; deferredEffects: readonly RoleOperationEffect[];
  preview: { callCount: number; createsSubject: boolean }; evidence: RoleOperationEvidence;
}>;
export interface PrepareRoleOperationInput {
  scope: RoleOperationScope; sources: RoleOperationSources; review: RoleOperationReview;
  currentRequest: RoleOperationRequest; fetchDocument?: ReviewRoleOperationInput['fetchDocument'];
  publishDocument?: (document: RoleOperationDocument, options: { signal?: AbortSignal }) => Promise<{ cid: string }>;
  signal?: AbortSignal;
}
export interface PreparedRoleOperation {
  mode: 'create' | 'existing' | 'compound'; subjectId?: string; predictedSubjectId?: string;
  requiresConfiguration: boolean; fingerprint: string;
  batch: readonly (Omit<ExecutionCall, 'value'> & { value: string })[];
  consequences: readonly PlanConsequence[]; documents: readonly { key: string; digest: string; cid: string }[];
  evidence: RoleOperationEvidence;
}
export interface RoleCreationReference {
  transactionHash: string; proposalId?: string; call: ExecutionCall;
  operation?: ExactOperationIdentity; executionOperation?: ExactOperationIdentity;
}
export interface RoleConfigurationReference {
  transactionHash: string; proposalId?: string; batch: readonly ExecutionCall[];
  operation?: ExactOperationIdentity; executionOperation?: ExactOperationIdentity;
}
export interface ReadRoleOperationStatusInput {
  scope: RoleOperationScope; sources: RoleOperationSources; creation: RoleCreationReference;
  configuration?: RoleConfigurationReference; authoritySnapshot?: SourceSnapshot<AuthoritySnapshotData>;
  /** At most one explicit content read. A configuration allowlist must verify
   * against its exact committed root/org and include the proven created subject. */
  fetchDocument?: ReviewRoleOperationInput['fetchDocument'];
  bounds?: RoleOperationReadBounds; signal?: AbortSignal;
}
export interface RoleOperationStatus {
  creation: RoleContinuationResult; configuration?: RoleConfigurationOutcome;
  next: 'wait' | 'review-creation' | 'review-configuration' | 'complete';
}
export interface RoleOperationObservationSet {
  authority?: SourceSnapshot<AuthoritySnapshotData>; planning?: SourceSnapshot<RolePlanningContext>;
  allocations?: SourceSnapshot<readonly SubjectAllocation[]>; proposals?: SourceSnapshot<readonly SubjectCreationProposal[]>;
  creation?: Fact<RoleContinuationResult>; configuration?: Fact<RoleConfigurationOutcome>;
}
export type RoleOperationResult<T> = { status: 'ready'; data: T; consequences: readonly PlanConsequence[] }
  | { status: 'blocked' | 'unknown'; codes: readonly string[]; prerequisites: readonly PlanPrerequisite[];
    consequences: readonly PlanConsequence[]; observations?: RoleOperationObservationSet;
    publishedDocuments?: readonly { key: string; digest: string; cid: string }[] };
