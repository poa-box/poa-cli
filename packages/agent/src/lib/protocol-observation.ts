import { query } from '@poa-box/cli/lib/subgraph';
import { subgraphModuleClient } from '@poa-box/cli/lib/subgraph-module-client';
import { createIndexedSource } from '@poa-box/cli/lib/indexed-source';
import { fetchProjectsData, readAuthorityUsers, readProposalArchive, readProposalBallotFacts,
  readDistributionHistoryFacts, readDistributionClaimFacts, readCurrentMemberTotals } from '@poa-box/cli/lib/protocol-reads';
import type { OrgModules } from '@poa-box/cli/lib/resolve';

export interface ObservationCoverage {
  status: 'complete' | 'incomplete' | 'unavailable';
  code?: string;
  snapshot?: string;
  atomic?: boolean;
  hasReleaseData?: boolean;
  hasDeadlineData?: boolean;
}
const unavailable = (code: string): ObservationCoverage => ({ status: 'unavailable', code });
const complete: ObservationCoverage = { status: 'complete' };
const bounds = { pageSize: 100, maxPages: 100 };

/** Bounded observations are suggestions, never signing authority. Every stream
 * retains its own completeness; failures cannot make an empty board or an
 * absent ballot look proven. No signer, pinning adapter, or write API is used. */
export async function observeAgentProtocol(modules: OrgModules, chainId: number) {
  const client = subgraphModuleClient();
  const summary = await query<any>(`query AgentSummary($orgId: Bytes!) {
    organization(id: $orgId) { name participationToken { totalSupply } }
  }`, { orgId: modules.orgId }, chainId);
  if (!summary.organization) throw new Error('Organization not found');
  const org: any = { ...summary.organization, users: [], taskManager: { projects: [] },
    hybridVoting: { proposals: [] }, directDemocracyVoting: { ddvProposals: [] },
    paymentManager: { distributions: [] } };
  const coverage: Record<string, ObservationCoverage> = {};
  const sources: Record<string, unknown> = {};
  let hasReleaseData = false;
  let memberTotal: string | null = null;

  await Promise.all([
    (async () => {
      try {
        org.users = await readAuthorityUsers(client, modules.orgId, [], chainId);
        coverage.members = { ...complete, snapshot: 'latest', atomic: false };
        sources.members = { chainId, orgId: modules.orgId, snapshot: 'latest', atomic: false };
      }
      catch { coverage.members = unavailable('AUTHORITY_MEMBERSHIP_UNAVAILABLE'); }
    })(),
    (async () => {
      if (!modules.taskManagerAddress) { coverage.tasks = unavailable('TASK_MANAGER_UNAVAILABLE'); return; }
      try {
        const result = await fetchProjectsData(client, modules.orgId, chainId);
        if (!result.data.organization?.taskManager) throw new Error('Task manager unavailable');
        org.taskManager = result.data.organization.taskManager;
        hasReleaseData = result.hasReleaseData;
        coverage.tasks = { ...complete, snapshot: 'latest', atomic: false, hasReleaseData,
          hasDeadlineData: result.hasDeadlineData };
        sources.tasks = { chainId, orgId: modules.orgId, snapshot: 'latest', atomic: false };
      } catch { coverage.tasks = unavailable('TASK_BOARD_UNAVAILABLE'); }
    })(),
    (async () => {
      if (!modules.membershipAuthorityAddress) { coverage.memberTotal = unavailable('AUTHORITY_UNAVAILABLE'); return; }
      try {
        const adapter = await createIndexedSource({ chainId, orgId: modules.orgId, contract: modules.membershipAuthorityAddress });
        const snapshot = await readCurrentMemberTotals({ source: adapter.source, query: adapter.protocolQuery, ...bounds });
        sources.memberTotal = snapshot.source;
        coverage.memberTotal = snapshot.coverage;
        memberTotal = snapshot.data.total.state === 'known' ? snapshot.data.total.value : null;
      } catch { coverage.memberTotal = unavailable('CURRENT_MEMBER_TOTAL_UNAVAILABLE'); }
    })(),
    ...(['hybrid', 'dd'] as const).map(async lane => {
      const contract = lane === 'hybrid' ? modules.hybridVotingAddress : modules.ddVotingAddress;
      if (!contract) { coverage[lane] = unavailable('VOTING_MODULE_UNAVAILABLE'); return; }
      try {
        const adapter = await createIndexedSource({ chainId, orgId: modules.orgId, contract });
        const snapshot = await readProposalArchive({ source: adapter.source, query: adapter.protocolQuery, lane, ...bounds });
        coverage[lane] = snapshot.coverage;
        sources[lane] = snapshot.source;
        // Invalid or partial archive rows are diagnostic evidence, not actionable proposals.
        const rows: any[] = snapshot.coverage.status === 'complete' ? snapshot.data.map(row => ({ ...row, lane, votes: [], ballotCoverage: unavailable('BALLOTS_NOT_REQUESTED') })) : [];
        const active = rows.filter(row => row.status === 'Active' && row.winningOption == null);
        // Explicit detail budget; overflow stays unknown rather than unvoted.
        for (let offset = 0; offset < Math.min(active.length, 100); offset += 5) {
          await Promise.all(active.slice(offset, Math.min(offset + 5, 100)).map(async row => {
            try {
              const ballots = await readProposalBallotFacts({ source: adapter.source, query: adapter.protocolQuery,
                lane, proposalId: String(row.proposalId), ...bounds });
              row.ballotCoverage = ballots.coverage;
              if (ballots.coverage.status === 'complete') row.votes = ballots.data;
            } catch { row.ballotCoverage = unavailable('BALLOTS_UNAVAILABLE'); }
          }));
        }
        if (lane === 'hybrid') org.hybridVoting.proposals = rows;
        else org.directDemocracyVoting.ddvProposals = rows;
      } catch { coverage[lane] = unavailable('PROPOSAL_ARCHIVE_UNAVAILABLE'); }
    }),
    (async () => {
      if (!modules.paymentManagerAddress) { coverage.distributions = unavailable('PAYMENT_MANAGER_UNAVAILABLE'); return; }
      try {
        const adapter = await createIndexedSource({ chainId, orgId: modules.orgId, contract: modules.paymentManagerAddress });
        const snapshot = await readDistributionHistoryFacts({ source: adapter.source, query: adapter.protocolQuery, ...bounds });
        coverage.distributions = snapshot.coverage; sources.distributions = snapshot.source;
        const rows: any[] = snapshot.coverage.status === 'complete'
          ? snapshot.data.filter(row => row.status === 'Active').map(row => ({ ...row, claims: [], claimCoverage: unavailable('CLAIMS_NOT_REQUESTED') })) : [];
        for (let offset = 0; offset < Math.min(rows.length, 100); offset += 5) {
          await Promise.all(rows.slice(offset, Math.min(offset + 5, 100)).map(async row => {
            try {
              const claims = await readDistributionClaimFacts({ source: adapter.source, query: adapter.protocolQuery,
                distributionId: String(row.distributionId), ...bounds });
              row.claimCoverage = claims.coverage;
              if (claims.coverage.status === 'complete') row.claims = claims.data;
            } catch { row.claimCoverage = unavailable('CLAIMS_UNAVAILABLE'); }
          }));
        }
        org.paymentManager.distributions = rows;
      } catch { coverage.distributions = unavailable('DISTRIBUTION_HISTORY_UNAVAILABLE'); }
    })(),
  ]);
  return { org, coverage, sources, hasReleaseData, memberTotal };
}
