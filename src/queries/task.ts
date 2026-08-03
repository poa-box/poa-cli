/**
 * Task & Project Queries
 * Ported from frontend queries.js
 */

import type { FieldFallbackTier } from '../lib/subgraph';

export const FETCH_PROJECTS_DATA = `
  query FetchProjectsDataNew($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      taskManager {
        id
        creatorHatIds
        projects(where: { deleted: false }, first: 50) {
          id
          title
          metadataHash
          metadata {
            id
            description
          }
          cap
          bountyCaps {
            token
            cap
          }
          createdAt
          tasks(first: 1000, orderBy: taskId, orderDirection: desc) {
            id
            taskId
            title
            metadataHash
            submissionHash
            rejectionHash
            rejectionCount
            metadata {
              id
              name
              description
              location
              difficulty
              estimatedHours
              dueDate
              submission
              rejection
            }
            rejections(orderBy: rejectedAt, orderDirection: desc, first: 10) {
              rejectorUsername
              rejectedAt
              metadata {
                rejection
              }
            }
            payout
            bountyToken
            bountyPayout
            completionWindow
            absoluteDeadline
            claimDeadline
            reclaimCount
            status
            assignee
            assigneeUsername
            completer
            completerUsername
            requiresApplication
            createdAt
            assignedAt
            submittedAt
            completedAt
            applications {
              applicant
              applicantUsername
              applicationHash
              metadata {
                notes
                experience
              }
              approved
              approver
              approverUsername
              appliedAt
            }
          }
        }
      }
    }
  }
`;

/**
 * FETCH_PROJECTS_DATA without the TaskManager v6 deadline fields (subgraph #192).
 *
 * A GraphQL document validates as a whole, so one unknown field fails the entire query. When
 * this tier serves, callers fall back to reading deadlines on-chain via the task lens.
 * Derived by deletion so the two cannot drift apart.
 */
export const FETCH_PROJECTS_DATA_LEGACY = FETCH_PROJECTS_DATA
  .split('\n')
  .filter((line) => !/^\s*(completionWindow|absoluteDeadline|claimDeadline|reclaimCount)\s*$/.test(line))
  .join('\n');

/**
 * FETCH_PROJECTS_DATA plus the claim-release fields (subgraph #201, TaskManager v7).
 *
 * GNOSIS ONLY as of 2026-08-02. Verified live that poa-arb-v-1 rejects the document with
 * ``Type `Task` has no field `releaseCount``` — which `isUnknownFieldError` matches on
 * /has no field/i, so the tier drops cleanly to FETCH_PROJECTS_DATA. TaskManager v7 itself
 * IS live on Arbitrum; it is only the indexing that has not shipped there.
 *
 * Both fields are structurally present but zero/null on every live Gnosis row (v7 shipped,
 * no release has happened yet), so callers must gate rendering on the SERVED TIER, never on
 * truthiness — `releaseCount: 0` ("indexed, never released") has to stay distinguishable
 * from absent ("not indexed").
 *
 * Built by INSERTION, not by deletion like FETCH_PROJECTS_DATA_LEGACY: that idiom would
 * silently no-op if a field were ever reflowed onto a shared line, leaving the "rich" tier
 * byte-identical to the tier it exists to improve on. The task-release-tiers test asserts
 * tier 0 is strictly longer than tier 1 for exactly this reason.
 */
export const FETCH_PROJECTS_DATA_WITH_RELEASES = FETCH_PROJECTS_DATA.replace(
  /^(\s*)reclaimCount$/m,
  '$1reclaimCount\n$1releaseCount\n$1lastReleasedAt',
);

/**
 * Tier order for consumers that want release data. Every consumer of the shared projects
 * document that does NOT need releases must keep using bare `query(FETCH_PROJECTS_DATA)` —
 * adding the v7 fields there would break those call sites outright on Arbitrum for no gain.
 */
export const PROJECTS_DATA_TIERS = [
  FETCH_PROJECTS_DATA_WITH_RELEASES, // 0: Gnosis — v6 deadlines + v7 releases
  FETCH_PROJECTS_DATA,               // 1: Arbitrum today — v6 deadlines, no releases
  FETCH_PROJECTS_DATA_LEGACY,        // 2: deployments predating subgraph #192
];

/** Build the tier array for `queryWithFieldFallback`. */
export function projectsDataTiers(orgId: string): FieldFallbackTier[] {
  return PROJECTS_DATA_TIERS.map((query) => ({ query, variables: { orgId } }));
}

/**
 * Chains whose deployed subgraph indexes `TaskUnclaimed` (subgraph #201).
 *
 * TaskManager v7 is live on EVERY chain — verified 2026-08-02, byte-identical
 * implementation on Gnosis and Arbitrum — but only the Gnosis subgraph has the
 * handler. So a release on any other chain succeeds on-chain and is then
 * invisible to every read surface: the task keeps showing as claimed by the
 * previous assignee, with `assignee`/`assignedAt` never cleared.
 *
 * Deliberately a chain-id allowlist rather than a runtime probe: `task unclaim`
 * must be able to warn even under `--no-preflight`, with no extra round-trip.
 * Delete an entry here only when that chain's subgraph is genuinely upgraded.
 */
export const TASK_RELEASE_INDEXING_CHAIN_IDS: ReadonlySet<number> = new Set([100]);

/** Whether `chainId`'s subgraph indexes task releases. Unknown chains: assume not. */
export function chainIndexesTaskReleases(chainId: number | undefined): boolean {
  return chainId !== undefined && TASK_RELEASE_INDEXING_CHAIN_IDS.has(chainId);
}

/**
 * One task's full release history (subgraph #201). Issued only when the shared document
 * already reported `releaseCount > 0`, so the common path stays at one round-trip.
 *
 * `$taskId` is the Task ENTITY id — `<lowercased taskManager address>-<numeric task id>`,
 * not the bare numeric id.
 *
 * Every variable is scalar and the ordering args are inline on purpose: an `orderBy`/`where`
 * that a deployment does not know produces ``Invalid value provided for argument `where``` /
 * ``Variable `w` must have an input type``, and NONE of `isUnknownFieldError`'s regexes match
 * those — they would escape the tier machinery and kill the command outright.
 */
export const FETCH_TASK_RELEASE_HISTORY = `
  query FetchTaskReleaseHistory($taskId: ID!, $first: Int!) {
    task(id: $taskId) {
      id
      taskId
      status
      releaseCount
      lastReleasedAt
      releases(first: $first, orderBy: releasedAt, orderDirection: desc) {
        id
        previousClaimer
        previousClaimerUsername
        caller
        callerUsername
        selfRelease
        releasedAt
        releasedAtBlock
        transactionHash
      }
    }
  }
`;

/**
 * Tier 1 for the history read: deliberately minimal so `queryWithFieldFallback` resolves
 * with tierIndex 1 ("release history not indexed here") instead of rethrowing the validation
 * error, which is what it does when the LAST tier also fails.
 */
export const FETCH_TASK_RELEASE_HISTORY_LEGACY = `
  query FetchTaskReleaseHistoryLegacy($taskId: ID!) {
    task(id: $taskId) {
      id
      taskId
      status
    }
  }
`;

/**
 * Org-wide recent releases (subgraph #201).
 *
 * Org scoping MUST route through the nested `task_` join: `TaskRelease` carries no org field
 * and `Project` has no `organization` field. `$taskManager` must be LOWERCASED — a
 * checksummed address returns `[]` silently rather than erroring.
 */
export const FETCH_ORG_TASK_RELEASES = `
  query FetchOrgTaskReleases($taskManager: Bytes!, $first: Int!, $skip: Int!) {
    taskReleases(
      where: { task_: { taskManager: $taskManager } }
      orderBy: releasedAt
      orderDirection: desc
      first: $first
      skip: $skip
    ) {
      id
      previousClaimer
      previousClaimerUsername
      caller
      callerUsername
      selfRelease
      releasedAt
      transactionHash
      task {
        id
        taskId
        title
        status
        releaseCount
      }
    }
  }
`;
