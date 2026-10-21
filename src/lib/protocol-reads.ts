/** Shared core readers exposed through the CLI's supported deep-import surface.
 * Agent runtime policy stays in @poa-box/agent; these are unmodified core APIs. */
export { fetchProjectsData } from '@poa-box/core/reads/task';
export { readAuthorityUsers } from '@poa-box/core/reads/authority';
export { readProposalArchive, readProposalBallotFacts } from '@poa-box/core/reads/vote';
export { readDistributionHistoryFacts, readDistributionClaimFacts } from '@poa-box/core/reads/treasury';
export { readCurrentMemberTotals } from '@poa-box/core/reads/member-totals';
export type { SourceRef, SourceSnapshot, Coverage } from '@poa-box/core/data/facts';
export { requireCompleteSnapshot } from '@poa-box/core/data/facts';
export { remainingBudget } from '@poa-box/core/sponsorship/budget';
export { paymasterSubjectKey, SUBJECT_TYPE } from '@poa-box/core/sponsorship/codec';
