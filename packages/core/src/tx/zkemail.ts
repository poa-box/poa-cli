/**
 * ZK Email transaction builders — port of `pop zkemail propose-allowlist`
 * (src/commands/zkemail/propose-allowlist.ts).
 *
 * `ZkEmailInvites.setActiveAllowlist(bytes32 root, bytes32 cidDigest)` is
 * onlyExecutor, so it cannot be sent directly by a member wallet — it goes
 * through a HybridVoting proposal whose option 0 executes the call from the
 * Executor. Same shape as the treasury governance wraps (./governance).
 *
 * Allowlist BUILDING is not here: the browser-pure ../zkemail module
 * (buildAllowlist, treeFromDoc, assertRootMatches, summarize, domainHash,
 * emailHash) already owns the Poseidon-hashed merkle construction —
 * `pop zkemail build-allowlist` is that module plus file I/O and an optional
 * pin, so hosts compose buildAllowlist + pinJson + ipfsCidToBytes32 directly.
 */

import { ethers } from 'ethers';
import type { TxIntent } from './intent';
import { getAbi } from '../contracts';
import { buildGovernanceProposal, ExecutionCall } from './governance';
import type { PopContext } from '../context';
import { resolveOrgModules } from '../reads/resolve';
import { fetchIndexedActiveRoot } from '../reads/zkemail';
import { buildProposalMetadata, serializeProposalMetadata } from '../metadata/proposal';
import { pinJson, fetchJson } from '../ipfs';
import { ipfsCidToBytes32, bytes32ToIpfsCid } from '../encoding';
import { assertRootMatches, summarize } from '../zkemail';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';

// ---------------------------------------------------------------------------
// Pure input normalization (the CLI's guards, verbatim messages)
// ---------------------------------------------------------------------------

/**
 * Normalize --root to bytes32. A zero root would make the module dormant and
 * revert every claim, so it is rejected. Port of the guard in
 * src/commands/zkemail/propose-allowlist.ts.
 */
export function normalizeAllowlistRoot(root: string): string {
  let normalized: string;
  try {
    normalized = ethers.utils.hexZeroPad(ethers.utils.hexlify(root), 32);
  } catch {
    throw new CliError(`--root "${root}" is not a valid bytes32.`, EXIT.USAGE);
  }
  if (normalized === ethers.constants.HashZero) {
    throw new CliError(
      'A zero root would make the module dormant and revert every claim.',
      EXIT.USAGE,
      'Pass the root printed by pop zkemail build-allowlist.'
    );
  }
  return normalized;
}

/**
 * Normalize --cid to the bytes32 digest the contract stores + the CIDv0 form.
 *
 * ipfsCidToBytes32 falls back to keccak256(string) for anything that is
 * neither a Qm… CIDv0 nor a 0x-bytes32, which yields a non-zero digest that
 * sails past a HashZero check and commits a dead pointer on-chain. Accept only
 * the two forms the contract can round-trip. Port of the guard in
 * src/commands/zkemail/propose-allowlist.ts.
 */
export function normalizeAllowlistCid(cid: string): { cidDigest: string; cidV0: string | null } {
  const isCidV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid);
  const isBytes32 = /^0x[0-9a-fA-F]{64}$/.test(cid);
  if (!isCidV0 && !isBytes32) {
    throw new CliError(
      `--cid "${cid}" is not a CIDv0 (Qm…) or a 0x bytes32 digest.`,
      EXIT.USAGE,
      cid.startsWith('baf')
        ? 'That looks like a CIDv1. The contract stores a raw 32-byte multihash digest, so the '
          + 'file must be pinned as CIDv0 — re-pin with --cid-version=0 (pop pins CIDv0 by default).'
        : 'Pass the CID printed by pop zkemail build-allowlist --pin.'
    );
  }
  const cidDigest = ipfsCidToBytes32(cid);
  if (cidDigest === ethers.constants.HashZero) {
    throw new CliError(`--cid "${cid}" did not decode to a valid digest.`, EXIT.USAGE);
  }
  return { cidDigest, cidV0: isCidV0 ? cid : bytes32ToIpfsCid(cidDigest) };
}

// ---------------------------------------------------------------------------
// Level 1 — pure builder
// ---------------------------------------------------------------------------

export interface SetAllowlistProposalArgs {
  hybridVotingAddress: string;
  zkEmailInvitesAddress: string;
  /** Normalized bytes32 (see normalizeAllowlistRoot). */
  root: string;
  /** bytes32 multihash digest (see normalizeAllowlistCid). */
  cidDigest: string;
  descriptionHash: string;
  durationMinutes: ethers.BigNumberish;
  orgId?: string;
  summary?: Record<string, unknown>;
  ipfs?: { cid: string; metadata: unknown };
}

/**
 * Port of `pop zkemail propose-allowlist` —
 * src/commands/zkemail/propose-allowlist.ts. HybridVoting.createProposal
 * wrapping [[zkEmailInvites, 0, setActiveAllowlist(root, cidDigest)], []]
 * (setActiveAllowlist is onlyExecutor).
 */
export function buildSetAllowlistProposal(a: SetAllowlistProposalArgs): TxIntent {
  const iface = new ethers.utils.Interface(getAbi('ZkEmailInvites'));
  const call = iface.encodeFunctionData('setActiveAllowlist', [a.root, a.cidDigest]);
  const calls: ExecutionCall[] = [
    { target: a.zkEmailInvitesAddress, value: ethers.BigNumber.from(0), calldata: call },
  ];

  return buildGovernanceProposal({
    votingAddress: a.hybridVotingAddress,
    votingAbiName: 'HybridVotingNew',
    title: 'Set ZK Email invite allowlist',
    descriptionHash: a.descriptionHash,
    durationMinutes: a.durationMinutes,
    numOptions: 2,
    batches: [calls, []], // option 0 = set, option 1 = keep current
    hatIds: [],
    domain: 'zkemail',
    action: 'propose-allowlist',
    orgId: a.orgId,
    summary: a.summary ?? { module: a.zkEmailInvitesAddress, newRoot: a.root },
    ipfs: a.ipfs,
  });
}

// ---------------------------------------------------------------------------
// Level 2 — resolved builder
// ---------------------------------------------------------------------------

export interface ProposeAllowlistParams {
  org: string;
  /** Merkle root from build-allowlist (../zkemail buildAllowlist). */
  root: string;
  /** IPFS CIDv0 (Qm…) of the pinned allowlist file, or its 0x-bytes32 digest. */
  cid: string;
  /** Voting window in minutes (CLI default 1440 = 24h). */
  durationMinutes?: number;
  /** Skip fetching the pinned file to confirm it reproduces --root (not recommended). */
  skipVerify?: boolean;
}

/**
 * Resolved port of `pop zkemail propose-allowlist` —
 * src/commands/zkemail/propose-allowlist.ts.
 *
 * Guards replicated from the CLI:
 *   - root != HashZero; --cid restricted to CIDv0 or 0x-bytes32 (the keccak
 *     fallback of ipfsCidToBytes32 would commit a dead pointer)
 *   - unless skipVerify, the pinned file is fetched and assertRootMatches
 *     confirms it reproduces the root being committed (a mismatch costs a full
 *     governance cycle to undo)
 *   - the CURRENT root (display + metadata) comes from the indexed activeRoot,
 *     identity-guarded, with merkleRoot() as the on-chain fallback
 *   - module.executor() vs the org's Executor mismatch fails fast — the
 *     Unauthorized revert would otherwise only surface AFTER the full vote.
 *     `executor` deliberately stays on-chain (it gates that check, the one
 *     place subgraph lag is unacceptable in this command), so the check runs
 *     only when ctx.provider is supplied.
 */
export async function proposeAllowlistIntent(ctx: PopContext, params: ProposeAllowlistParams): Promise<TxIntent> {
  const durationMinutes = params.durationMinutes ?? 1440;

  const modules = await resolveOrgModules(ctx.client, params.org, ctx.chainId);
  const orgId = modules.orgId;
  const moduleAddr = modules.zkEmailInvitesAddress;
  if (!moduleAddr) {
    throw new CliError(
      `Org ${orgId} has no ZkEmailInvites module.`,
      EXIT.PRECONDITION,
      'ZK Email invites are opt-in per org — the module is wired at deploy time via '
        + 'OrgDeployer.deployFullOrgWithZkEmail.'
    );
  }
  const hybridVotingAddr = modules.hybridVotingAddress;
  if (!hybridVotingAddr) {
    throw new CliError(
      `Org "${orgId}" has no HybridVoting module, so an executor-gated call cannot be proposed.`,
      EXIT.PRECONDITION
    );
  }

  // Normalize the root and CID.
  const root = normalizeAllowlistRoot(params.root);
  const { cidDigest, cidV0 } = normalizeAllowlistCid(params.cid);

  // Verify the pinned file actually reproduces the root being committed.
  let entrySummary = '(not verified)';
  if (!params.skipVerify) {
    const doc = await fetchJson<any>(cidV0 || params.cid, ctx.ipfs);
    if (!doc) {
      throw new CliError(
        `Could not fetch allowlist ${cidV0 || params.cid} from IPFS.`,
        EXIT.INFRA,
        'Pin the file before proposing, or pass --skip-verify if you are certain it is retrievable.'
      );
    }
    // Mismatch here means --root and --cid disagree; committing them would cost a full
    // governance cycle to undo, so fail before the proposal exists.
    assertRootMatches(doc, root, 'root you are proposing (--root)');
    const s = summarize(doc);
    entrySummary = `${doc.entries?.length ?? 0} entries (${s.domains.length} domain, ${s.emails.length} specific)`;
  }

  // Read the current commit so the diff is visible in the metadata.
  //
  // The root is DISPLAY ONLY (the proposal description), so it comes from the
  // indexed ZkEmailInvites.activeRoot. A module row that exists with a null
  // activeRoot is dormant, exactly what merkleRoot() == 0 means on-chain; a
  // MISSING row means "not indexed yet" and falls back to the contract so a
  // brand-new module still renders its real root.
  const indexedRoot = await fetchIndexedActiveRoot(ctx.client, orgId, moduleAddr, ctx.chainId);
  let currentRoot: string;
  let moduleExecutor: string | null = null;
  if (ctx.provider) {
    const readModule = new ethers.Contract(moduleAddr, getAbi('ZkEmailInvites'), ctx.provider);
    [currentRoot, moduleExecutor] = await Promise.all([
      indexedRoot != null ? Promise.resolve(indexedRoot) : (readModule.merkleRoot() as Promise<string>),
      readModule.executor() as Promise<string>,
    ]);
  } else if (indexedRoot != null) {
    currentRoot = indexedRoot;
  } else {
    throw new CliError(
      'The module is not indexed yet and no provider was supplied — cannot read the current allowlist root.',
      EXIT.INFRA,
      'Pass a provider in the context, or retry once the subgraph has indexed the module.'
    );
  }

  // setActiveAllowlist is onlyExecutor, and the proposal executes from the org's Executor.
  // If the module answers to a different one the call reverts Unauthorized only AFTER the
  // full voting window — check now, while it is still free.
  const orgExecutor = modules.executorAddress;
  if (moduleExecutor && orgExecutor && moduleExecutor.toLowerCase() !== orgExecutor.toLowerCase()) {
    throw new CliError(
      `The ZkEmailInvites module answers to executor ${moduleExecutor}, but this org's Executor `
        + `is ${orgExecutor}. A proposal from this org could never execute the call.`,
      EXIT.PRECONDITION,
      'The module was deployed against a different executor, or the executor was rotated. '
        + 'Re-wire the module before proposing.'
    );
  }

  const metadata = buildProposalMetadata({
    description:
      `Set the ZK Email invite allowlist to root ${root} (IPFS ${cidV0 ?? params.cid}). `
      + `${entrySummary}. Replaces ${currentRoot === ethers.constants.HashZero ? 'no active allowlist' : currentRoot}. `
      + 'Anyone who can prove a DKIM-signed email from an allowlisted domain or address may then claim the listed role hats.',
    optionNames: ['Set this allowlist', 'Keep the current allowlist'],
  });
  const metaCid = await pinJson(serializeProposalMetadata(metadata), ctx.ipfs);
  const descriptionHash = ipfsCidToBytes32(metaCid);

  return buildSetAllowlistProposal({
    hybridVotingAddress: hybridVotingAddr,
    zkEmailInvitesAddress: moduleAddr,
    root,
    cidDigest,
    descriptionHash,
    durationMinutes,
    orgId,
    summary: {
      module: moduleAddr,
      newRoot: root,
      cid: cidV0 ?? params.cid,
      currentRoot,
      allowlist: entrySummary,
    },
    ipfs: { cid: metaCid, metadata },
  });
}
