/**
 * pop org status — quick org health summary (+ module version panel).
 *
 * The version panel answers, per deployed module: which implementation is it
 * on, is that the protocol's latest for the type, and will its beacon follow
 * upgrades automatically. TypeName strings and typeId derivation VERIFIED
 * against contracts origin/main src/libs/ModuleTypes.sol
 * (typeId = keccak256(bytes(typeName))) and
 * script/deploy/DeployInfrastructure.s.sol (addContractType calls).
 *
 * SUBGRAPH FIRST (2026-07). This panel used to cost up to 18 EIP-1967 slot
 * walks + 9 PoaManager calls + 9 OrgRegistry calls + one block-0 eth_getLogs
 * for a read-only summary. All four are indexed and verified populated on live
 * Gnosis AND Arbitrum:
 *
 *   implementation      RegisteredContract.beacon → SwitchableBeaconContract.mode
 *                       → Beacon(typeId).currentImplementation   (Mirror)
 *   latestImplementation Beacon(typeId).currentImplementation
 *   version             Beacon.version / BeaconUpgradeEvent.version
 *
 * autoUpgrade deliberately stays on OrgRegistry.isAutoUpgrade: the indexed
 * RegisteredContract.autoUpgrade is registration-time only (no AutoUpgradeSet
 * handler exists), so it cannot observe setAutoUpgrade.
 *
 * Two caveats are honoured rather than assumed away:
 *   - SwitchableBeaconContract.mirrorBeacon is NULL on every live row, so the
 *     Mirror branch joins the global beacon by typeId (see queries/beacons.ts).
 *   - No Pinned beacon exists on any live deployment, so
 *     pinnedImplementation has never been observed populated; a Pinned (or
 *     unclassifiable) beacon falls back to RPC instead of guessing Mirror.
 *
 * The whole panel is best-effort: any RPC/subgraph failure degrades to a
 * one-line note, and --fast skips it entirely. JSON output is additive:
 * `moduleVersions` / `moduleVersionsError` / `moduleVersionsSource` appear
 * alongside the existing fields; the row shape is unchanged.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { query } from '../../lib/subgraph';
import { resolveOrgModules, OrgModules } from '../../lib/resolve';
import { getImplementation } from '../../lib/version';
import { createReadContract } from '../../lib/contracts';
import { fetchRegisteredImplementations, loadImplementationVersions } from '../../lib/versions';
import type { VersionIndex } from '../../lib/versions';
import { tryAggregate } from '../../lib/multicall';
import { resolveNetworkConfig } from '../../config/networks';
import { FETCH_ORG_ACTIVITY } from '../../queries/activity';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../queries/infrastructure';
import type { InfrastructureAddresses } from '../../queries/infrastructure';
import {
  fetchOrgBeaconSnapshot,
  resolveImplementationFromSnapshot,
  latestImplementationFromSnapshot,
  autoUpgradeFromSnapshot,
  beaconAddressFromSnapshot,
  checksumAddress,
} from '../../queries/beacons';
import type { OrgBeaconSnapshot } from '../../queries/beacons';
import * as output from '../../lib/output';

const BEACON_IFACE = new ethers.utils.Interface([
  'function implementation() view returns (address)',
]);

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
  { key: 'zkEmailInvitesAddress', label: 'ZkEmailInvites', typeName: 'ZkEmailInvites' },
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
  /**
   * Deployed implementation version string ("v4", "v11", …) resolved from the registry's
   * ImplementationRegistered log. null = undeterminable, which is NOT the same as "old".
   */
  version: string | null;
}

/** Minimal shape buildVersionPanel needs from a version index. */
interface VersionLookup {
  get(implementation: string | null | undefined): { version: string } | undefined;
}

export interface VersionPanelSources {
  /** Indexed module→beacon data; omit/null to force the pure-RPC path. */
  snapshot?: OrgBeaconSnapshot | null;
  /** Implementation→version lookup; omit to use the registry log scan. */
  versions?: VersionIndex | null;
}

/**
 * Resolve implementations for the modules the snapshot could not classify,
 * using ONE Multicall3 batch of beacon.implementation() calls where the beacon
 * address is indexed. Falls back to the EIP-1967 slot walk per module for
 * anything still unresolved. Returns a typeId→implementation map.
 */
async function resolveResidualImplementations(
  provider: ethers.providers.Provider,
  pending: Array<{ typeId: string; proxy: string; beacon: string | null }>
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (pending.length === 0) return out;

  const batched = pending.filter(p => p.beacon);
  if (batched.length > 0) {
    try {
      const results = await tryAggregate(
        provider,
        batched.map(p => ({
          to: p.beacon as string,
          data: BEACON_IFACE.encodeFunctionData('implementation'),
        }))
      );
      results.forEach((res, i) => {
        if (!res.success) return;
        try {
          const [addr] = BEACON_IFACE.decodeFunctionResult('implementation', res.returnData);
          out.set(batched[i].typeId, checksumAddress(addr));
        } catch { /* leave unresolved for the per-module fallback */ }
      });
    } catch { /* whole batch failed — per-module fallback below */ }
  }

  const stillMissing = pending.filter(p => !out.get(p.typeId));
  await Promise.all(stillMissing.map(async (p) => {
    out.set(p.typeId, await getImplementation(provider, p.proxy).catch(() => null));
  }));

  return out;
}

/**
 * Build the module version rows for every module the org has deployed.
 *
 * Pass `sources.snapshot` to serve implementation / latest / autoUpgrade from
 * the subgraph; anything it cannot answer still falls back to RPC per field, so
 * a partial index degrades gracefully rather than producing nulls. Individual
 * module failures degrade that row (nulls); only total infrastructure failure
 * should be handled by the caller's try/catch.
 */
export async function buildVersionPanel(
  provider: ethers.providers.Provider,
  modules: OrgModules,
  infra: { poaManagerAddress: string; orgRegistryAddress: string | null; implementationRegistryAddress?: string | null },
  sources?: VersionPanelSources
): Promise<ModuleVersionRow[]> {
  const snapshot = sources?.snapshot ?? null;
  const poaManager = createReadContract(infra.poaManagerAddress, 'PoaManager', provider);
  const orgRegistry = infra.orgRegistryAddress
    ? createReadContract(infra.orgRegistryAddress, 'OrgRegistry', provider)
    : null;

  const present = MODULE_TYPES.filter(m => typeof modules[m.key] === 'string' && modules[m.key]);

  // typeId = keccak256(bytes(typeName)) — ModuleTypes.sol derivation.
  const rows = present.map(m => ({
    meta: m,
    proxy: modules[m.key] as string,
    typeId: ethers.utils.id(m.typeName),
  }));

  // ── Pass 1: everything the subgraph can answer, at zero RPC cost ──────
  const indexed = new Map<string, { implementation: string | null; version: string | null }>();
  for (const row of rows) {
    const resolved = resolveImplementationFromSnapshot(snapshot, row.typeId);
    indexed.set(row.typeId, {
      implementation: resolved?.implementation ?? null,
      version: resolved?.version ?? null,
    });
  }

  // ── Pass 2: one batched RPC round for the implementations left over ───
  const residual = await resolveResidualImplementations(
    provider,
    rows
      .filter(r => !indexed.get(r.typeId)?.implementation)
      .map(r => ({ typeId: r.typeId, proxy: r.proxy, beacon: beaconAddressFromSnapshot(snapshot, r.typeId) }))
  );

  // Version lookup: caller-supplied index, else the historical registry log
  // scan (kept so this function still works standalone / offline).
  const versions: VersionLookup = sources?.versions
    ?? (infra.implementationRegistryAddress
      ? await fetchRegisteredImplementations(provider, infra.implementationRegistryAddress)
        .then((map): VersionLookup => ({
          get: (impl) => (impl ? map.get(impl.toLowerCase()) : undefined),
        }))
      : { get: () => undefined });

  return Promise.all(rows.map(async (row): Promise<ModuleVersionRow> => {
    const { meta, proxy, typeId } = row;
    const fromIndex = indexed.get(typeId);
    const implementation = fromIndex?.implementation ?? residual.get(typeId) ?? null;

    const latestFromIndex = latestImplementationFromSnapshot(snapshot, typeId);
    const autoUpgradeFromIndex = autoUpgradeFromSnapshot(snapshot, typeId);

    const [latestImplementation, autoUpgrade] = await Promise.all([
      latestFromIndex !== null
        ? Promise.resolve(latestFromIndex)
        : poaManager.getCurrentImplementationById(typeId).then((a: string) => a).catch(() => null),
      // autoUpgrade stays RPC-PRIMARY. RegisteredContract.autoUpgrade is written
      // once at registration and there is no AutoUpgradeSet handler, so it cannot
      // see a later setAutoUpgrade(orgId, typeId, false) — serving it from the
      // index would make "autoUpgrade off — beacon pinned", the one annotation
      // this panel exists to produce, permanently wrong. The indexed value is
      // used only when OrgRegistry itself is unreachable.
      orgRegistry
        // contractId = keccak256(abi.encodePacked(orgId, typeId))
        ? orgRegistry.isAutoUpgrade(
            ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [modules.orgId, typeId])
          ).then((b: boolean) => b).catch(() => autoUpgradeFromIndex)
        : Promise.resolve(autoUpgradeFromIndex),
    ]);

    return {
      module: meta.label,
      typeName: meta.typeName,
      proxy,
      implementation,
      latestImplementation,
      upToDate: implementation && latestImplementation
        ? implementation.toLowerCase() === latestImplementation.toLowerCase()
        : null,
      autoUpgrade,
      version: implementation
        ? (fromIndex?.version ?? versions.get(implementation)?.version ?? null)
        : null,
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
      let versionSource: string | null = null;
      if (!argv.fast) {
        spin.text = 'Checking module versions...';
        try {
          const infra = await query<InfrastructureAddresses>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, argv.chain);
          const poaManagerAddress = infra.poaManagerContracts?.[0]?.id;
          if (!poaManagerAddress) throw new Error('PoaManager address not indexed');
          const netConfig = resolveNetworkConfig(argv.chain);
          const provider = new ethers.providers.JsonRpcProvider(netConfig.resolvedRpc, netConfig.chainId);
          const implementationRegistryAddress = infra.poaManagerContracts?.[0]?.registry || null;

          // Both of these are subgraph-first with an RPC fallback inside; a
          // throw here must not sink the panel, so each degrades to null and
          // buildVersionPanel goes back to the original RPC reads.
          const [snapshot, versions] = await Promise.all([
            fetchOrgBeaconSnapshot(modules.orgId, argv.chain).catch(() => null),
            loadImplementationVersions({
              provider,
              registryAddress: implementationRegistryAddress,
              chainId: argv.chain,
            }).catch(() => null),
          ]);

          versionRows = await buildVersionPanel(provider, modules, {
            poaManagerAddress,
            orgRegistryAddress: infra.poaManagerContracts?.[0]?.orgRegistryProxy || null,
            implementationRegistryAddress,
          }, { snapshot, versions });

          // Only now do we know which implementations the panel landed on —
          // top up from the registry log scan if the subgraph could not name
          // one of them (e.g. a beacon pinned to a never-promoted build).
          if (versions) {
            await versions.ensure(versionRows.map(r => r.implementation));
            for (const row of versionRows) {
              if (row.version === null && row.implementation) {
                row.version = versions.get(row.implementation)?.version ?? null;
              }
            }
            versionSource = snapshot ? `subgraph beacons + ${versions.source}` : versions.source;
          } else {
            versionSource = snapshot ? 'subgraph beacons + rpc' : 'rpc';
          }
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
          ...(versionRows && versionSource ? { moduleVersionsSource: versionSource } : {}),
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
            // Version first when known — "up to date" alone does not say WHICH version, and
            // that is the question that matters when behaviour changed between releases.
            const v = row.version ? `${row.version} — ` : '';
            console.log(`    ${(row.module + ':').padEnd(pad + 1)} ${v}${versionStatusLabel(row)}`);
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
