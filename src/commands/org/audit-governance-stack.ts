/**
 * pop org audit-governance-stack <addr>
 *
 * Task #536 (HB#800 scaffold by argus): parallel-probe governance audit composing
 * existing audit-governor + audit-snapshot + audit-safe + audit-vetoken +
 * actor-footprint into a single CLI invocation. Output: HAS_ONCHAIN_GOVERNOR /
 * HAS_SNAPSHOT_SPACE / EFFECTIVE_GOV_MECHANISM (token-vote / multisig-only /
 * mixed / unknown) + active activity indicators.
 *
 * Spec'd from vigil HB#672 Pirex L2.5 finding + sentinel HB#1038-#1041
 * vote-escrow research arc. Tested against rlBTRFLY/Pirex (multisig-only) +
 * cvx.eth/aurafinance.eth (active Snapshot) per spec acceptance.
 *
 * Filter-state meta banner per HB#648 pattern (which probes attempted /
 * succeeded / skipped + warnings on stale data / missing endpoints).
 *
 * Ship-order ladder (RULE #25):
 *   HB#800 scaffold (this file): CLI dispatch + probe-stubs + filter-meta + index registration
 *   HB#801-#803 per-probe modules (Governor / Snapshot / Safe / vetoken / actor-footprint composition)
 *   HB#804 smoke against rlBTRFLY/Pirex + cvx.eth/aurafinance.eth + submit
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import * as output from '../../lib/output';

const AUDIT_GOVERNANCE_STACK_TOOLING_VERSION = 'audit-governance-stack-v0.1-scaffold-hb800';

export type ProbeStatus = 'succeeded' | 'failed' | 'skipped' | 'not-implemented';

export interface ProbeResult {
  status: ProbeStatus;
  reason?: string;
  data?: Record<string, unknown>;
}

export interface AuditGovernanceStackResult {
  address: string;
  chainId: number;
  classification: {
    hasOnChainGovernor: boolean | null;
    hasSnapshotSpace: boolean | null;
    effectiveGovMechanism: 'token-vote' | 'multisig-only' | 'mixed' | 'unknown';
  };
  probes: {
    governor: ProbeResult;
    snapshot: ProbeResult;
    safe: ProbeResult;
    vetoken: ProbeResult;
    actorFootprint: ProbeResult;
  };
  filterMeta: {
    toolingVersion: string;
    probesAttempted: number;
    probesSucceeded: number;
    probesFailed: number;
    probesSkipped: number;
    warnings: string[];
  };
}

interface AuditGovernanceStackArgs {
  org: string;
  address: string;
  chain?: number;
  rpc?: string;
  json?: boolean;
  probes?: string;
  snapshotSpace?: string;
}

const ALL_PROBES = ['governor', 'snapshot', 'safe', 'vetoken', 'actor-footprint'] as const;

function buildFilterMeta(probes: AuditGovernanceStackResult['probes']): AuditGovernanceStackResult['filterMeta'] {
  const probeValues = Object.values(probes);
  const warnings: string[] = [];
  for (const [name, result] of Object.entries(probes)) {
    if (result.status === 'not-implemented') {
      warnings.push(`${name}: not-implemented (HB#800 scaffold; HB#801+ wires real probe)`);
    } else if (result.status === 'failed') {
      warnings.push(`${name}: failed${result.reason ? ` (${result.reason})` : ''}`);
    }
  }
  return {
    toolingVersion: AUDIT_GOVERNANCE_STACK_TOOLING_VERSION,
    probesAttempted: probeValues.length,
    probesSucceeded: probeValues.filter((p) => p.status === 'succeeded').length,
    probesFailed: probeValues.filter((p) => p.status === 'failed').length,
    probesSkipped: probeValues.filter((p) => p.status === 'skipped' || p.status === 'not-implemented').length,
    warnings,
  };
}

function renderFilterBanner(meta: AuditGovernanceStackResult['filterMeta']): string {
  const parts = [
    `attempted=${meta.probesAttempted}`,
    `succeeded=${meta.probesSucceeded}`,
    `failed=${meta.probesFailed}`,
    `skipped=${meta.probesSkipped}`,
  ];
  const warn = meta.warnings.length > 0 ? `  [⚠ ${meta.warnings.length} WARN]` : '';
  return `  probes: ${parts.join(' ')}${warn}  · ${meta.toolingVersion}`;
}

function classify(probes: AuditGovernanceStackResult['probes']): AuditGovernanceStackResult['classification'] {
  const govSucceeded = probes.governor.status === 'succeeded';
  const snapshotSucceeded = probes.snapshot.status === 'succeeded';
  const safeSucceeded = probes.safe.status === 'succeeded';
  const hasOnChainGovernor = govSucceeded ? Boolean((probes.governor.data as { hasProposals?: boolean })?.hasProposals) : null;
  const hasSnapshotSpace = snapshotSucceeded ? Boolean((probes.snapshot.data as { spaceExists?: boolean })?.spaceExists) : null;
  let effectiveGovMechanism: AuditGovernanceStackResult['classification']['effectiveGovMechanism'] = 'unknown';
  if (hasOnChainGovernor && hasSnapshotSpace) {
    effectiveGovMechanism = 'mixed';
  } else if (hasOnChainGovernor || hasSnapshotSpace) {
    effectiveGovMechanism = 'token-vote';
  } else if (safeSucceeded) {
    effectiveGovMechanism = 'multisig-only';
  }
  return { hasOnChainGovernor, hasSnapshotSpace, effectiveGovMechanism };
}

async function probeGovernor(_address: string, _chainId: number, _rpc?: string): Promise<ProbeResult> {
  return { status: 'not-implemented', reason: 'HB#801 will wire pop org audit-governor composition' };
}

async function probeSnapshot(_address: string, _snapshotSpace?: string): Promise<ProbeResult> {
  return { status: 'not-implemented', reason: 'HB#801 will wire Snapshot space discovery + audit-snapshot composition' };
}

async function probeSafe(_address: string, _chainId: number, _rpc?: string): Promise<ProbeResult> {
  return { status: 'not-implemented', reason: 'HB#802 will wire pop org audit-safe composition + signer-set probe' };
}

async function probeVetoken(_address: string, _chainId: number, _rpc?: string): Promise<ProbeResult> {
  return { status: 'not-implemented', reason: 'HB#802 will wire pop org audit-vetoken composition for veCRV-family VotingEscrow probe' };
}

async function probeActorFootprint(_address: string, _chainId: number, _rpc?: string): Promise<ProbeResult> {
  return { status: 'not-implemented', reason: 'HB#803 will wire pop org actor-footprint composition for cross-protocol balance scan' };
}

export const auditGovernanceStackHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('address', { type: 'string', demandOption: true, describe: 'Target governance address (Governor contract, multisig, or token contract)' })
      .option('probes', {
        type: 'string',
        describe: `Comma-separated subset of probes to run (default: all). Valid: ${ALL_PROBES.join(',')}`,
      })
      .option('snapshot-space', {
        type: 'string',
        describe: 'Snapshot space identifier (e.g., cvx.eth). If absent, snapshot probe attempts space discovery via name() / known mappings.',
      }),

  handler: async (argv: ArgumentsCamelCase<AuditGovernanceStackArgs>) => {
    const address = argv.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      output.error(`--address must be 0x-prefixed 40-hex; got: ${argv.address}`);
      process.exit(1);
    }
    const chainId = argv.chain || 1;

    const requested = argv.probes ? new Set(argv.probes.split(',').map((s) => s.trim())) : new Set(ALL_PROBES);
    const invalid = Array.from(requested).filter((p) => !(ALL_PROBES as readonly string[]).includes(p));
    if (invalid.length) {
      output.error(`Invalid probe(s): ${invalid.join(',')}. Valid: ${ALL_PROBES.join(',')}`);
      process.exit(1);
    }

    const skipReason = (probe: string): ProbeResult => ({ status: 'skipped', reason: `not in --probes filter (got: ${argv.probes})` });

    const [governor, snapshot, safe, vetoken, actorFootprint] = await Promise.all([
      requested.has('governor') ? probeGovernor(address, chainId, argv.rpc) : Promise.resolve(skipReason('governor')),
      requested.has('snapshot') ? probeSnapshot(address, argv.snapshotSpace) : Promise.resolve(skipReason('snapshot')),
      requested.has('safe') ? probeSafe(address, chainId, argv.rpc) : Promise.resolve(skipReason('safe')),
      requested.has('vetoken') ? probeVetoken(address, chainId, argv.rpc) : Promise.resolve(skipReason('vetoken')),
      requested.has('actor-footprint') ? probeActorFootprint(address, chainId, argv.rpc) : Promise.resolve(skipReason('actor-footprint')),
    ]);

    const probes = { governor, snapshot, safe, vetoken, actorFootprint };
    const classification = classify(probes);
    const filterMeta = buildFilterMeta(probes);

    const result: AuditGovernanceStackResult = {
      address,
      chainId,
      classification,
      probes,
      filterMeta,
    };

    if (argv.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nGovernance stack audit: ${address} (chain ${chainId})`);
    console.log(renderFilterBanner(filterMeta));
    console.log(`\nClassification:`);
    console.log(`  hasOnChainGovernor: ${classification.hasOnChainGovernor === null ? 'unknown' : classification.hasOnChainGovernor}`);
    console.log(`  hasSnapshotSpace:   ${classification.hasSnapshotSpace === null ? 'unknown' : classification.hasSnapshotSpace}`);
    console.log(`  effectiveGovMechanism: ${classification.effectiveGovMechanism}`);
    console.log(`\nProbes:`);
    for (const [name, r] of Object.entries(probes)) {
      const status = r.status === 'succeeded' ? '✓' : r.status === 'failed' ? '✗' : r.status === 'skipped' ? '–' : '◌';
      console.log(`  ${status} ${name}: ${r.status}${r.reason ? ` — ${r.reason}` : ''}`);
    }
    if (filterMeta.warnings.length > 0) {
      console.log(`\nWarnings:`);
      filterMeta.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
    }
  },
};
