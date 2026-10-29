/** Library and learner history cursors are independent; rewards stay raw decimal strings. */
export const FETCH_MODULES_PAGE = `
  query ModulesPage($orgId: String!, $hub: String!, $cursor: String!, $first: Int!, $block: Block_height) {
    _meta(block: $block) { block { number hash timestamp } }
    educationModules(where: { educationHub: $hub, educationHub_: { organization: $orgId }, id_gt: $cursor }, first: $first, orderBy: id, orderDirection: asc, block: $block) {
      id moduleId title contentHash payout status createdAt educationHub { id organization { id } }
      metadata { description link quiz answersJson }
    }
  }
`;
export const FETCH_COMPLETIONS_PAGE = `
  query CompletionsPage($orgId: String!, $hub: String!, $learner: Bytes!, $cursor: String!, $first: Int!, $block: Block_height) {
    _meta(block: $block) { block { number hash timestamp } }
    moduleCompletions(where: { educationHub: $hub, educationHub_: { organization: $orgId }, learner: $learner, id_gt: $cursor }, first: $first, orderBy: id, orderDirection: asc, block: $block) {
      id moduleId learner completedAt completedAtBlock transactionHash module { id } educationHub { id organization { id } }
    }
  }
`;
