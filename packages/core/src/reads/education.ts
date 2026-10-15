/**
 * Education reads — typed wrappers over the education subgraph documents.
 *
 * Ports the read layer of:
 *   - `pop education list`   — src/commands/education/list.ts
 *   - `pop education update` — src/commands/education/update.ts (read-merge query)
 *   - `pop education remove` — src/commands/education/remove.ts (title lookup)
 *
 * NOTE: the chain stores only {answerHash, payout, exists} per module; title
 * and contentHash are EVENT-ONLY, so the subgraph is the sole source for
 * current metadata. A missing row can mean "not indexed yet", not
 * "nonexistent" — existence is only provable on-chain via getModule
 * (which reverts ModuleUnknown).
 */

import { requireRawUint } from '../amounts';
import { assertSourceRef, knownFact, requireCompleteSnapshot, unknownFact, type Fact, SourceSnapshot } from '../data/facts';
import { readIndexedPageFacts, type IndexedRow } from './protocol';
import type { WorkPageOptions } from './project';
import { FETCH_MODULES_PAGE, FETCH_COMPLETIONS_PAGE } from '../graph/documents/education';
import type { GraphClient } from '../graph/client';
import { checkedIndexedTotalQuery, indexedTotalCoverage, indexedTotalIssue, readIndexedTotalState, requireIndexedTotalOptions, type IndexedTotalOptions } from '../data/indexed-completeness';
import { FETCH_ALL_COMPLETIONS_PAGE, FETCH_ALL_COMPLETIONS_STATE } from '../graph/documents/indexed-completeness';

/** Indexed education-module metadata (from the pinned IPFS doc). */
export interface EducationModuleMetadataRow {
  description: string | null;
  link: string | null;
  quiz: string[] | null;
  /** JSON-serialized string[][] — parse before use. */
  answersJson: string | null;
}

export interface EducationCompletionRow {
  learner: string;
  completedAt: string;
}

/** Raw subgraph EducationModule row (`pop education list` field set). */
export interface EducationModuleRow {
  id: string;
  moduleId: string;
  title: string | null;
  contentHash: string;
  metadata: EducationModuleMetadataRow | null;
  /** PT wei as a decimal string. */
  payout: string;
  status: string;
  createdAt: string;
  completions: EducationCompletionRow[];
}

/** Verbatim from src/commands/education/list.ts. */
export const FETCH_EDUCATION_DATA = `
  query FetchEducationData($orgId: ID!) {
    organization(id: $orgId) {
      id
      educationHub {
        id
        modules(first: 50) {
          id
          moduleId
          title
          contentHash
          metadata {
            description
            link
            quiz
            answersJson
          }
          payout
          status
          createdAt
          completions {
            learner
            completedAt
          }
        }
      }
    }
  }
`;

/**
 * Same field set as list.ts (schema-safe); title/contentHash for the merge.
 * Verbatim from src/commands/education/update.ts.
 */
export const FETCH_MODULES_FOR_UPDATE = `
  query FetchModulesForUpdate($orgId: ID!) {
    organization(id: $orgId) {
      id
      educationHub {
        id
        modules(first: 100) {
          id
          moduleId
          title
          contentHash
          payout
          metadata {
            description
            link
            quiz
            answersJson
          }
        }
      }
    }
  }
`;

/**
 * Best-effort title lookup so a destructive confirm can name the module.
 * Verbatim from src/commands/education/remove.ts.
 */
export const FETCH_MODULE_TITLE = `
  query FetchModuleTitle($orgId: ID!) {
    organization(id: $orgId) {
      educationHub {
        modules(first: 100) {
          moduleId
          title
        }
      }
    }
  }
`;

/**
 * Port of the `pop education list` read — src/commands/education/list.ts.
 * Returns the raw module rows ([] when the org has no education hub or no
 * modules indexed yet).
 */
export async function listEducationModules(
  client: GraphClient,
  orgId: string,
  chainId?: number
): Promise<EducationModuleRow[]> {
  const result = await client.query<{
    organization: { educationHub: { modules: EducationModuleRow[] } | null } | null;
  }>(FETCH_EDUCATION_DATA, { orgId }, chainId);
  return result.organization?.educationHub?.modules || [];
}

/** Row shape FETCH_MODULES_FOR_UPDATE returns (no status/completions). */
export interface EducationModuleForUpdateRow {
  id: string;
  moduleId: string;
  title: string | null;
  contentHash: string;
  payout: string;
  metadata: EducationModuleMetadataRow | null;
}

/**
 * The indexed row `pop education update` merges from — null when the module
 * is not indexed (subgraph lag) OR does not exist; only on-chain getModule
 * distinguishes the two.
 */
export async function getModuleForUpdate(
  client: GraphClient,
  orgId: string,
  moduleId: string | number,
  chainId?: number
): Promise<EducationModuleForUpdateRow | null> {
  const result = await client.query<{
    organization: { educationHub: { modules: EducationModuleForUpdateRow[] } | null } | null;
  }>(FETCH_MODULES_FOR_UPDATE, { orgId }, chainId);
  const modules = result.organization?.educationHub?.modules || [];
  return modules.find((m) => String(m.moduleId) === String(moduleId)) || null;
}

/**
 * Best-effort module title (`pop education remove` confirm summary).
 * Returns undefined when not indexed; throws on transport failure — callers
 * that only want a label should catch.
 */
export async function getModuleTitle(
  client: GraphClient,
  orgId: string,
  moduleId: string | number,
  chainId?: number
): Promise<string | undefined> {
  const result = await client.query<{
    organization: { educationHub: { modules: Array<{ moduleId: string; title: string | null }> } | null } | null;
  }>(FETCH_MODULE_TITLE, { orgId }, chainId);
  const modules = result.organization?.educationHub?.modules || [];
  return modules.find((m) => String(m.moduleId) === String(moduleId))?.title ?? undefined;
}

function educationScope(options: WorkPageOptions): { orgId: string; hub: string } {
  const source = options.source;
  assertSourceRef(source);
  if (!source.indexed || !source.orgId || !source.contract) throw new Error('Explicit indexed education org/hub required');
  return { orgId: source.orgId.toLowerCase(), hub: source.contract.toLowerCase() };
}
function validateEducationRow(row: IndexedRow, options: WorkPageOptions): void {
  const hub = row.educationHub as { id?: string; organization?: { id?: string } } | undefined;
  if (hub?.id?.toLowerCase() !== options.source.contract!.toLowerCase() || hub.organization?.id?.toLowerCase() !== options.source.orgId!.toLowerCase()) throw new Error('Education source mismatch');
  requireRawUint(row.moduleId as string);
}
/** Full library metadata; completions have their own completeness and cannot cap this list. */
export function listEducationModulesComplete(options: WorkPageOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  const variables = educationScope(options);
  return readIndexedPageFacts({ ...options, variables, document: FETCH_MODULES_PAGE, collection: 'educationModules', initialCursor: '',
    validateRow: row => { validateEducationRow(row, options); requireRawUint(row.payout as string); } });
}
export function listCompletionsComplete(options: WorkPageOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  const variables = educationScope(options);
  if (!options.source.account) throw new Error('Explicit learner account required');
  return readIndexedPageFacts({ ...options, variables: { ...variables, learner: options.source.account.toLowerCase() }, document: FETCH_COMPLETIONS_PAGE, collection: 'moduleCompletions', initialCursor: '',
    validateRow: row => {
      validateEducationRow(row, options);
      if (String(row.learner).toLowerCase() !== options.source.account!.toLowerCase()) throw new Error('Learner mismatch');
      requireRawUint(row.completedAt as string); requireRawUint(row.completedAtBlock as string);
    } });
}

function validateAllCompletionRow(row: IndexedRow, options: IndexedTotalOptions): void {
  const variables = educationScope(options);
  validateEducationRow(row, options);
  if (typeof row.learner !== 'string' || !/^0x[\da-f]{40}$/i.test(row.learner) || /^0x0{40}$/i.test(row.learner)) throw new Error('INVALID_LEARNER');
  const moduleId = requireRawUint(row.moduleId as string);
  if (row.id !== `${variables.hub}-${moduleId}-${row.learner.toLowerCase()}` || (row.module as IndexedRow)?.id !== `${variables.hub}-${moduleId}`
    || typeof row.transactionHash !== 'string' || !/^0x[\da-f]{64}$/i.test(row.transactionHash)) throw new Error('INVALID_COMPLETION_IDENTITY');
  requireRawUint(row.completedAt as string);
  if (BigInt(requireRawUint(row.completedAtBlock as string)) > BigInt(options.source.block!.number)) throw new Error('COMPLETION_AFTER_SNAPSHOT');
}
/** All learners, independently keyset-paged rather than nested under modules
 * or filtered through historical organization users. No account-scoped source
 * is accepted for an organization aggregate. */
export function listAllCompletionsComplete(options: IndexedTotalOptions): Promise<SourceSnapshot<readonly IndexedRow[]>> {
  requireIndexedTotalOptions(options);
  const variables = educationScope(options);
  if (!/^0x[\da-f]{64}$/i.test(variables.orgId)) throw new Error('EDUCATION_ORGANIZATION_SCOPE_REQUIRED');
  return readIndexedPageFacts({ ...options, query: checkedIndexedTotalQuery(options.query), variables, document: FETCH_ALL_COMPLETIONS_PAGE, collection: 'moduleCompletions', initialCursor: '',
    validateRow: row => validateAllCompletionRow(row, options) });
}

export interface EducationCompletionTotals {
  completions: Fact<string>;
  learners: Fact<string>;
  observedCompletions: string;
  observedLearners: readonly string[];
  /** The completion entity does not record the reward at completion time.
   * Multiplying by today's mutable module payout would invent history. */
  rewardTotalRaw: Fact<never>;
  evidence: { state: SourceSnapshot<IndexedRow | null>; completions: SourceSnapshot<readonly IndexedRow[]> };
}

export async function readEducationCompletionTotals(input: IndexedTotalOptions): Promise<SourceSnapshot<EducationCompletionTotals>> {
  requireIndexedTotalOptions(input);
  const variables = educationScope(input);
  const options = { ...input, query: checkedIndexedTotalQuery(input.query) };
  const state = await readIndexedTotalState(options, FETCH_ALL_COMPLETIONS_STATE, { hub: variables.hub }, 'educationHubContract', variables.hub);
  const completions = await listAllCompletionsComplete(options);
  const issues: { code: string }[] = [];
  try {
    const hub = requireCompleteSnapshot(state, { scope: input.source, indexed: true, snapshot: 'pinned', block: input.source.block });
    if (!hub || hub.id !== variables.hub || (hub.organization as IndexedRow)?.id?.toString().toLowerCase() !== variables.orgId) throw new Error('EDUCATION_HUB_SCOPE_MISMATCH');
  } catch (error) { issues.push(indexedTotalIssue(error)); }
  const coverage = indexedTotalCoverage({ state, completions }, issues);
  const source = completions.source.snapshot === 'pinned' ? completions.source : state.source;
  // Invalid diagnostic rows remain in evidence but never add observed identities.
  const rows = completions.data.filter(row => {
    try { validateAllCompletionRow(row, options); return true; } catch { return false; }
  });
  const observedCompletions = String(rows.length), observedLearners = [...new Set(rows.map(row => String(row.learner).toLowerCase()))].sort();
  return { source, coverage, data: { observedCompletions, observedLearners,
    completions: coverage.status === 'complete' ? knownFact(observedCompletions, source) : unknownFact('EDUCATION_TOTAL_INCOMPLETE', source),
    learners: coverage.status === 'complete' ? knownFact(String(observedLearners.length), source) : unknownFact('EDUCATION_TOTAL_INCOMPLETE', source),
    rewardTotalRaw: unknownFact('COMPLETION_PAYOUT_NOT_INDEXED', source), evidence: { state, completions } } };
}
