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

import type { GraphClient } from '../graph/client';

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
  query FetchEducationData($orgId: Bytes!) {
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
  query FetchModulesForUpdate($orgId: Bytes!) {
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
  query FetchModuleTitle($orgId: Bytes!) {
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
