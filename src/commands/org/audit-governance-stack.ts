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

const AUDIT_GOVERNANCE_STACK_TOOLING_VERSION = 'audit-governance-stack-v0.5-actor-footprint-multichain-hb745';

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

// Gnosis Safe probe ABI — getOwners + getThreshold + nonce + VERSION are
// canonical Safe.sol view methods present on every deployed Safe regardless
// of version (1.0.0 through 1.4.x).
const SAFE_VIEW_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function VERSION() view returns (string)',
];

// Cross-protocol governance token registry. Per sentinel HB#1041 Part IV
// federation census methodology: scan canonical governance-token holdings to
// surface cross-protocol presence + ENS-name identification. Subset of full
// actor-footprint tool (HB#1034 vigil ship); composition tool surfaces SIGNAL
// not full balance breakdown.
//
// HB#745 task #570: extended to per-chain registries to support cross-chain
// governance audits (κ-H Part V vigil HB#735-#744 + sentinel HB#1089). Each
// L2 ecosystem has its own canonical governance tokens.
const GOVERNANCE_TOKENS_BY_CHAIN: Record<number, { symbol: string; address: string; decimals: number }[]> = {
  // Ethereum mainnet — v0.1 set (HB#1041)
  1: [
    { symbol: 'CRV', address: '0xD533a949740bb3306d119CC777fa900bA034cd52', decimals: 18 },
    { symbol: 'CVX', address: '0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B', decimals: 18 },
    { symbol: 'BAL', address: '0xba100000625a3754423978a60c9317c58a424e3D', decimals: 18 },
    { symbol: 'AURA', address: '0xC0c293ce456fF0ED870ADd98a0828Dd4d2903DBF', decimals: 18 },
    { symbol: 'FXS', address: '0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0', decimals: 18 },
    { symbol: 'ENS', address: '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72', decimals: 18 },
    { symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
  ],
  // Optimism — Velodrome ecosystem + cross-chain governance tokens
  10: [
    { symbol: 'VELO', address: '0x9560e827af36c94d2ac33a39bce1fe78631088db', decimals: 18 },
    { symbol: 'OP', address: '0x4200000000000000000000000000000000000042', decimals: 18 },
    { symbol: 'USDC', address: '0x7f5c764cbc14f9669b88837ca1490cca17c31607', decimals: 6 },
  ],
  // Base — Aerodrome ecosystem
  8453: [
    { symbol: 'AERO', address: '0x940181a94a35a4569e4529a3cdfb74e38fd98631', decimals: 18 },
    { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  ],
  // Arbitrum — Ramses + cross-chain
  42161: [
    { symbol: 'RAM', address: '0xAAA6C1E32C55A7Bfa8066A6FAE9b42650F262418', decimals: 18 },
    { symbol: 'ARB', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
    { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  ],
  // Polygon — Pearl, Aave, etc.
  137: [
    { symbol: 'USDC', address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', decimals: 6 },
    { symbol: 'AAVE', address: '0xd6df932a45c0f255f85145f286ea0b292b21c90b', decimals: 18 },
  ],
  // Gnosis — Argus org's primary chain
  100: [
    { symbol: 'sDAI', address: '0xaf204776c7245bF4147c2612BF6e5972Ee483701', decimals: 18 },
    { symbol: 'WXDAI', address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', decimals: 18 },
  ],
};

// Backwards-compat alias retained as the mainnet registry. Existing call sites
// referencing GOVERNANCE_TOKENS_MAINNET still work.
const GOVERNANCE_TOKENS_MAINNET = GOVERNANCE_TOKENS_BY_CHAIN[1];

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

// VotingEscrow probe ABI — covers veCRV (Curve), veBAL (Balancer), vlCVX
// (Convex locked-vote), and Redacted Cartel rlBTRFLY (lockedSupply pattern
// per sentinel HB#1040 finding). totalSupply/lockedSupply/name/symbol union
// + locking constants for variant disambiguation.
const VETOKEN_VIEW_ABI = [
  'function totalSupply() view returns (uint256)',
  'function lockedSupply() view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function epoch() view returns (uint256)',
  'function MAXTIME() view returns (uint256)',
  'function token() view returns (address)',
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
  // HB#803: spaceExists may be explicitly null (discovery-unsupported path) —
  // distinguish from false. null propagates as unknown; only true/false coerce.
  const snapshotSpaceExists = (probes.snapshot.data as { spaceExists?: boolean | null })?.spaceExists;
  const hasSnapshotSpace = snapshotSucceeded
    ? (snapshotSpaceExists === null || snapshotSpaceExists === undefined ? null : Boolean(snapshotSpaceExists))
    : null;
  // isSafeMultisig is a TRUE Safe (getOwners + getThreshold succeeded) AND target
  // doesn't already have a token-vote mechanism. This prevents misclassifying
  // a Safe-controlled treasury as multisig-only when the org also has Snapshot.
  const isSafeMultisig = safeSucceeded ? Boolean((probes.safe.data as { isSafe?: boolean })?.isSafe) : false;
  let effectiveGovMechanism: AuditGovernanceStackResult['classification']['effectiveGovMechanism'] = 'unknown';
  if ((hasOnChainGovernor || hasSnapshotSpace) && isSafeMultisig) {
    effectiveGovMechanism = 'mixed';
  } else if (hasOnChainGovernor && hasSnapshotSpace) {
    effectiveGovMechanism = 'mixed';
  } else if (hasOnChainGovernor || hasSnapshotSpace) {
    effectiveGovMechanism = 'token-vote';
  } else if (isSafeMultisig) {
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
  // Discovery without hint: Snapshot's hub.snapshot.org schema doesn't expose
  // a server-side admin-address index on SpaceWhere (HB#803 empirical: query
  // `where: {admins_in: $addr}` returns 'Field "admins_in" is not defined').
  // v0.4 returns graceful 'discovery-unsupported'. Workaround: pass
  // --snapshot-space <id> for direct lookup. HB#804+ may add ENS-resolved
  // space-name guessing OR Snapshot search-API integration.
  return {
    status: 'succeeded',
    data: {
      spaceExists: null,
      discoveryAttempted: 'none-supported',
      reason: 'Snapshot space discovery without --snapshot-space hint not supported in v0.4 (admins_in not in SpaceWhere schema). Pass --snapshot-space <id> for direct probe.',
    },
  };
}

async function probeSafe(address: string, chainId: number, rpcOverride?: string): Promise<ProbeResult> {
  const rpcUrl = resolveRpc(chainId, rpcOverride);
  if (!rpcUrl) {
    return { status: 'failed', reason: `no RPC URL for chain ${chainId} (set AUDIT_GS_RPC_${chainId} env var)` };
  }
  try {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, { name: `chain-${chainId}`, chainId });
    const code = await provider.getCode(address);
    if (code === '0x') {
      return { status: 'succeeded', data: { isSafe: false, isContract: false, reason: 'address is EOA, not a Safe multisig' } };
    }
    const safe = new ethers.Contract(address, SAFE_VIEW_ABI, provider);
    const data: Record<string, unknown> = { isContract: true, codeBytes: (code.length - 2) / 2 };
    // Definitive Safe-detection: getOwners + getThreshold both succeed
    let isSafe = false;
    try {
      const [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]);
      isSafe = true;
      data.isSafe = true;
      data.signerCount = owners.length;
      data.threshold = threshold.toNumber();
      data.signers = owners.map((o: string) => o.toLowerCase());
      data.thresholdRatio = `${threshold.toNumber()}/${owners.length}`;
    } catch {
      data.isSafe = false;
      data.reason = 'getOwners/getThreshold reverted — not a Safe multisig';
    }
    if (isSafe) {
      // Operational activity indicator + version
      try { data.nonce = (await safe.nonce()).toNumber(); } catch { /* not required */ }
      try { data.safeVersion = await safe.VERSION(); } catch { /* not required */ }
    }
    return { status: 'succeeded', data };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason: msg.slice(0, 200) };
  }
}

async function probeVetoken(address: string, chainId: number, rpcOverride?: string): Promise<ProbeResult> {
  const rpcUrl = resolveRpc(chainId, rpcOverride);
  if (!rpcUrl) {
    return { status: 'failed', reason: `no RPC URL for chain ${chainId} (set AUDIT_GS_RPC_${chainId} env var)` };
  }
  try {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, { name: `chain-${chainId}`, chainId });
    const code = await provider.getCode(address);
    if (code === '0x') {
      return { status: 'succeeded', data: { isVeToken: false, isContract: false, reason: 'address is EOA, not a token contract' } };
    }
    const token = new ethers.Contract(address, VETOKEN_VIEW_ABI, provider);
    const data: Record<string, unknown> = { isContract: true, codeBytes: (code.length - 2) / 2 };
    let veVariant: string | null = null;
    let totalSupply: ethers.BigNumber | null = null;
    let lockedSupply: ethers.BigNumber | null = null;
    // Try standard ERC20 metadata first (unaffected by veToken-ness)
    try { data.tokenName = await token.name(); } catch { /* not required */ }
    try { data.tokenSymbol = await token.symbol(); } catch { /* not required */ }
    try {
      const dec = await token.decimals();
      data.decimals = Number(dec);
    } catch { /* not required */ }
    // totalSupply (always tried)
    try {
      totalSupply = await token.totalSupply();
      data.totalSupplyRaw = totalSupply!.toString();
      if (data.decimals && typeof data.decimals === 'number') {
        data.totalSupply = Number(ethers.utils.formatUnits(totalSupply!, data.decimals as number));
      }
    } catch { /* not all contracts have totalSupply */ }
    // lockedSupply (sentinel HB#1040 — Redacted Cartel rlBTRFLY pattern)
    try {
      lockedSupply = await token.lockedSupply();
      data.lockedSupplyRaw = lockedSupply!.toString();
      if (data.decimals && typeof data.decimals === 'number') {
        data.lockedSupply = Number(ethers.utils.formatUnits(lockedSupply!, data.decimals as number));
      }
      veVariant = 'has-lockedSupply';
    } catch { /* not present on most contracts */ }
    // Curve VotingEscrow signature: epoch() + MAXTIME()
    try {
      const ep = await token.epoch();
      data.epoch = ep.toString();
      veVariant = 'curve-VotingEscrow (epoch present)';
    } catch { /* not Curve-style */ }
    try {
      const mt = await token.MAXTIME();
      data.MAXTIME_seconds = mt.toString();
      if (!veVariant || veVariant === 'has-lockedSupply') veVariant = 'curve-style-VotingEscrow';
    } catch { /* not present */ }
    // VotingEscrow underlying token reference
    try { data.underlyingToken = (await token.token()).toLowerCase(); } catch { /* not always present */ }
    // Classify
    const isVeToken = veVariant !== null || (lockedSupply !== null && lockedSupply.gt(0));
    data.isVeToken = isVeToken;
    if (veVariant) data.veVariant = veVariant;
    if (totalSupply && totalSupply.eq(0) && lockedSupply && lockedSupply.gt(0)) {
      data.dormancyPattern = 'totalSupply()=0 + lockedSupply()>0 — Redacted-Cartel rlBTRFLY pattern (sentinel HB#1040 finding); use lockedSupply for governance weight';
    }
    return { status: 'succeeded', data };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason: msg.slice(0, 200) };
  }
}

async function probeActorFootprint(address: string, chainId: number, rpcOverride?: string): Promise<ProbeResult> {
  // HB#745 task #570: per-chain registry lookup (was mainnet-only v0.1).
  const tokens = GOVERNANCE_TOKENS_BY_CHAIN[chainId];
  if (!tokens || tokens.length === 0) {
    return {
      status: 'skipped',
      reason: `actor-footprint registry has no entries for chain ${chainId}. Currently supported: ${Object.keys(GOVERNANCE_TOKENS_BY_CHAIN).join(', ')}. Extend GOVERNANCE_TOKENS_BY_CHAIN in src/commands/org/audit-governance-stack.ts.`,
    };
  }
  const rpcUrl = resolveRpc(chainId, rpcOverride);
  if (!rpcUrl) {
    return { status: 'failed', reason: `no RPC URL for chain ${chainId} (set AUDIT_GS_RPC_${chainId} env var)` };
  }
  try {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, { name: `chain-${chainId}`, chainId });
    const data: Record<string, unknown> = {};
    // ENS reverse lookup (best-effort; provider may not support; mainnet only)
    try {
      const ensName = await provider.lookupAddress(address);
      data.ensName = ensName;
    } catch {
      data.ensName = null;
    }
    // EOA vs contract
    const code = await provider.getCode(address);
    data.isContract = code !== '0x';
    if (data.isContract) data.codeBytes = (code.length - 2) / 2;
    // Parallel balanceOf across governance tokens (per-chain registry, HB#745)
    const balances = await Promise.all(
      tokens.map(async (tok) => {
        try {
          const c = new ethers.Contract(tok.address, ERC20_BALANCE_ABI, provider);
          const bal = await c.balanceOf(address);
          if (bal.eq(0)) return null;
          return {
            symbol: tok.symbol,
            address: tok.address,
            balance: Number(ethers.utils.formatUnits(bal, tok.decimals)),
            balanceRaw: bal.toString(),
          };
        } catch {
          return { symbol: tok.symbol, error: 'balanceOf reverted' } as { symbol: string; error: string };
        }
      }),
    );
    const nonzero = balances.filter((b): b is { symbol: string; address: string; balance: number; balanceRaw: string } => b !== null && !('error' in b));
    data.tokensHeld = nonzero;
    data.tokensHeldCount = nonzero.length;
    data.crossProtocol = nonzero.length >= 2;
    data.governanceTokensScanned = tokens.length;
    data.chainId = chainId;
    return { status: 'succeeded', data };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason: msg.slice(0, 200) };
  }
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
