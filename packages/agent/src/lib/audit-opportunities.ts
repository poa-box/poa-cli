import { ethers } from 'ethers';
import { queryAllChains } from '@poa-box/cli/lib/subgraph';
import { createIndexedSource } from '@poa-box/cli/lib/indexed-source';
import { readCurrentMemberTotals, readProposalArchive, requireCompleteSnapshot } from '@poa-box/cli/lib/protocol-reads';
import type { Coverage, SourceRef } from '@poa-box/cli/lib/protocol-reads';

interface DiscoveredOrg {
  id: string; name: string;
  membershipAuthority?: { id: string } | null;
  hybridVoting?: { id: string } | null;
  directDemocracyVoting?: { id: string } | null;
}
export interface AuditOpportunity {
  orgId: string; orgName: string; chainId: number; chainName: string; currentMembers: string;
  proposals: { hybrid: '0'; dd: '0' };
  sources: { members: SourceRef; hybrid: SourceRef; dd: SourceRef };
  coverage: { members: Coverage; hybrid: Coverage; dd: Coverage };
}
const discovery = `query AuditCandidates($first: Int!) {
  organizations(first: $first) { id name membershipAuthority { id } hybridVoting { id } directDemocracyVoting { id } }
}`;
const bounds = { pageSize: 100, maxPages: 100 };
// A complete empty first page proves absence. Any nonempty page already
// disqualifies this candidate, so historical archives need no further paging.
const archiveBounds = { pageSize: 1, maxPages: 1 };
const nonzeroAddress = (value: unknown): value is string => typeof value === 'string'
  && ethers.utils.isAddress(value) && value.toLowerCase() !== ethers.constants.AddressZero;

/** Bounded discovery supplies candidates only. Every suggested absence is
 * independently proven by current authority totals and BOTH complete voting
 * archives at one endpoint/block; failed/capped reads produce no suggestion. */
export async function findAuditOpportunities(): Promise<AuditOpportunity[]> {
  const opportunities: AuditOpportunity[] = [];
  const chains = await queryAllChains<{ organizations: DiscoveredOrg[] }>(discovery, { first: 10 });
  for (const chain of chains) {
    if (chain.error || !Array.isArray(chain.data?.organizations)) continue;
    for (const org of chain.data!.organizations) {
      if (typeof org.name !== 'string' || org.name === 'Argus' || /^test/i.test(org.name)
        || !ethers.utils.isHexString(org.id, 32)) continue;
      const authority = org.membershipAuthority?.id, hybrid = org.hybridVoting?.id, dd = org.directDemocracyVoting?.id;
      if (!nonzeroAddress(authority) || !nonzeroAddress(hybrid) || !nonzeroAddress(dd)) continue;
      try {
        const adapter = await createIndexedSource({ chainId: chain.chainId, orgId: org.id, contract: authority });
        const [members, hybridArchive, ddArchive] = await Promise.all([
          readCurrentMemberTotals({ source: adapter.source, query: adapter.protocolQuery, ...bounds }),
          readProposalArchive({ source: { ...adapter.source, contract: hybrid }, query: adapter.protocolQuery, lane: 'hybrid', ...archiveBounds }),
          readProposalArchive({ source: { ...adapter.source, contract: dd }, query: adapter.protocolQuery, lane: 'dd', ...archiveBounds }),
        ]);
        const checked = <T>(snapshot: { source: SourceRef; coverage: Coverage; data: T }, contract: string) => requireCompleteSnapshot(snapshot, {
          scope: { chainId: chain.chainId, orgId: org.id, contract, endpoint: adapter.source.endpoint },
          indexed: true, snapshot: 'pinned', block: adapter.source.block,
        });
        const current = checked(members, authority), hybridRows = checked(hybridArchive, hybrid), ddRows = checked(ddArchive, dd);
        if (current.total.state !== 'known' || !/^(0|[1-9]\d*)$/.test(current.total.value)
          || BigInt(current.total.value) < 3n || hybridRows.length || ddRows.length) continue;
        opportunities.push({ orgId: org.id, orgName: org.name, chainId: chain.chainId, chainName: chain.name,
          currentMembers: current.total.value, proposals: { hybrid: '0', dd: '0' },
          sources: { members: members.source, hybrid: hybridArchive.source, dd: ddArchive.source },
          coverage: { members: members.coverage, hybrid: hybridArchive.coverage, dd: ddArchive.coverage } });
      } catch { /* Unknown membership/history cannot establish an audit opportunity. */ }
    }
  }
  return opportunities;
}
