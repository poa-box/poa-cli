/**
 * Project-domain transaction builders (TaskManagerNew createProject /
 * deleteProject, plus the governance-wrapped propose path).
 *
 * Level 1 — pure builders returning TxIntents (or an ExecutionCall for the
 * governance wrap). Level 2 — resolved builders that resolve the org, pin the
 * `{description}` project metadata when given, and delegate. Same rules as
 * tx/task: confirmation prompts, pre-flights and receipt parsing are host UX.
 */

import { ethers } from 'ethers';
import type { TxIntent } from './intent';
import { buildGovernanceProposal, encodeExecutorCall, type ExecutionCall } from './governance';
import { getAbi } from '../contracts';
import { stringToBytes, ipfsCidToBytes32 } from '../encoding';
import { pinJson } from '../ipfs';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';
import type { PopContext } from '../context';
import { resolveOrgModules, requireModule } from '../reads/resolve';
import { resolveProjectInput } from '../reads/project';
import { buildProjectMetadata, serializeProjectMetadata } from '../metadata/task';
import { buildProposalMetadata, serializeProposalMetadata } from '../metadata/proposal';

// ─────────────────────────── Level 1: pure builders ───────────────────────────

/**
 * BootstrapProjectConfig inputs. Struct field order (verified against the
 * createProject components in the synced TaskManagerNew ABI, and the send
 * sites in project/create.ts + project/propose.ts):
 * [title, metaHash, cap, managers, createHats, claimHats, reviewHats,
 *  assignHats, bountyTokens, bountyCaps].
 */
export interface CreateProjectArgs {
  taskManagerAddress: string;
  /** Project name; encoded with stringToBytes here. */
  name: string;
  /** CIDv0 or bytes32 of the pinned `{description}` doc; omit ⇒ HashZero. */
  metadataHash?: string;
  /** Human PT cap (18 decimals applied here; 0/omitted = unlimited). */
  cap?: number | string;
  /** Manager addresses (project propose forces this empty — hat-based). */
  managers?: string[];
  createHats?: ethers.BigNumberish[];
  claimHats?: ethers.BigNumberish[];
  reviewHats?: ethers.BigNumberish[];
  assignHats?: ethers.BigNumberish[];
  /** Bounty token addresses (parallel to bountyCaps). */
  bountyTokens?: string[];
  /** Bounty caps in RAW wei, exactly as the CLI takes --bounty-caps. */
  bountyCaps?: ethers.BigNumberish[];
  orgId?: string;
}

/**
 * The raw BootstrapProjectConfig tuple, shared by the direct and the
 * governance-wrapped paths so the two cannot drift.
 */
export function encodeProjectStruct(a: CreateProjectArgs): unknown[] {
  if ([a.createHats, a.claimHats, a.reviewHats, a.assignHats].some(rows => rows?.length)) throw new Error('Project permission arrays were removed. Configure MembershipAuthority TM_PERMS using projectId + 1 after creating the project.');
  const cap = a.cap ? ethers.utils.parseUnits(a.cap.toString(), 18) : 0;
  return [
    stringToBytes(a.name),
    a.metadataHash ? ipfsCidToBytes32(a.metadataHash) : ethers.constants.HashZero,
    cap,
    a.managers ?? [],
    [],
    [],
    [],
    [],
    a.bountyTokens ?? [],
    (a.bountyCaps ?? []).map((c) => ethers.BigNumber.from(c)),
  ];
}

/**
 * Port of `pop project create` — src/commands/project/create.ts
 * (createProject send). Direct tx: _requireCreator() gates on-chain (creator
 * hat or executor); permissions are not pre-checked.
 */
export function buildCreateProject(a: CreateProjectArgs): TxIntent {
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'createProject',
    args: [encodeProjectStruct(a)],
    meta: {
      domain: 'project',
      action: 'create',
      orgId: a.orgId,
      summary: { name: a.name, cap: a.cap ? String(a.cap) : 'unlimited' },
    },
  };
}

export interface DeleteProjectArgs {
  taskManagerAddress: string;
  /** Resolved bytes32 project id. */
  projectId: string;
  orgId?: string;
}

/**
 * Port of `pop project delete` — src/commands/project/delete.ts
 * (deleteProject send; DESTRUCTIVE — consent is host UX).
 */
export function buildDeleteProject(a: DeleteProjectArgs): TxIntent {
  return {
    to: a.taskManagerAddress,
    abi: getAbi('TaskManagerNew'),
    method: 'deleteProject',
    args: [a.projectId],
    meta: { domain: 'project', action: 'delete', orgId: a.orgId, summary: { projectId: a.projectId } },
  };
}

/**
 * The createProject(BootstrapProjectConfig) call the executor performs when a
 * `pop project propose` vote passes — src/commands/project/propose.ts:97
 * (encoded via the full TaskManagerNew ABI, exactly as the CLI's loadAbi path).
 */
export function buildCreateProjectCall(a: CreateProjectArgs): ExecutionCall {
  return encodeExecutorCall('TaskManagerNew', a.taskManagerAddress, 'createProject', [encodeProjectStruct(a)]);
}

export interface ProposeProjectArgs {
  hybridVotingAddress: string;
  taskManagerAddress: string;
  /** Project name (used for the struct AND the proposal title/option names). */
  name: string;
  /** CIDv0 or bytes32 of the pinned project `{description}` doc; omit ⇒ HashZero. */
  metadataHash?: string;
  /** Human PT cap (0/omitted = unlimited). */
  cap?: number | string;
  managers?: string[];
  createHats?: ethers.BigNumberish[];
  claimHats?: ethers.BigNumberish[];
  reviewHats?: ethers.BigNumberish[];
  assignHats?: ethers.BigNumberish[];
  /** Vote duration in minutes. */
  durationMinutes: ethers.BigNumberish;
  /** CIDv0 or bytes32 of the pinned proposal metadata. */
  descriptionHash: string;
  orgId?: string;
}

/**
 * Port of `pop project propose` — src/commands/project/propose.ts.
 * HybridVoting.createProposal(`Create project: <name>`, descriptionHash,
 * duration, 2, [[createProject call], []], []). Explicit address managers remain supported; authority TM_PERMS replaces the retired role-mask arrays.
 */
export function buildProposeProject(a: ProposeProjectArgs): TxIntent {
  const call = buildCreateProjectCall({
    taskManagerAddress: a.taskManagerAddress,
    name: a.name,
    metadataHash: a.metadataHash,
    cap: a.cap,
    managers: a.managers ?? [],
    createHats: a.createHats,
    claimHats: a.claimHats,
    reviewHats: a.reviewHats,
    assignHats: a.assignHats,
    bountyTokens: [],
    bountyCaps: [],
  });
  return buildGovernanceProposal({
    votingAddress: a.hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    title: `Create project: ${a.name}`,
    descriptionHash: ipfsCidToBytes32(a.descriptionHash),
    durationMinutes: a.durationMinutes,
    numOptions: 2,
    batches: [
      [call], // option 0: create project
      [],     // option 1: do nothing
    ],
    hatIds: [],
    orgId: a.orgId,
    domain: 'project',
    action: 'propose',
    summary: { name: a.name, cap: a.cap ? String(a.cap) : 'unlimited' },
  });
}

// ─────────────────────────── Level 2: resolved builders ───────────────────────────

export interface CreateProjectParams {
  org: string;
  name: string;
  /** Pinned as `{description}` only when given (else metaHash = HashZero). */
  description?: string;
  cap?: number;
  managers?: string[];
  createHats?: Array<string | number>;
  claimHats?: Array<string | number>;
  reviewHats?: Array<string | number>;
  assignHats?: Array<string | number>;
  bountyTokens?: string[];
  /** Raw wei values, as `--bounty-caps` takes them. */
  bountyCaps?: Array<string | number>;
}

/**
 * Port of `pop project create` — src/commands/project/create.ts. Resolves the
 * org's TaskManager, pins the `{description}` metadata when provided, and
 * delegates to buildCreateProject.
 */
export async function createProjectIntent(ctx: PopContext, p: CreateProjectParams): Promise<TxIntent> {
  const modules = await resolveOrgModules(ctx.client, p.org, ctx.chainId);
  const taskManagerAddress = requireModule(modules, 'taskManagerAddress');

  let metaCid: string | undefined;
  let metadata: ReturnType<typeof buildProjectMetadata> | undefined;
  if (p.description) {
    metadata = buildProjectMetadata(p.description);
    metaCid = await pinJson(serializeProjectMetadata(metadata), ctx.ipfs);
  }

  const intent = buildCreateProject({
    taskManagerAddress,
    name: p.name,
    metadataHash: metaCid,
    cap: p.cap,
    managers: p.managers,
    createHats: p.createHats,
    claimHats: p.claimHats,
    reviewHats: p.reviewHats,
    assignHats: p.assignHats,
    bountyTokens: p.bountyTokens,
    bountyCaps: p.bountyCaps,
    orgId: modules.orgId,
  });
  if (metaCid && metadata) intent.meta.ipfs = { cid: metaCid, metadata };
  return intent;
}

export interface DeleteProjectParams {
  org: string;
  /** bytes32 hex | composite '<tm>-<hex>' | decimal counter | title. */
  project: string;
}

/**
 * Port of `pop project delete` — src/commands/project/delete.ts. Resolves the
 * project input (bytes32 / composite / decimal → bytes32(uint) / title via
 * subgraph) and builds deleteProject. The existence pre-flight (lens
 * PROJECT_INFO) and destructive consent are host UX.
 */
export async function deleteProjectIntent(ctx: PopContext, p: DeleteProjectParams): Promise<TxIntent> {
  const modules = await resolveOrgModules(ctx.client, p.org, ctx.chainId);
  const taskManagerAddress = requireModule(modules, 'taskManagerAddress');

  const { pid, title } = await resolveProjectInput(ctx.client, p.project, modules.orgId, ctx.chainId);

  const intent = buildDeleteProject({ taskManagerAddress, projectId: pid, orgId: modules.orgId });
  if (title && intent.meta.summary) intent.meta.summary.title = title;
  return intent;
}

export interface ProposeProjectParams {
  org: string;
  name: string;
  description?: string;
  cap?: number;
  managers?: string[];
  /** Vote duration in minutes (CLI default 1440 = 24h). */
  duration?: number;
  createHats?: Array<string | number>;
  claimHats?: Array<string | number>;
  reviewHats?: Array<string | number>;
  assignHats?: Array<string | number>;
}

/**
 * Port of `pop project propose` — src/commands/project/propose.ts. Two pins:
 * the project `{description}` doc (only when given) and the proposal metadata
 * {description, optionNames, createdAt} with the CLI's exact strings. Then
 * wraps the createProject calldata in a HybridVoting proposal.
 */
export async function proposeProjectIntent(ctx: PopContext, p: ProposeProjectParams): Promise<TxIntent> {
  const modules = await resolveOrgModules(ctx.client, p.org, ctx.chainId);
  const taskManagerAddress = requireModule(modules, 'taskManagerAddress');
  const hybridVotingAddress = modules.hybridVotingAddress;
  if (!hybridVotingAddress) {
    throw new CliError('No HybridVoting found for this org', EXIT.PRECONDITION, 'This org cannot run governance proposals.');
  }
  const duration = p.duration ?? 1440;

  // Pin project metadata to IPFS (only when a description was given).
  let metaCid: string | undefined;
  if (p.description) {
    metaCid = await pinJson(serializeProjectMetadata(buildProjectMetadata(p.description)), ctx.ipfs);
  }

  // Proposal metadata — key order {description, optionNames, createdAt} is a
  // protocol contract; strings match project/propose.ts verbatim.
  const proposalMeta = buildProposalMetadata({
    description: `Create project "${p.name}"${p.description ? ': ' + p.description : ''}. PT cap: ${p.cap || 'unlimited'}. If this proposal passes, the project will be created automatically via execution call.`,
    optionNames: [`Create "${p.name}"`, 'Do not create'],
  });
  const proposalCid = await pinJson(serializeProposalMetadata(proposalMeta), ctx.ipfs);

  const intent = buildProposeProject({
    hybridVotingAddress,
    taskManagerAddress,
    name: p.name,
    metadataHash: metaCid,
    cap: p.cap,
    managers: p.managers,
    createHats: p.createHats,
    claimHats: p.claimHats,
    reviewHats: p.reviewHats,
    assignHats: p.assignHats,
    durationMinutes: duration,
    descriptionHash: proposalCid,
    orgId: modules.orgId,
  });
  intent.meta.ipfs = { cid: proposalCid, metadata: proposalMeta };
  return intent;
}
