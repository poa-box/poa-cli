/**
 * Education write builders.
 *
 * Ports:
 *   - `pop education create`   — src/commands/education/create-module.ts
 *   - `pop education complete` — src/commands/education/complete.ts
 *   - `pop education update`   — src/commands/education/update.ts
 *   - `pop education remove`   — src/commands/education/remove.ts
 *
 * EducationHub facts (verified contracts origin/main src/EducationHub.sol):
 *   - createModule hashes the correct answer into the module PERMANENTLY —
 *     updateModule never touches answerHash, so changing quiz content cannot
 *     change which answer index passes (remove + recreate to change it).
 *   - updateModule is a FULL OVERWRITE of title + contentHash + payout.
 *   - removeModule is a permanent delete with no undo.
 *   - The chain stores only {answerHash, payout, exists}; module metadata is
 *     event-only, so preservation reads go through the subgraph/IPFS.
 */

import { ethers } from 'ethers';
import type { TxIntent } from './intent';
import type { PopContext } from '../context';
import { getAbi, createReadContract } from '../contracts';
import { stringToBytes, ipfsCidToBytes32, bytes32ToIpfsCid, parseModuleId } from '../encoding';
import { pinJson, fetchJson } from '../ipfs';
import { CliError, PreconditionError } from '../errors';
import { EXIT } from '../exit-codes';
import { resolveOrgModules, requireModule } from '../reads/resolve';
import {
  buildEducationModuleMetadata,
  serializeEducationModuleMetadata,
} from '../metadata/education';
import { FETCH_MODULES_FOR_UPDATE, getModuleTitle } from '../reads/education';
import type { EducationModuleForUpdateRow } from '../reads/education';

// ---------------------------------------------------------------------------
// Level 1 — pure builders
// ---------------------------------------------------------------------------

export interface CreateModuleArgs {
  educationHubAddress: string;
  /** Module title (encoded with stringToBytes). */
  name: string;
  /** bytes32 of the pinned module metadata CID. */
  contentHash: string;
  /** PT reward in whole tokens — encoded parseUnits(String(payout), 18) like the CLI. */
  payout: number | string;
  /** Index of the correct answer (0-255) — PERMANENT after creation. */
  correctAnswer: number;
  orgId?: string;
}

/**
 * Port of `pop education create` — src/commands/education/create-module.ts.
 * EducationHubNew.createModule(stringToBytes(name), contentHash,
 * payoutWei(18d), correctAnswer uint8). Validates payout > 0 (the contract
 * reverts InvalidPayout for 0) and correctAnswer 0-255, same messages as the
 * CLI.
 */
export function buildCreateModule(a: CreateModuleArgs): TxIntent {
  const payoutNum = Number(a.payout);
  if (!(payoutNum > 0) || !isFinite(payoutNum)) {
    throw new CliError(
      `--payout must be a positive number (the contract reverts InvalidPayout for 0), got: ${a.payout}`,
      EXIT.USAGE
    );
  }
  if (!Number.isInteger(a.correctAnswer) || a.correctAnswer < 0 || a.correctAnswer > 255) {
    throw new CliError(`--correct-answer must be an integer 0-255 (uint8), got: ${a.correctAnswer}`, EXIT.USAGE);
  }

  const titleBytes = stringToBytes(a.name);
  const payoutWei = ethers.utils.parseUnits(a.payout.toString(), 18);

  return {
    to: a.educationHubAddress,
    abi: getAbi('EducationHubNew'),
    method: 'createModule',
    args: [titleBytes, a.contentHash, payoutWei, a.correctAnswer],
    meta: {
      domain: 'education',
      action: 'create-module',
      orgId: a.orgId,
      summary: {
        name: a.name,
        payout: `${a.payout} PT`,
        correctAnswer: `index ${a.correctAnswer} (permanent)`,
      },
    },
  };
}

export interface CompleteModuleArgs {
  educationHubAddress: string;
  /** Module ID — accepts the subgraph "address-id" form (parseModuleId). */
  moduleId: string | number;
  /** Answer index (0-based). Wrong answers are only knowable on-chain (InvalidAnswer). */
  answer: number;
  orgId?: string;
}

/**
 * Port of `pop education complete` — src/commands/education/complete.ts.
 * EducationHubNew.completeModule(moduleId, answer uint8) — pays PT once per
 * account (reverts AlreadyCompleted on a second attempt, ModuleUnknown for
 * missing modules). Validates answer 0-255, same message as the CLI.
 */
export function buildCompleteModule(a: CompleteModuleArgs): TxIntent {
  if (!Number.isInteger(a.answer) || a.answer < 0 || a.answer > 255) {
    throw new CliError(`--answer must be an integer 0-255 (uint8), got: ${a.answer}`, EXIT.USAGE);
  }
  const moduleId = parseModuleId(a.moduleId);

  return {
    to: a.educationHubAddress,
    abi: getAbi('EducationHubNew'),
    method: 'completeModule',
    args: [moduleId, a.answer],
    meta: {
      domain: 'education',
      action: 'complete',
      orgId: a.orgId,
      summary: { moduleId, answer: `index ${a.answer}` },
    },
  };
}

export interface UpdateModuleArgs {
  educationHubAddress: string;
  /** Module ID — accepts the subgraph "address-id" form (parseModuleId). */
  moduleId: string | number;
  /** FULL replacement title (updateModule overwrites it even when unchanged). */
  name: string;
  /** FULL replacement contentHash (pass the current one to keep metadata). */
  contentHash: string;
  /**
   * FULL replacement payout in PT WEI (BigNumber), not whole tokens — the
   * resolved builder writes back the on-chain value when unchanged, so this
   * stays in wei end-to-end (unlike createModule, where the CLI parses a
   * whole-token number).
   */
  payoutWei: ethers.BigNumberish;
  orgId?: string;
}

/**
 * Port of `pop education update` — src/commands/education/update.ts.
 * EducationHubNew.updateModule(id, stringToBytes(name), contentHash,
 * payoutWei) — full overwrite of title + contentHash + payout; the answer
 * hash is IMMUTABLE.
 */
export function buildUpdateModule(a: UpdateModuleArgs): TxIntent {
  const moduleId = parseModuleId(a.moduleId);
  return {
    to: a.educationHubAddress,
    abi: getAbi('EducationHubNew'),
    method: 'updateModule',
    args: [moduleId, stringToBytes(a.name), a.contentHash, a.payoutWei],
    meta: {
      domain: 'education',
      action: 'update',
      orgId: a.orgId,
      summary: { moduleId, title: a.name },
    },
  };
}

export interface RemoveModuleArgs {
  educationHubAddress: string;
  /** Module ID — accepts the subgraph "address-id" form (parseModuleId). */
  moduleId: string | number;
  orgId?: string;
  /** Display-only module title for confirmation UIs. */
  title?: string;
}

/**
 * Port of `pop education remove` — src/commands/education/remove.ts.
 * EducationHubNew.removeModule(moduleId) — PERMANENT delete, no undo; past
 * completions keep their minted PT but the module disappears for everyone.
 */
export function buildRemoveModule(a: RemoveModuleArgs): TxIntent {
  const moduleId = parseModuleId(a.moduleId);
  return {
    to: a.educationHubAddress,
    abi: getAbi('EducationHubNew'),
    method: 'removeModule',
    args: [moduleId],
    meta: {
      domain: 'education',
      action: 'remove',
      orgId: a.orgId,
      summary: {
        module: a.title ? `#${moduleId} — ${a.title}` : `#${moduleId}`,
        warning: 'permanent removal — no undo; the module and its payout disappear for everyone',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Level 2 — resolved builders
// ---------------------------------------------------------------------------

export interface CreateModuleParams {
  /** Org name or 0x id. */
  org: string;
  name: string;
  description?: string;
  link?: string;
  payout: number | string;
  quiz?: string[];
  answers?: string[][];
  correctAnswer: number;
}

/**
 * Resolved builder for `pop education create` — src/commands/education/create-module.ts.
 * Resolves the org's EducationHub, pins the module metadata
 * ({name, description, link, quiz, answers} — key order load-bearing), and
 * delegates to buildCreateModule.
 */
export async function createModuleIntent(
  ctx: PopContext,
  params: CreateModuleParams
): Promise<TxIntent> {
  const quiz = params.quiz || [];
  const answers = params.answers || [];
  if (quiz.length > 0 && answers.length > 0 && quiz.length !== answers.length) {
    throw new CliError(`Quiz has ${quiz.length} questions but ${answers.length} answer sets. They must match.`, EXIT.USAGE);
  }

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const educationHubAddress = requireModule(modules, 'educationHubAddress');

  const metadata = buildEducationModuleMetadata({
    name: params.name,
    description: params.description,
    link: params.link,
    quiz,
    answers,
  });
  const cid = await pinJson(serializeEducationModuleMetadata(metadata), ctx.ipfs);
  const contentHash = ipfsCidToBytes32(cid);

  const intent = buildCreateModule({
    educationHubAddress,
    name: params.name,
    contentHash,
    payout: params.payout,
    correctAnswer: params.correctAnswer,
    orgId: modules.orgId,
  });
  intent.meta.ipfs = { cid, metadata };
  return intent;
}

export interface CompleteModuleParams {
  /** Org name or 0x id. */
  org: string;
  /** Module ID. */
  module: string | number;
  /** Answer index (0-based). */
  answer: number;
}

/**
 * Resolved builder for `pop education complete` — src/commands/education/complete.ts.
 * Resolves the org's EducationHub and delegates to buildCompleteModule. The
 * CLI's pre-flight (module exists via getModule, not-already-completed via
 * hasCompleted) is a host concern — see checkModuleExists/checkNotCompleted
 * in the CLI's education helpers.
 */
export async function completeModuleIntent(
  ctx: PopContext,
  params: CompleteModuleParams
): Promise<TxIntent> {
  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const educationHubAddress = requireModule(modules, 'educationHubAddress');
  return buildCompleteModule({
    educationHubAddress,
    moduleId: params.module,
    answer: params.answer,
    orgId: modules.orgId,
  });
}

export interface UpdateModuleParams {
  /** Org name or 0x id. */
  org: string;
  /** Module ID. */
  module: string | number;
  /** New PT reward in whole tokens (must be > 0). Omit to preserve. */
  payout?: number;
  name?: string;
  description?: string;
  link?: string;
  quiz?: string[];
  answers?: string[][];
}

/**
 * Resolved builder for `pop education update` — src/commands/education/update.ts.
 *
 * READ-MERGE issued concurrently (Promise.allSettled): payout + existence
 * from on-chain getModule — deliberately NOT the indexed payout, because a
 * full overwrite writes the read-back value and a stale one would silently
 * ROLL BACK a concurrent raise; the same call is the ModuleUnknown existence
 * gate. Title/metadata come from FETCH_MODULES_FOR_UPDATE (the chain stores
 * only {answerHash, payout, exists} — metadata is event-only) with an IPFS
 * fallback. Metadata is re-pinned ONLY when its content actually changes —
 * same key order as create ({name, description, link, quiz, answers}).
 *
 * Requires ctx.provider (the on-chain getModule read).
 */
export async function updateModuleIntent(
  ctx: PopContext,
  params: UpdateModuleParams
): Promise<TxIntent> {
  // ── 0. Fail fast on input problems before any network work ─────────
  const metadataChanging = params.name !== undefined
    || params.description !== undefined
    || params.link !== undefined
    || params.quiz !== undefined
    || params.answers !== undefined;
  const payoutChanging = params.payout !== undefined;
  if (!metadataChanging && !payoutChanging) {
    throw new CliError(
      'Nothing to update — pass at least one field flag.',
      EXIT.USAGE,
      'Available: --payout, --name, --description, --link, --quiz, --answers'
    );
  }
  if (payoutChanging && (!(params.payout! > 0) || !isFinite(params.payout!))) {
    throw new CliError(
      `--payout must be a positive number (the contract reverts InvalidPayout for 0), got: ${params.payout}`,
      EXIT.USAGE
    );
  }
  if (!ctx.provider) {
    throw new CliError('updateModuleIntent requires ctx.provider (on-chain getModule read — see the payout note above)', EXIT.USAGE);
  }

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const educationHubAddress = requireModule(modules, 'educationHubAddress');
  const moduleId = parseModuleId(params.module);

  // ── 1+2. READ: on-chain payout/existence AND the indexed metadata ──
  const hub = createReadContract(educationHubAddress, 'EducationHubNew', ctx.provider);
  const [chainRead, indexedRead] = await Promise.allSettled([
    hub.getModule(moduleId),
    ctx.client.query<{
      organization: { educationHub: { modules: EducationModuleForUpdateRow[] } | null } | null;
    }>(FETCH_MODULES_FOR_UPDATE, { orgId: modules.orgId }, ctx.chainId),
  ]);

  if (chainRead.status === 'rejected') {
    throw new PreconditionError(
      `Could not read module ${moduleId} on-chain — it may not exist (getModule reverts ModuleUnknown).`,
      'List modules with: pop education list'
    );
  }
  const currentPayout: ethers.BigNumber = chainRead.value[0];

  // Subgraph unavailable — handled below based on what the merge needs.
  let subgraphModule: EducationModuleForUpdateRow | null = null;
  if (indexedRead.status === 'fulfilled') {
    const rows = indexedRead.value.organization?.educationHub?.modules || [];
    subgraphModule = rows.find((m) => String(m.moduleId) === String(moduleId)) || null;
  }

  let ipfsMetadata: any = null;
  const currentCid = subgraphModule?.contentHash ? bytes32ToIpfsCid(subgraphModule.contentHash) : null;
  if (currentCid) {
    try {
      ipfsMetadata = await fetchJson(currentCid, ctx.ipfs);
    } catch { /* IPFS lag — fall back to subgraph fields */ }
  }

  const currentName: string | undefined = ipfsMetadata?.name ?? subgraphModule?.title ?? undefined;
  const currentDescription: string | undefined = ipfsMetadata?.description ?? subgraphModule?.metadata?.description ?? undefined;
  const currentLink: string | undefined = ipfsMetadata?.link ?? subgraphModule?.metadata?.link ?? undefined;
  const currentQuiz: any[] | undefined = ipfsMetadata?.quiz ?? subgraphModule?.metadata?.quiz ?? undefined;
  let currentAnswers: any[] | undefined = ipfsMetadata?.answers;
  if (currentAnswers === undefined && subgraphModule?.metadata?.answersJson) {
    try {
      currentAnswers = JSON.parse(subgraphModule.metadata.answersJson);
    } catch { /* unparseable — treated as unknown */ }
  }
  const currentContentHash: string | undefined = subgraphModule?.contentHash ?? undefined;

  // updateModule overwrites title + contentHash even when only payout
  // changed — so the current values must be recoverable.
  if (!metadataChanging && (currentName === undefined || !currentContentHash)) {
    throw new CliError(
      `Module ${moduleId} metadata is not indexed yet (subgraph lag) — cannot preserve the current title/metadata through a full-overwrite update.`,
      EXIT.INFRA,
      'Retry in a few seconds, or pass --name and --description explicitly.'
    );
  }
  if (metadataChanging
    && (params.name === undefined || params.description === undefined)
    && (currentName === undefined || currentDescription === undefined)) {
    throw new CliError(
      `Module ${moduleId} metadata is not indexed yet (subgraph lag) — cannot merge a partial metadata edit.`,
      EXIT.INFRA,
      'Retry in a few seconds, or pass BOTH --name and --description.'
    );
  }

  // ── 3. MERGE: passed fields override, everything else preserved ────
  const finalPayout = payoutChanging
    ? ethers.utils.parseUnits(params.payout!.toString(), 18)
    : currentPayout;
  const finalName = params.name ?? currentName ?? '';
  const finalDescription = params.description ?? currentDescription ?? '';
  const finalLink = params.link ?? currentLink ?? '';
  const finalQuiz = params.quiz ?? currentQuiz ?? [];
  const finalAnswers = params.answers ?? currentAnswers ?? [];

  if (finalQuiz.length > 0 && finalAnswers.length > 0 && finalQuiz.length !== finalAnswers.length) {
    throw new CliError(
      `Quiz has ${finalQuiz.length} questions but ${finalAnswers.length} answer sets. They must match.`,
      EXIT.USAGE
    );
  }

  // Re-pin only when the metadata content actually changes.
  let finalContentHash = currentContentHash
    ? currentContentHash
    : ethers.constants.HashZero;
  let newCid: string | undefined;
  let metadataDoc: any;
  const metadataActuallyChanged = metadataChanging && (
    finalName !== currentName
    || finalDescription !== (currentDescription ?? '')
    || finalLink !== (currentLink ?? '')
    || JSON.stringify(finalQuiz) !== JSON.stringify(currentQuiz ?? [])
    || JSON.stringify(finalAnswers) !== JSON.stringify(currentAnswers ?? [])
  );
  if (metadataActuallyChanged) {
    // NOTE (CLI warns here): when neither IPFS nor the subgraph could supply
    // the current metadata, unspecified fields reset to defaults in the
    // re-pinned JSON.
    // Key order MUST match metadata/education.ts (frontend/subgraph parity).
    metadataDoc = buildEducationModuleMetadata({
      name: finalName,
      description: finalDescription,
      link: finalLink,
      quiz: finalQuiz,
      answers: finalAnswers,
    });
    newCid = await pinJson(serializeEducationModuleMetadata(metadataDoc), ctx.ipfs);
    finalContentHash = ipfsCidToBytes32(newCid);
  }

  const intent = buildUpdateModule({
    educationHubAddress,
    moduleId,
    name: finalName,
    contentHash: finalContentHash,
    payoutWei: finalPayout,
    orgId: modules.orgId,
  });
  (intent.meta.summary as Record<string, unknown>).metadataChanged = metadataActuallyChanged;
  if (newCid) intent.meta.ipfs = { cid: newCid, metadata: metadataDoc };
  return intent;
}

export interface RemoveModuleParams {
  /** Org name or 0x id. */
  org: string;
  /** Module ID to remove (permanent — no undo). */
  module: string | number;
}

/**
 * Resolved builder for `pop education remove` — src/commands/education/remove.ts.
 * Resolves the org's EducationHub, fetches a best-effort title for the
 * confirmation summary (subgraph may lag — never blocks), and delegates to
 * buildRemoveModule. DESTRUCTIVE: hosts should require explicit confirmation.
 */
export async function removeModuleIntent(
  ctx: PopContext,
  params: RemoveModuleParams
): Promise<TxIntent> {
  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const educationHubAddress = requireModule(modules, 'educationHubAddress');
  const moduleId = parseModuleId(params.module);

  // Best-effort title for the confirmation summary (subgraph may lag).
  let title: string | undefined;
  try {
    title = await getModuleTitle(ctx.client, modules.orgId, moduleId, ctx.chainId);
  } catch { /* confirm falls back to the bare ID */ }

  return buildRemoveModule({
    educationHubAddress,
    moduleId,
    orgId: modules.orgId,
    title,
  });
}
