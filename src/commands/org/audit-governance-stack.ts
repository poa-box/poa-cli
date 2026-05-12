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
import { ethers } from 'ethers';
import { request } from 'https';
import * as output from '../../lib/output';

const AUDIT_GOVERNANCE_STACK_TOOLING_VERSION = 'audit-governance-stack-v0.2-governor-snapshot-hb801';

// Reuse same RPC defaults pattern as lockstep-analyzer.js (HB#792 task #540).
// Override per-chain via AUDIT_GS_RPC_<chainId> env vars for paid endpoints.
const DEFAULT_RPC: Record<number, string> = {
  1: 'https://cloudflare-eth.com',
  10: 'https://mainnet.optimism.io',
  137: 'https://polygon-rpc.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  100: 'https://rpc.gnosischain.com',
};

function resolveRpc(chainId: number, override?: string): string | undefined {
  if (override) return override;
  return process.env[`AUDIT_GS_RPC_${chainId}`] || DEFAULT_RPC[chainId];
}

const SNAPSHOT_URL = 'https://hub.snapshot.org/graphql';

// Standard Governor ABI fragment — covers GovernorBravo + OpenZeppelin Governor.
// proposalCount() is GovernorBravo-only; OZ Governor exposes hashProposal() + proposalSnapshot()
// but no count. We try proposalCount first; on failure fall back to ProposalCreated event scan.
const GOVERNOR_VIEW_ABI = [
  'function proposalCount() view returns (uint256)',
  'function votingDelay() view returns (uint256)',
  'function votingPeriod() view returns (uint256)',
  'function name() view returns (string)',
  'function quorumNumerator() view returns (uint256)',
  'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)',
];

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

async function probeGovernor(address: string, chainId: number, rpcOverride?: string): Promise<ProbeResult> {
  const rpcUrl = resolveRpc(chainId, rpcOverride);
  if (!rpcUrl) {
    return { status: 'failed', reason: `no RPC URL for chain ${chainId} (set AUDIT_GS_RPC_${chainId} env var)` };
  }
  try {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, { name: `chain-${chainId}`, chainId });
    const code = await provider.getCode(address);
    if (code === '0x') {
      return { status: 'succeeded', data: { isContract: false, hasProposals: false, reason: 'address is EOA, not a Governor contract' } };
    }
    const governor = new ethers.Contract(address, GOVERNOR_VIEW_ABI, provider);
    const data: Record<string, unknown> = { isContract: true, codeBytes: (code.length - 2) / 2 };
    // Try GovernorBravo proposalCount() — definitive
    try {
      const count = await governor.proposalCount();
      data.proposalCount = count.toNumber();
      data.governorVariant = 'GovernorBravo (proposalCount() succeeded)';
      data.hasProposals = count.toNumber() > 0;
    } catch {
      // Fallback: scan recent ProposalCreated events (covers OZ Governor)
      try {
        const currentBlock = await provider.getBlockNumber();
        const SCAN = 100_000;
        const fromBlock = Math.max(0, currentBlock - SCAN);
        const events = await governor.queryFilter(governor.filters.ProposalCreated(), fromBlock, currentBlock);
        data.recentProposalCount = events.length;
        data.scanWindowBlocks = SCAN;
        data.governorVariant = events.length > 0 ? 'OZ-Governor or compatible (ProposalCreated events found)' : 'unknown (no proposalCount + no ProposalCreated events in last 100K blocks)';
        data.hasProposals = events.length > 0;
      } catch (innerErr: unknown) {
        const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
        data.eventScanError = msg.slice(0, 120);
        data.governorVariant = 'not-a-Governor (no Governor methods + no ProposalCreated events)';
        data.hasProposals = false;
      }
    }
    // Optional metadata
    try { data.governorName = await governor.name(); } catch { /* not required */ }
    try { data.votingPeriodBlocks = (await governor.votingPeriod()).toString(); } catch { /* not required */ }
    return { status: 'succeeded', data };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason: msg.slice(0, 200) };
  }
}

function snapshotGql(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = request(
      SNAPSHOT_URL,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(out); } catch { return reject(new Error(`Snapshot non-JSON response: ${out.slice(0, 200)}`)); }
          if (parsed && parsed.error) return reject(new Error(`Snapshot ${parsed.error}: ${parsed.error_description || ''}`));
          if (parsed && Array.isArray(parsed.errors) && parsed.errors.length) return reject(new Error(`Snapshot GraphQL error: ${parsed.errors[0].message || JSON.stringify(parsed.errors[0])}`));
          if (!parsed || parsed.data === undefined) return reject(new Error(`Snapshot empty response: ${out.slice(0, 200)}`));
          resolve(parsed.data);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function probeSnapshot(address: string, spaceHint?: string): Promise<ProbeResult> {
  // Strategy: if --snapshot-space provided, query directly. Otherwise check the
  // Snapshot space registry for any space whose `id` OR `treasuries[].address`
  // matches the target address. (Snapshot exposes spaces in its GraphQL
  // schema; we can also try the Snapshot search endpoint.) Discovery without
  // a hint is heuristic; HB#802+ may extend with ENS-based name lookup.
  const lcAddr = address.toLowerCase();
  if (spaceHint) {
    try {
      const data = await snapshotGql(
        `query($space: String!) {
          space(id: $space) { id name members admins network }
          proposals(first: 5, where: {space: $space, state: "closed"}, orderBy: "created", orderDirection: desc) {
            id title created
          }
        }`,
        { space: spaceHint },
      );
      const d = data as { space?: { id?: string; name?: string; admins?: string[]; members?: string[]; network?: string } | null; proposals?: { id: string; title: string; created: number }[] };
      if (!d.space) {
        return { status: 'succeeded', data: { spaceExists: false, spaceHint, reason: `Snapshot space '${spaceHint}' not found` } };
      }
      return {
        status: 'succeeded',
        data: {
          spaceExists: true,
          spaceId: d.space.id,
          spaceName: d.space.name,
          network: d.space.network,
          adminCount: d.space.admins?.length || 0,
          memberCount: d.space.members?.length || 0,
          recentClosedProposals: d.proposals?.length || 0,
          isActive: (d.proposals?.length || 0) > 0,
          // Note: address-to-space match is implicit (caller passed the hint)
          addressMatchedAdmin: d.space.admins?.map((a) => a.toLowerCase()).includes(lcAddr) || false,
          addressMatchedMember: d.space.members?.map((a) => a.toLowerCase()).includes(lcAddr) || false,
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', reason: `Snapshot lookup failed for space '${spaceHint}': ${msg.slice(0, 200)}` };
    }
  }
  // Discovery without hint: search any spaces where `address` is admin or member.
  // Snapshot's `spaces` query supports `where` on admins/members.
  try {
    const data = await snapshotGql(
      `query($addr: [String!]) {
        spaces(first: 10, where: {admins_in: $addr}) { id name network admins }
      }`,
      { addr: [lcAddr] },
    );
    const d = data as { spaces?: { id: string; name?: string; network?: string }[] };
    const matched = d.spaces || [];
    if (matched.length === 0) {
      return {
        status: 'succeeded',
        data: {
          spaceExists: false,
          discoveryAttempted: 'admins-in',
          reason: `no Snapshot space found where ${address} is admin (try --snapshot-space <id> for direct lookup)`,
        },
      };
    }
    return {
      status: 'succeeded',
      data: {
        spaceExists: true,
        discoveryAttempted: 'admins-in',
        matchedSpaces: matched.map((s) => ({ id: s.id, name: s.name, network: s.network })),
        primarySpaceId: matched[0].id,
        isActive: null, // not probed in discovery mode
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason: `Snapshot discovery failed: ${msg.slice(0, 200)}` };
  }
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
