/**
 * pop org status — quick org health summary (+ module version panel).
 *
 * The version panel compares each deployed module proxy's implementation
 * (EIP-1967 beacon/impl slots via lib/version.getImplementation) against
 * the protocol's latest for that module type:
 *   PoaManager.getCurrentImplementationById(keccak256(typeName))
 * TypeName strings and typeId derivation VERIFIED against contracts
 * origin/main src/libs/ModuleTypes.sol (typeId = keccak256(bytes(typeName)))
 * and script/deploy/DeployInfrastructure.s.sol (addContractType calls).
 *
 * A module that is behind is annotated with OrgRegistry.isAutoUpgrade
 * (contractId = keccak256(abi.encodePacked(orgId, typeId)) — verified
 * against OrgRegistry.sol registerOrgContract) so a pinned beacon reads
 * "autoUpgrade off — beacon pinned". isAutoUpgrade reverts ContractUnknown
 * for unregistered contracts, so that read degrades to impl-vs-latest only.
 *
 * The whole panel is best-effort: any RPC/subgraph failure degrades to a
 * one-line note, and --fast skips it entirely. JSON output is additive:
 * `moduleVersions` / `moduleVersionsError` appear alongside the existing
 * fields.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { query } from '../../lib/subgraph';
import { resolveOrgModules, OrgModules } from '../../lib/resolve';
import { getImplementation } from '../../lib/version';
import { createReadContract } from '../../lib/contracts';
import { resolveNetworkConfig } from '../../config/networks';
import { FETCH_ORG_ACTIVITY } from '../../queries/activity';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../queries/infrastructure';
import type { InfrastructureAddresses } from '../../queries/infrastructure';
import * as output from '../../lib/output';

interface StatusArgs {
  org?: string;
  chain?: number;
  fast?: boolean;
}

/**
 * Org module → PoaManager contract-type name. TypeName strings verified
 * against contracts origin/main (ModuleTypes.sol + DeployInfrastructure).
 */
export const MODULE_TYPES: Array<{ key: keyof OrgModules; label: string; typeName: string }> = [
  { key: 'taskManagerAddress', label: 'TaskManager', typeName: 'TaskManager' },
  { key: 'hybridVotingAddress', label: 'HybridVoting', typeName: 'HybridVoting' },
  { key: 'ddVotingAddress', label: 'DDVoting', typeName: 'DirectDemocracyVoting' },
  { key: 'participationTokenAddress', label: 'ParticipationToken', typeName: 'ParticipationToken' },
  { key: 'educationHubAddress', label: 'EducationHub', typeName: 'EducationHub' },
  { key: 'paymentManagerAddress', label: 'PaymentManager', typeName: 'PaymentManager' },
  { key: 'quickJoinAddress', label: 'QuickJoin', typeName: 'QuickJoin' },
  { key: 'eligibilityModuleAddress', label: 'EligibilityModule', typeName: 'EligibilityModule' },
];

export interface ModuleVersionRow {
  module: string;
  typeName: string;
  proxy: string;
  implementation: string | null;
  latestImplementation: string | null;
  upToDate: boolean | null;
  /** null when the OrgRegistry read failed/reverted (e.g. ContractUnknown) */
  autoUpgrade: boolean | null;
}

/**
 * Build the module version rows for every module the org has deployed.
 * Individual module failures degrade that row (nulls); only total
 * infrastructure failure should be handled by the caller's try/catch.
 */
export async function buildVersionPanel(
  provider: ethers.providers.Provider,
  modules: OrgModules,
  infra: { poaManagerAddress: string; orgRegistryAddress: string | null }
): Promise<ModuleVersionRow[]> {
  const poaManager = createReadContract(infra.poaManagerAddress, 'PoaManager', provider);
  const orgRegistry = infra.orgRegistryAddress
    ? createReadContract(infra.orgRegistryAddress, 'OrgRegistry', provider)
    : null;

  const present = MODULE_TYPES.filter(m => typeof modules[m.key] === 'string' && modules[m.key]);

  return Promise.all(present.map(async (m): Promise<ModuleVersionRow> => {
    const proxy = modules[m.key] as string;
    const typeId = ethers.utils.id(m.typeName); // keccak256(bytes(typeName))

    const [implementation, latestImplementation, autoUpgrade] = await Promise.all([
      getImplementation(provider, proxy).catch(() => null),
      poaManager.getCurrentImplementationById(typeId).then((a: string) => a).catch(() => null),
      orgRegistry
        ? orgRegistry.isAutoUpgrade(
            // contractId = keccak256(abi.encodePacked(orgId, typeId))
            ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [modules.orgId, typeId])
          ).then((b: boolean) => b).catch(() => null)
        : Promise.resolve(null),
    ]);

    return {
      module: m.label,
      typeName: m.typeName,
      proxy,
      implementation,
      latestImplementation,
      upToDate: implementation && latestImplementation
        ? implementation.toLowerCase() === latestImplementation.toLowerCase()
        : null,
      autoUpgrade,
    };
  }));
}

/** Human status label for one version row. */
export function versionStatusLabel(row: ModuleVersionRow): string {
  if (row.upToDate === null) return 'version unknown (read failed)';
  if (row.upToDate) return 'up to date';
  if (row.autoUpgrade === false) return '1+ versions behind (autoUpgrade off — beacon pinned)';
  if (row.autoUpgrade === true) return '1+ versions behind (autoUpgrade on — beacon should catch up)';
  return '1+ versions behind latest';
}

export const statusHandler = {
  builder: (yargs: Argv) => yargs
    .option('fast', {
      type: 'boolean',
      default: false,
      describe: 'Skip the on-chain module version check (subgraph summary only)',
    })
    .example('pop org status', 'Health summary + module version panel')
    .example('pop org status --fast --json', 'Fastest machine-readable summary (no RPC reads)'),

  handler: async (argv: ArgumentsCamelCase<StatusArgs>) => {
    const spin = output.spinner('Fetching org status...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);

      const result = await query<any>(FETCH_ORG_ACTIVITY, {
        orgId: modules.orgId,
        hybridVotingId: modules.hybridVotingAddress || '',
        eligibilityModuleId: modules.eligibilityModuleAddress || '',
        tokenAddress: modules.participationTokenAddress || '',
      }, argv.chain);

      const org = result.organization;
      if (!org) {
        spin.stop();
        output.error('Organization not found');
        process.exit(1);
        return;
      }

      // ── Module version panel (best-effort; --fast skips) ──────────────
      let versionRows: ModuleVersionRow[] | null = null;
      let versionError: string | null = null;
      if (!argv.fast) {
        spin.text = 'Checking module versions...';
        try {
          const infra = await query<InfrastructureAddresses>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, argv.chain);
          const poaManagerAddress = infra.poaManagerContracts?.[0]?.id;
          if (!poaManagerAddress) throw new Error('PoaManager address not indexed');
          const netConfig = resolveNetworkConfig(argv.chain);
          const provider = new ethers.providers.JsonRpcProvider(netConfig.resolvedRpc, netConfig.chainId);
          versionRows = await buildVersionPanel(provider, modules, {
            poaManagerAddress,
            orgRegistryAddress: infra.poaManagerContracts?.[0]?.orgRegistryProxy || null,
          });
        } catch (err: any) {
          versionRows = null;
          versionError = `module version check unavailable (${err?.message || 'RPC error'})`;
        }
      }

      spin.stop();

      // Count tasks
      const allTasks: any[] = [];
      for (const project of org.taskManager?.projects || []) {
        for (const task of project.tasks || []) {
          allTasks.push(task);
        }
      }
      const taskStats = {
        open: allTasks.filter(t => t.status === 'Open').length,
        assigned: allTasks.filter(t => t.status === 'Assigned').length,
        submitted: allTasks.filter(t => t.status === 'Submitted').length,
        completed: allTasks.filter(t => t.status === 'Completed').length,
      };

      // Members
      const allUsers = org.users || [];
      const activeMembers = allUsers.filter((u: any) => u.membershipStatus === 'Active');

      // Proposals
      const activeHybrid = result.activeHybridProposals || [];
      const activeDD = org.directDemocracyVoting?.ddvProposals || [];
      const activeProposals = activeHybrid.length + activeDD.length;

      // Token
      const tokenSupply = org.participationToken?.totalSupply
        ? ethers.utils.formatUnits(org.participationToken.totalSupply, 18)
        : '0';
      const tokenSymbol = org.participationToken?.symbol || 'PT';

      // Vouches & requests
      const activeVouches = result.activeVouches || [];
      const pendingRequests = result.pendingTokenRequests || [];

      if (output.isJsonMode()) {
        output.json({
          name: org.name,
          members: activeMembers.length,
          tokenSupply,
          tokenSymbol,
          activeProposals,
          tasks: taskStats,
          activeVouches: activeVouches.length,
          pendingTokenRequests: pendingRequests.length,
          distributions: org.paymentManager?.distributionCounter || '0',
          // Additive v6 fields (omitted under --fast):
          ...(versionRows ? {
            moduleVersions: versionRows.map(r => ({ ...r, status: versionStatusLabel(r) })),
          } : {}),
          ...(versionError ? { moduleVersionsError: versionError } : {}),
        });
      } else {
        console.log('');
        console.log(`  ${org.name}`);
        console.log('  ' + '─'.repeat(40));
        console.log(`  Members:      ${activeMembers.length}`);
        console.log(`  Token Supply: ${tokenSupply} ${tokenSymbol}`);
        console.log(`  Proposals:    ${activeProposals} active`);
        console.log(`  Tasks:        ${taskStats.open} open, ${taskStats.assigned} assigned, ${taskStats.submitted} review, ${taskStats.completed} done`);
        if (activeVouches.length > 0) {
          console.log(`  Vouches:      ${activeVouches.length} pending`);
        }
        if (pendingRequests.length > 0) {
          console.log(`  Token Reqs:   ${pendingRequests.length} pending`);
        }
        if (versionRows && versionRows.length > 0) {
          console.log('');
          console.log('  Module versions:');
          const pad = Math.max(...versionRows.map(r => r.module.length)) + 1;
          for (const row of versionRows) {
            console.log(`    ${(row.module + ':').padEnd(pad + 1)} ${versionStatusLabel(row)}`);
          }
        } else if (versionError) {
          console.log('');
          console.log(`  Note: ${versionError}`);
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
