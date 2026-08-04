/**
 * Voting-class queries — the subgraph mirror of HybridVoting.getClasses() /
 * getProposalClasses(id) plus the two DISTINCT validity parameters
 * (thresholdPct = % of weighted power, quorum = raw voter count).
 *
 * Model (verified live against poa-gnosis-v-1 and poa-arb-v-1):
 *   HybridVotingContract { thresholdPct, quorum, classVersion, votingClasses }
 *   VotingClass          { version, classIndex, strategy, slicePct, quadratic,
 *                          minBalance, asset, hatIds, isActive }
 *   Proposal             { classesVersion }   ← the frozen snapshot pointer
 *
 * A VotingClass row is NOT unique per contract — every setClasses() writes a
 * fresh `version` (the block number) and keeps the old rows around, which is
 * exactly what makes the per-proposal snapshot reconstructable. So every read
 * here is "fetch the contract's class rows, then pick one version":
 *   live config      → version == HybridVotingContract.classVersion
 *   proposal snapshot→ version == Proposal.classesVersion
 *
 * Deployment tiering (src/lib/subgraph.ts queryWithFieldFallback): GraphQL
 * validates a document as a whole, so `classVersion` — absent on subgraph
 * deployments older than the class-versioning release — has to live in its own
 * tier. The proposal-snapshot query deliberately has NO legacy tier: without
 * `classesVersion` there is no way to identify the frozen snapshot, and
 * silently showing the CURRENT classes for an old proposal would be worse than
 * falling back to the on-chain getProposalClasses call.
 */

/** Field set shared by every VotingClass selection. */
const VOTING_CLASS_FIELDS = `
      version
      classIndex
      strategy
      slicePct
      quadratic
      minBalance
      asset
      hatIds
      isActive`;

/** Live class config + threshold/quorum. Tier 0 — has classVersion. */
export const FETCH_VOTING_CLASS_CONFIG = `
  query FetchVotingClassConfig($hybridVoting: ID!) {
    hybridVotingContract(id: $hybridVoting) {
      id
      thresholdPct
      quorum
      classVersion
      votingClasses(first: 1000) {${VOTING_CLASS_FIELDS}
      }
    }
  }
`;

/**
 * Live class config, tier 1 — for deployments that predate `classVersion`.
 * Without it the current version is recovered as max(version), which is
 * correct as long as setClasses versions increase monotonically (they are
 * block numbers, so they do).
 */
export const FETCH_VOTING_CLASS_CONFIG_LEGACY = `
  query FetchVotingClassConfigLegacy($hybridVoting: ID!) {
    hybridVotingContract(id: $hybridVoting) {
      id
      thresholdPct
      quorum
      votingClasses(first: 1000) {${VOTING_CLASS_FIELDS}
      }
    }
  }
`;

/** Class snapshot frozen for one proposal + threshold/quorum. Single tier. */
export const FETCH_PROPOSAL_VOTING_CLASSES = `
  query FetchProposalVotingClasses($hybridVoting: ID!, $proposalId: BigInt!) {
    hybridVotingContract(id: $hybridVoting) {
      id
      thresholdPct
      quorum
      proposals(where: { proposalId: $proposalId }) {
        proposalId
        classesVersion
      }
      votingClasses(first: 1000) {${VOTING_CLASS_FIELDS}
      }
    }
  }
`;

/**
 * Everything `pop vote analyze` needs in ONE round-trip: the frozen class
 * snapshot, every ballot with its per-class raw power (Vote.classRawPowers is
 * the exact quantity the command used to reconstruct from VoteCast logs), and
 * the org's username map for display names.
 */
export const FETCH_PROPOSAL_VOTE_ANALYSIS = `
  query FetchProposalVoteAnalysis($hybridVoting: ID!, $proposalId: BigInt!) {
    hybridVotingContract(id: $hybridVoting) {
      id
      organization {
        id
        users(first: 100) {
          address
          account { username }
        }
      }
      proposals(where: { proposalId: $proposalId }) {
        proposalId
        classesVersion
        votes(first: 1000, orderBy: votedAt, orderDirection: asc) {
          voter
          voterUsername
          optionIndexes
          optionWeights
          classRawPowers
        }
      }
      votingClasses(first: 1000) {${VOTING_CLASS_FIELDS}
      }
    }
  }
`;

/** One VotingClass row as returned by the subgraph (all scalars are strings/numbers). */
export interface SubgraphVotingClass {
  version: string;
  classIndex: number;
  strategy: string;
  slicePct: number;
  quadratic: boolean;
  minBalance: string;
  asset: string;
  hatIds: string[];
  isActive: boolean;
}

/** True when two rows claim the same classIndex, i.e. two configs are mixed together. */
function hasRepeatedClassIndex(rows: SubgraphVotingClass[]): boolean {
  const seen = new Set<number>();
  for (const r of rows) {
    const i = Number(r.classIndex);
    if (seen.has(i)) return true;
    seen.add(i);
  }
  return false;
}

/**
 * Pick the class rows belonging to one config version and order them by
 * classIndex (the on-chain array order the whole slice/quorum math assumes).
 *
 * `version` null/undefined means the caller could not learn which version to
 * use (legacy deployment without classVersion) — then the newest indexed
 * version wins, which reproduces getClasses() but must NEVER be used to
 * reconstruct an old proposal's frozen snapshot.
 *
 * `isActive` deliberately does NOT filter the version-pinned path. It means
 * "belongs to the config that is live right now", so a proposal created under
 * a since-replaced config has an entirely inactive snapshot — filtering on it
 * first would drop every row and report "no answer" for exactly the proposals
 * the snapshot machinery exists to serve. It is only used to pick a version
 * when the caller has none, and to break the ambiguity below.
 *
 * `version` is the contract's `block.number`, not a per-setClasses id, so it is
 * not unique: two setClasses share it in one block on Gnosis, and on Arbitrum
 * `block.number` is the L1 block, which spans ~48 indexed L2 blocks. When two
 * emissions share a version their classIndex values repeat; summing them would
 * yield slice percentages over 100.
 *
 * Returns [] when nothing matches, which callers treat as "subgraph can't
 * answer this" and fall back to the contract.
 */
export function selectClassSnapshot(
  rows: SubgraphVotingClass[] | undefined | null,
  version: string | number | null | undefined
): SubgraphVotingClass[] {
  const all = (rows ?? []).filter(r => !!r);

  let target = version === null || version === undefined ? null : String(version);
  if (target === null) {
    // Nothing pins the version, so the live rows are the only ones that identify
    // the current config. Versions are block numbers and exceed 2^53 on some
    // chains, so this comparison must not go through Number.
    target = all
      .filter(r => r.isActive !== false)
      .reduce((max, r) => {
        const v = String(r.version);
        if (max === null) return v;
        return BigInt(v) > BigInt(max) ? v : max;
      }, null as string | null);
    if (target === null) return [];
  }

  let matched = all.filter(r => String(r.version) === target);

  if (hasRepeatedClassIndex(matched)) {
    // Two emissions share this version. The live one is still identifiable; a
    // superseded one is not, without the per-emission pointer newer subgraphs
    // expose. Blending them would report slices summing past 100, so say
    // nothing and leave it to the caller's contract fallback. That fallback is
    // not always free — `vote analyze` re-derives voters from a ~200k-block
    // VoteCast window and throws for older proposals — but a wrong tally is
    // worse than a loud one, and this path is unreachable until two setClasses
    // land on one version.
    const live = matched.filter(r => r.isActive !== false);
    if (live.length === 0 || hasRepeatedClassIndex(live)) return [];
    matched = live;
  }

  return matched.sort((a, b) => Number(a.classIndex) - Number(b.classIndex));
}
