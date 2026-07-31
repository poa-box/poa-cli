/**
 * Task & Project Queries
 * Ported from frontend queries.js
 */

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
