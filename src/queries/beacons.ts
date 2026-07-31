/**
 * Beacon / implementation queries — "which implementation is behind this proxy,
 * and which version is that".
 *
 * Everything here replaces an RPC read that was either expensive or silently
 * unreliable:
 *
 *   - eth_getStorageAt(proxy, EIP-1967 beacon slot) + beacon.implementation()
 *     → RegisteredContract.beacon → SwitchableBeaconContract.mode → the
 *       implementation the beacon resolves to.
 *   - PoaManager.getCurrentImplementationById(typeId)
 *     → Beacon(typeId).currentImplementation.
 *   - OrgRegistry.isAutoUpgrade(keccak256(orgId ‖ typeId))
 *     → RegisteredContract.autoUpgrade (and no ContractUnknown revert path).
 *   - eth_getLogs(ImplementationRegistered, block 0 → latest)
 *     → BeaconUpgradeEvent.{newImplementation,version}.
 *
 * VERIFIED AGAINST LIVE DATA (Gnosis poa-gnosis-v-1 and Arbitrum poa-arb-v-1,
 * 2026-07-30) — every field selected below is non-null on real rows, with two
 * deliberate exceptions that are handled as gaps rather than trusted:
 *
 *   - SwitchableBeaconContract.mirrorBeacon is NULL on EVERY live row on BOTH
 *     deployments. The Mirror branch therefore joins the global Beacon by
 *     typeId (RegisteredContract.typeId), never by mirrorBeacon.
 *   - SwitchableBeaconContract.pinnedImplementation is NULL on every live row
 *     and there is not a single row with mode = "Pinned" on either chain, so
 *     the field has never been observed populated. Pinned beacons therefore
 *     fall back to RPC unless the row actually carries a value.
 *
 * The join that IS used was checked end to end on Gnosis org "Test6":
 *   RegisteredContract(TaskManager).beacon = 0x4af43d51…d4da7c5
 *   == eth_getStorageAt(proxy 0x3d93f0d0…, EIP-1967 beacon slot)
 *   SwitchableBeaconContract(0x4af43d51…).mode = "Mirror"
 *   Beacon("gnosis-<TaskManager typeId>").currentImplementation
 *     = 0x7833c467… == beacon.implementation() over RPC. Match.
 *
 * A separate workstream is adding an implementation-address-keyed entity to
 * the subgraph (Beacon.currentImplementation only answers for the CURRENT
 * mirror implementation, not pinned or historical ones). Both query sets are
 * expressed as tier ARRAYS fed to queryWithFieldFallback so that entity can be
 * slotted in as a new tier 0 without touching any caller.
 */

import { ethers } from 'ethers';
import { queryWithFieldFallback } from '../lib/subgraph';
import type { FieldFallbackTier } from '../lib/subgraph';

// ────────────────────────────── row shapes ──────────────────────────────

export interface BeaconRow {
  typeId: string;
  typeName: string;
  currentImplementation: string;
  version: string | null;
  /**
   * The global beacon's own address. Only selected by the org-module documents,
   * where it is needed to prove a Mirror beacon still mirrors THIS beacon.
   */
  beaconAddress?: string | null;
}

export interface RegisteredContractRow {
  id: string;
  typeId: string;
  proxy: string;
  beacon: string | null;
  autoUpgrade: boolean | null;
}

export interface SwitchableBeaconRow {
  /** The beacon's own address (entity id), lowercased by the indexer. */
  id: string;
  typeId: string | null;
  /**
   * "Mirror" | "Static" as written by the deployed mappings ("Pinned" is
   * accepted as a forward-compatible alias). Anything else is unknown → RPC.
   */
  mode: string | null;
  /**
   * NULL on every live row today, because the SwitchableBeacon constructor sets
   * it without emitting MirrorSet. A real setMirror() populates it — at which
   * point it MUST be compared against Beacon.beaconAddress before joining the
   * global beacon by typeId.
   */
  mirrorBeacon: string | null;
  /** Never observed populated; only trusted when actually present. */
  pinnedImplementation: string | null;
}

// ────────────────────────── documents (tiered) ──────────────────────────

/** Tier 0: RegisteredContract + SwitchableBeaconContract + global Beacon. */
export const ORG_MODULE_BEACONS_FULL = `
  query OrgModuleBeacons($orgId: Bytes!, $orgIdStr: String!) {
    registeredContracts(first: 100, where: { orgId: $orgId }) {
      id
      typeId
      proxy
      beacon
      autoUpgrade
    }
    switchableBeaconContracts(first: 100, where: { organization: $orgIdStr }) {
      id
      typeId
      mode
      mirrorBeacon
      pinnedImplementation
    }
    beacons(first: 100) {
      typeId
      typeName
      currentImplementation
      version
      # Needed to prove a Mirror beacon still mirrors THIS global beacon.
      # Only tier 0 selects it: tiers 1/2 carry no SwitchableBeaconContract rows,
      # so their mode is unknown and they already degrade to RPC.
      beaconAddress
    }
  }
`;

/** Tier 1: deployment without SwitchableBeaconContract (mode unknown → RPC). */
export const ORG_MODULE_BEACONS_NO_SWITCHABLE = `
  query OrgModuleBeaconsNoSwitchable($orgId: Bytes!) {
    registeredContracts(first: 100, where: { orgId: $orgId }) {
      id
      typeId
      proxy
      beacon
      autoUpgrade
    }
    beacons(first: 100) {
      typeId
      typeName
      currentImplementation
      version
    }
  }
`;

/** Tier 2: global beacons only (still kills getCurrentImplementationById). */
export const ORG_MODULE_BEACONS_MINIMAL = `
  query OrgModuleBeaconsMinimal {
    beacons(first: 100) {
      typeId
      typeName
      currentImplementation
      version
    }
  }
`;

/** Tier 0: implementation → version index (global beacons + upgrade history). */
export const IMPLEMENTATION_VERSIONS_FULL = `
  query ImplementationVersions($first: Int!, $skip: Int!) {
    beacons(first: 100) {
      typeId
      typeName
      currentImplementation
      version
    }
    beaconUpgradeEvents(first: $first, skip: $skip, orderBy: upgradedAt, orderDirection: asc) {
      typeId
      newImplementation
      version
    }
  }
`;

/** Tier 1: deployment without BeaconUpgradeEvent — current implementations only. */
export const IMPLEMENTATION_VERSIONS_BEACONS_ONLY = `
  query ImplementationVersionsBeaconsOnly {
    beacons(first: 100) {
      typeId
      typeName
      currentImplementation
      version
    }
  }
`;

// ────────────────────────────── snapshot ──────────────────────────────

export interface ModuleBeaconEntry {
  registered?: RegisteredContractRow;
  switchable?: SwitchableBeaconRow;
  globalBeacon?: BeaconRow;
}

export interface OrgBeaconSnapshot {
  /** Keyed by lowercased typeId. */
  byTypeId: Map<string, ModuleBeaconEntry>;
  /** Which queryWithFieldFallback tier answered (0 = richest). */
  tierIndex: number;
}

function lower(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value.toLowerCase() : null;
}

/**
 * Checksum an address that came from the subgraph (which lowercases them) so
 * subgraph-served values are byte-identical to the RPC-served ones the JSON
 * output has always carried. Returns null for anything unparseable/zero.
 */
export function checksumAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const addr = ethers.utils.getAddress(value);
    return addr === ethers.constants.AddressZero ? null : addr;
  } catch {
    return null;
  }
}

/** Build the per-typeId index from raw query rows (pure — unit testable). */
export function buildOrgBeaconSnapshot(data: {
  registeredContracts?: RegisteredContractRow[];
  switchableBeaconContracts?: SwitchableBeaconRow[];
  beacons?: BeaconRow[];
}, tierIndex = 0): OrgBeaconSnapshot {
  const byTypeId = new Map<string, ModuleBeaconEntry>();
  const entry = (typeId: string): ModuleBeaconEntry => {
    const key = typeId.toLowerCase();
    let e = byTypeId.get(key);
    if (!e) { e = {}; byTypeId.set(key, e); }
    return e;
  };

  for (const beacon of data.beacons ?? []) {
    if (beacon?.typeId) entry(beacon.typeId).globalBeacon = beacon;
  }
  for (const rc of data.registeredContracts ?? []) {
    if (rc?.typeId) entry(rc.typeId).registered = rc;
  }

  // Switchable beacons are joined through RegisteredContract.beacon (the exact
  // link) rather than through typeId, and NEVER through mirrorBeacon, which is
  // null on every live row.
  const switchableByAddress = new Map<string, SwitchableBeaconRow>();
  for (const sb of data.switchableBeaconContracts ?? []) {
    const key = lower(sb?.id);
    if (key) switchableByAddress.set(key, sb);
  }
  for (const e of byTypeId.values()) {
    const beaconAddr = lower(e.registered?.beacon);
    if (!beaconAddr) continue;
    const sb = switchableByAddress.get(beaconAddr);
    if (sb) e.switchable = sb;
  }

  return { byTypeId, tierIndex };
}

/**
 * Which implementation the org's module proxy currently delegates to, per the
 * subgraph. Returns null whenever the subgraph cannot answer with confidence —
 * the caller must then fall back to RPC. Never guesses.
 */
export function resolveImplementationFromSnapshot(
  snapshot: OrgBeaconSnapshot | null | undefined,
  typeId: string
): { implementation: string; version: string | null; mode: string } | null {
  const entry = snapshot?.byTypeId.get(typeId.toLowerCase());
  if (!entry) return null;

  const mode = entry.switchable?.mode ?? null;

  // The deployed mappings write exactly two strings: "Mirror" (handleMirrorSet /
  // autoUpgrade registration) and "Static" (handlePinned). "Pinned" is NOT one of
  // them — it is accepted only as a forward-compatible alias in case the schema is
  // ever renamed, so that a rename cannot silently reclassify a pinned beacon.
  if (mode === 'Static' || mode === 'Pinned') {
    // pinnedImplementation has never been observed populated on any live row
    // (there is not one pinned beacon on Gnosis or Arbitrum). Trust it only
    // when the row genuinely carries an address; otherwise fall back to RPC.
    const pinned = checksumAddress(entry.switchable?.pinnedImplementation);
    if (!pinned) return null;
    return { implementation: pinned, version: null, mode };
  }

  if (mode === 'Mirror') {
    // A Mirror beacon points at whatever SwitchableBeacon.setMirror(addr) was last
    // given, and that target only has to be a contract with a non-zero
    // implementation — nothing ties it to the POA global beacon for this typeId.
    // So joining the global beacon by typeId is only sound while the org still
    // mirrors the global beacon. mirrorBeacon is null on all 101 live rows because
    // the SwitchableBeacon CONSTRUCTOR sets it without emitting MirrorSet; the
    // first real setMirror populates it. When it is populated and disagrees with
    // the global beacon's address, fail closed to RPC rather than reporting the
    // global implementation with upToDate: true.
    const mirror = entry.switchable?.mirrorBeacon;
    const globalBeaconAddress = entry.globalBeacon?.beaconAddress;
    if (mirror && globalBeaconAddress && mirror.toLowerCase() !== globalBeaconAddress.toLowerCase()) {
      return null;
    }
    const impl = checksumAddress(entry.globalBeacon?.currentImplementation);
    if (!impl) return null;
    return { implementation: impl, version: entry.globalBeacon?.version ?? null, mode };
  }

  // Unknown/absent mode: a beacon we cannot classify may be pinned, and
  // assuming Mirror would report the wrong implementation. Fall back to RPC.
  return null;
}

/** Latest protocol implementation for a module type (PoaManager equivalent). */
export function latestImplementationFromSnapshot(
  snapshot: OrgBeaconSnapshot | null | undefined,
  typeId: string
): string | null {
  const beacon = snapshot?.byTypeId.get(typeId.toLowerCase())?.globalBeacon;
  return checksumAddress(beacon?.currentImplementation);
}

/**
 * Registration-time autoUpgrade HINT — NOT an OrgRegistry.isAutoUpgrade equivalent.
 *
 * The deployed subgraph writes RegisteredContract.autoUpgrade once, inside
 * handleContractRegistered, and never again: schema.graphql annotates it
 * "immutable, set at registration" and there is no AutoUpgradeSet handler at all.
 * OrgRegistry.setAutoUpgrade(orgId, typeId, bool) is a live mutator, so after an
 * executor turns auto-upgrade OFF this value keeps reporting the registration-time
 * `true` forever — and 91/91 live Gnosis rows are `true`, so the divergent case has
 * never once been exercised.
 *
 * Callers that render a pinning claim MUST prefer the on-chain isAutoUpgrade read
 * and use this only when OrgRegistry is unreachable (see org/status.ts).
 */
export function autoUpgradeFromSnapshot(
  snapshot: OrgBeaconSnapshot | null | undefined,
  typeId: string
): boolean | null {
  const rc = snapshot?.byTypeId.get(typeId.toLowerCase())?.registered;
  return typeof rc?.autoUpgrade === 'boolean' ? rc.autoUpgrade : null;
}

/** The proxy's beacon address, when indexed — lets callers skip getStorageAt. */
export function beaconAddressFromSnapshot(
  snapshot: OrgBeaconSnapshot | null | undefined,
  typeId: string
): string | null {
  return checksumAddress(snapshot?.byTypeId.get(typeId.toLowerCase())?.registered?.beacon);
}

/**
 * Fetch the org's module→beacon snapshot. Throws only on transport failure;
 * callers treat a throw as "no snapshot" and use their RPC path.
 */
export async function fetchOrgBeaconSnapshot(
  orgId: string,
  chainId?: number
): Promise<OrgBeaconSnapshot> {
  const tiers: FieldFallbackTier[] = [
    { query: ORG_MODULE_BEACONS_FULL, variables: { orgId, orgIdStr: orgId } },
    { query: ORG_MODULE_BEACONS_NO_SWITCHABLE, variables: { orgId } },
    { query: ORG_MODULE_BEACONS_MINIMAL, variables: {} },
  ];
  const { data, tierIndex } = await queryWithFieldFallback<any>(tiers, { chainId });
  return buildOrgBeaconSnapshot(data ?? {}, tierIndex);
}

// ────────────────────── implementation → version index ──────────────────────

export interface ImplementationVersionRow {
  typeName: string;
  version: string;
  implementation: string;
  /** True when this address is a global beacon's CURRENT implementation. */
  latest: boolean;
}

const PAGE_SIZE = 1000;
const MAX_PAGES = 5;

/**
 * Every implementation address the subgraph can name a version for, keyed by
 * lowercased address.
 *
 * Sources: Beacon.currentImplementation (the live one per type) and
 * BeaconUpgradeEvent.newImplementation (every implementation a global beacon
 * has ever pointed at). Verified live: 71 upgrade events on Gnosis with zero
 * null newImplementation/version values, and identical implementation
 * addresses on Arbitrum (deterministic deploys), so the index is chain-safe.
 *
 * NOT covered: an implementation that was registered but never promoted onto a
 * global beacon (only reachable by pinning to it). Callers keep the registry
 * eth_getLogs scan as the explicit fallback for exactly that case.
 */
export async function fetchImplementationVersionIndex(
  chainId?: number
): Promise<{ index: Map<string, ImplementationVersionRow>; tierIndex: number }> {
  const index = new Map<string, ImplementationVersionRow>();
  const typeNameById = new Map<string, string>();
  let tierIndex = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const tiers: FieldFallbackTier[] = [
      { query: IMPLEMENTATION_VERSIONS_FULL, variables: { first: PAGE_SIZE, skip: page * PAGE_SIZE } },
      { query: IMPLEMENTATION_VERSIONS_BEACONS_ONLY, variables: {} },
    ];
    const { data, tierIndex: tier } = await queryWithFieldFallback<any>(tiers, { chainId });
    tierIndex = tier;

    for (const beacon of (data?.beacons ?? []) as BeaconRow[]) {
      if (!beacon?.currentImplementation) continue;
      if (beacon.typeId) typeNameById.set(beacon.typeId.toLowerCase(), beacon.typeName);
      index.set(beacon.currentImplementation.toLowerCase(), {
        typeName: beacon.typeName,
        version: beacon.version ?? '',
        implementation: ethers.utils.getAddress(beacon.currentImplementation),
        latest: true,
      });
    }

    const events: Array<{ typeId: string; newImplementation: string; version: string }> =
      data?.beaconUpgradeEvents ?? [];
    for (const ev of events) {
      if (!ev?.newImplementation || !ev?.version) continue;
      const key = ev.newImplementation.toLowerCase();
      // A current implementation already recorded as `latest` must not be
      // demoted by its own historical upgrade event.
      if (index.has(key)) continue;
      index.set(key, {
        typeName: typeNameById.get(ev.typeId?.toLowerCase() ?? '') ?? '',
        version: ev.version,
        implementation: ethers.utils.getAddress(ev.newImplementation),
        latest: false,
      });
    }

    if (tier !== 0 || events.length < PAGE_SIZE) break;
  }

  return { index, tierIndex };
}
