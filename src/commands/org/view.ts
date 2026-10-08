import { resolveOrgId } from '../../lib/resolve';
import { refreshAuthorityUsers } from '../../lib/authority';
import { FETCH_AUTHORITY_SUBJECTS, readAuthorityRows } from '@poa-box/core/reads/authority';
import { subgraphModuleClient } from '../../lib/subgraph-module-client';
import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { query } from '../../lib/subgraph';
import { fetchJson } from '../../lib/ipfs';
import { FETCH_ORG_FULL_DATA } from '../../queries/org';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../queries/infrastructure';
import type { InfrastructureAddresses } from '../../queries/infrastructure';
import { createReadContract } from '../../lib/contracts';
import { resolveNetworkConfig } from '../../config/networks';
import { formatAddress } from '../../lib/encoding';
import * as output from '../../lib/output';

interface ViewArgs {
  org: string;
  chain?: number;
}

/**
 * Current metadata-admin hat (0 = unset → topHat fallback).
 *
 * Subgraph-first: Organization.metadataAdminHatId already comes back with
 * FETCH_ORG_FULL_DATA, is rewritten by handleOrgMetadataAdminHatSet on every
 * OrgMetadataAdminHatSet event, and is non-null on every live org (all 9 on
 * Gnosis, the 1 on Arbitrum). Spot-checked against
 * OrgRegistry.getOrgMetadataAdminHat on Gnosis: identical value. Serving it
 * from the org document we already fetched removes both the extra
 * infrastructure query (whose only purpose here was resolving the OrgRegistry
 * address) and the eth_call.
 *
 * Only when the subgraph has no value do we resolve the OrgRegistry and read
 * the on-chain getter (verified in src/abi/OrgRegistry.json). Returns null
 * when neither source is reachable; never throws.
 */
async function readMetadataAdminHat(org: any, chainId?: number): Promise<string | null> {
  if (org.metadataAdminHatId !== undefined && org.metadataAdminHatId !== null) {
    return String(org.metadataAdminHatId);
  }
  try {
    const infra = await query<InfrastructureAddresses>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, chainId);
    const orgRegistryAddr = infra.poaManagerContracts?.[0]?.orgRegistryProxy;
    if (!orgRegistryAddr) throw new Error('no OrgRegistry address');
    const netConfig = resolveNetworkConfig(chainId);
    const provider = new ethers.providers.JsonRpcProvider(netConfig.resolvedRpc, netConfig.chainId);
    const registry = createReadContract(orgRegistryAddr, 'OrgRegistry', provider);
    const hat = await registry.getOrgMetadataAdminHat(org.id);
    return hat.toString();
  } catch {
    return null;
  }
}

export const viewHandler = {
  builder: (yargs: Argv) => yargs
    .example('pop org view --org myorg', 'Modules, roles, token, and voting config for an org (by name)')
    .example('pop org view --org 0x… --json', 'Machine-readable org snapshot (by hex ID)'),

  handler: async (argv: ArgumentsCamelCase<ViewArgs>) => {
    const spin = output.spinner('Fetching organization...');
    spin.start();

    try {
      const orgId = await resolveOrgId(argv.org, argv.chain);

      const result = await query<any>(FETCH_ORG_FULL_DATA, { orgId }, argv.chain);
      const org = result.organization;

      if (!org) {
        spin.stop();
        output.error(`Organization ${orgId} not found`);
        process.exit(1);
        return;
      }

      const subjects = await readAuthorityRows(subgraphModuleClient(), orgId, FETCH_AUTHORITY_SUBJECTS, 'subjects', argv.chain);
      await refreshAuthorityUsers(org, orgId, argv.chain);
      const roles = subjects.map(subject => ({
        hatId: subject.subjectId, subjectId: subject.subjectId, name: subject.name,
        kind: subject.kind, canVoteSource: 'historical role metadata',
        canVote: org.roles?.find((role: any) => role.hatId === subject.subjectId)?.canVote ?? false,
      }));
      const memberCount = org.users.filter((user: any) => user.membershipStatus === 'Active').length;

      // Fetch IPFS metadata if available
      let metadata = org.metadata || null;
      if (!metadata && org.metadataHash) {
        try {
          metadata = await fetchJson(org.metadataHash);
        } catch { /* ignore */ }
      }

      const metadataAdminHat = await readMetadataAdminHat(org, argv.chain);

      spin.stop();

      if (output.isJsonMode()) {
        output.json({
          id: org.id,
          name: org.name,
          description: metadata?.description,
          template: metadata?.template,
          logo: metadata?.logo,
          links: metadata?.links,
          deployedAt: org.deployedAt,
          topHatId: org.topHatId,
          metadataAdminHat,
          modules: {
            taskManager: org.taskManager?.id,
            hybridVoting: org.hybridVoting?.id,
            directDemocracyVoting: org.directDemocracyVoting?.id,
            participationToken: org.participationToken?.id,
            educationHub: org.educationHub?.id,
            executor: org.executorContract?.id,
            quickJoin: org.quickJoin?.id,
            membershipAuthority: org.membershipAuthority?.id,
            paymentManager: org.paymentManager?.id,
            zkEmailInvites: org.zkEmailInvites?.id,
          },
          tokenInfo: org.participationToken ? {
            name: org.participationToken.name,
            symbol: org.participationToken.symbol,
            totalSupply: org.participationToken.totalSupply,
          } : null,
          votingConfig: {
            hybrid: org.hybridVoting ? {
              threshold: org.hybridVoting.thresholdPct,
              quorum: org.hybridVoting.quorum,
            } : null,
            dd: org.directDemocracyVoting ? {
              threshold: org.directDemocracyVoting.thresholdPct,
              quorum: org.directDemocracyVoting.quorum,
            } : null,
          },
          roles,
          memberCount,
          projectCount: (org.taskManager?.projects || []).length,
        });
      } else {
        console.log('');
        console.log(`  Organization: ${org.name || 'Unnamed'}`);
        console.log(`  ID: ${org.id}`);
        if (metadata?.description) console.log(`  Description: ${metadata.description}`);
        if (org.deployedAt) console.log(`  Deployed: ${new Date(parseInt(org.deployedAt) * 1000).toLocaleString()}`);
        if (metadataAdminHat !== null) {
          console.log(`  Metadata admin hat: ${metadataAdminHat === '0' ? 'not set (topHat fallback)' : metadataAdminHat}`);
        }
        console.log('');

        console.log('  Modules:');
        if (org.taskManager) console.log(`    TaskManager:   ${org.taskManager.id}`);
        if (org.hybridVoting) console.log(`    HybridVoting:  ${org.hybridVoting.id} (threshold: ${org.hybridVoting.thresholdPct}%, quorum: ${org.hybridVoting.quorum}%)`);
        if (org.directDemocracyVoting) console.log(`    DD Voting:     ${org.directDemocracyVoting.id} (threshold: ${org.directDemocracyVoting.thresholdPct}%, quorum: ${org.directDemocracyVoting.quorum}%)`);
        if (org.participationToken) console.log(`    Token:         ${org.participationToken.name} (${org.participationToken.symbol}), supply: ${ethers.utils.formatUnits(org.participationToken.totalSupply || '0', 18)}`);
        if (org.executorContract) console.log(`    Executor:      ${org.executorContract.id}`);
        if (org.quickJoin) console.log(`    QuickJoin:     ${org.quickJoin.id}`);
        if (org.educationHub) console.log(`    EducationHub:  ${org.educationHub.id}`);
        if (org.membershipAuthority) console.log(`    Authority:     ${org.membershipAuthority.id}`);
        if (org.paymentManager) console.log(`    Payments:      ${org.paymentManager.id}`);
        console.log('');

        if (roles.length) {
          console.log('  Roles:');
          for (const role of roles) {
            console.log(`    - ${role.name || 'Unnamed'} (subject: ${role.hatId})`);
          }
          console.log('');
        }

        console.log(`  Members: ${memberCount}`);
        console.log(`  Projects: ${(org.taskManager?.projects || []).length}`);

        if (metadata?.links?.length) {
          console.log('  Links:');
          for (const link of metadata.links) {
            console.log(`    - ${link.name}: ${link.url}`);
          }
        }
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
