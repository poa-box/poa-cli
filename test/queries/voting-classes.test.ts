/**
 * Voting-class query documents + snapshot selection.
 *
 * VotingClass rows accumulate: every setClasses() writes a new `version` and
 * the old rows stay indexed. Picking the WRONG version silently reports the
 * wrong slice percentages, which is the number every counterfactual in
 * `pop vote analyze` and every table in `pop vote classes show` is built on —
 * so the selection rule gets its own tests.
 */

import { describe, it, expect } from 'vitest';
import {
  FETCH_VOTING_CLASS_CONFIG,
  FETCH_VOTING_CLASS_CONFIG_LEGACY,
  FETCH_PROPOSAL_VOTING_CLASSES,
  FETCH_PROPOSAL_VOTE_ANALYSIS,
  selectClassSnapshot,
  SubgraphVotingClass,
} from '../../src/queries/voting-classes';

function cls(overrides: Partial<SubgraphVotingClass>): SubgraphVotingClass {
  return {
    version: '100',
    classIndex: 0,
    strategy: 'DIRECT',
    slicePct: 50,
    quadratic: false,
    minBalance: '0',
    asset: '0x0000000000000000000000000000000000000000',
    hatIds: [],
    isActive: true,
    ...overrides,
  };
}

describe('voting-class query documents', () => {
  it('tier 0 asks for classVersion and tier 1 does not (deployments predating class versioning)', () => {
    expect(FETCH_VOTING_CLASS_CONFIG).toContain('classVersion');
    expect(FETCH_VOTING_CLASS_CONFIG_LEGACY).not.toContain('classVersion');
    // Both tiers must still carry the two validity parameters, otherwise the
    // fallback tier would silently drop threshold/quorum from the output.
    for (const doc of [FETCH_VOTING_CLASS_CONFIG, FETCH_VOTING_CLASS_CONFIG_LEGACY]) {
      expect(doc).toContain('thresholdPct');
      expect(doc).toContain('quorum');
      expect(doc).toContain('slicePct');
      expect(doc).toContain('quadratic');
      expect(doc).toContain('minBalance');
      expect(doc).toContain('hatIds');
    }
  });

  it('the proposal-snapshot query pins the frozen version and has no legacy tier', () => {
    expect(FETCH_PROPOSAL_VOTING_CLASSES).toContain('classesVersion');
    expect(FETCH_PROPOSAL_VOTING_CLASSES).toContain('$proposalId: BigInt!');
  });

  it('the analyze query pulls classRawPowers — the exact per-class power it used to derive', () => {
    expect(FETCH_PROPOSAL_VOTE_ANALYSIS).toContain('classRawPowers');
    expect(FETCH_PROPOSAL_VOTE_ANALYSIS).toContain('optionWeights');
    expect(FETCH_PROPOSAL_VOTE_ANALYSIS).toContain('classesVersion');
    expect(FETCH_PROPOSAL_VOTE_ANALYSIS).toContain('orderBy: votedAt');
  });
});

describe('selectClassSnapshot', () => {
  const rows = [
    cls({ version: '200', classIndex: 1, strategy: 'ERC20_BAL', slicePct: 30 }),
    cls({ version: '100', classIndex: 0, slicePct: 50 }),
    cls({ version: '200', classIndex: 0, slicePct: 70 }),
    cls({ version: '100', classIndex: 1, strategy: 'ERC20_BAL', slicePct: 50 }),
  ];

  it('returns only the requested version, ordered by classIndex', () => {
    const picked = selectClassSnapshot(rows, '100');
    expect(picked.map(c => c.classIndex)).toEqual([0, 1]);
    expect(picked.map(c => c.slicePct)).toEqual([50, 50]);
  });

  it('accepts a numeric version as well as a string (subgraph BigInt comes back as string)', () => {
    expect(selectClassSnapshot(rows, 200).map(c => c.slicePct)).toEqual([70, 30]);
  });

  it('falls back to the NEWEST version when no version is known (legacy deployments)', () => {
    // Versions are block numbers and exceed 2^53 on some chains, so the
    // comparison must not go through Number.
    const big = [
      cls({ version: '9007199254740993', classIndex: 0, slicePct: 60 }),
      cls({ version: '9007199254740992', classIndex: 0, slicePct: 10 }),
    ];
    expect(selectClassSnapshot(big, null).map(c => c.slicePct)).toEqual([60]);
    expect(selectClassSnapshot(rows, undefined).map(c => c.slicePct)).toEqual([70, 30]);
  });

  it('returns [] when nothing matches', () => {
    expect(selectClassSnapshot(rows, '999')).toEqual([]);
    expect(selectClassSnapshot([], '100')).toEqual([]);
    expect(selectClassSnapshot(undefined, '100')).toEqual([]);
    // No version pinned and no live row: nothing identifies a current config.
    expect(selectClassSnapshot([cls({ isActive: false })], null)).toEqual([]);
  });

  // isActive means "belongs to the config live RIGHT NOW". Every superseded
  // version is false, so filtering on it before pinning the version returns
  // nothing for exactly the proposals a frozen snapshot exists to serve.
  it('keeps a superseded version when it is the one asked for', () => {
    const superseded = [
      cls({ version: '100', classIndex: 0, slicePct: 60, isActive: false }),
      cls({ version: '100', classIndex: 1, slicePct: 40, isActive: false }),
      cls({ version: '200', classIndex: 0, slicePct: 30, isActive: true }),
      cls({ version: '200', classIndex: 1, slicePct: 70, isActive: true }),
    ];

    const picked = selectClassSnapshot(superseded, '100');
    expect(picked.map(c => c.classIndex)).toEqual([0, 1]);
    expect(picked.map(c => c.slicePct)).toEqual([60, 40]);

    // The live version still resolves, pinned or not.
    expect(selectClassSnapshot(superseded, '200').map(c => c.slicePct)).toEqual([30, 70]);
    expect(selectClassSnapshot(superseded, null).map(c => c.slicePct)).toEqual([30, 70]);
  });

  // `version` is the contract's block.number, so it is NOT unique per setClasses:
  // two land in one block on Gnosis, and on Arbitrum block.number is the L1
  // block, which spans ~48 indexed L2 blocks.
  describe('when two setClasses share a version', () => {
    const collided = (secondActive: boolean) => [
      cls({ version: '100', classIndex: 0, slicePct: 60, isActive: false }),
      cls({ version: '100', classIndex: 1, slicePct: 40, isActive: false }),
      cls({ version: '100', classIndex: 0, slicePct: 30, isActive: secondActive }),
      cls({ version: '100', classIndex: 1, slicePct: 70, isActive: secondActive }),
    ];

    it('picks the live config rather than blending both', () => {
      const picked = selectClassSnapshot(collided(true), '100');
      expect(picked.map(c => c.classIndex)).toEqual([0, 1]);
      expect(picked.map(c => c.slicePct)).toEqual([30, 70]);
      // Blending would sum to 200 and double every slice.
      expect(picked.reduce((n, c) => n + c.slicePct, 0)).toBe(100);
    });

    it('returns [] when the shared version is itself superseded, so the contract answers', () => {
      // Both emissions inactive: nothing distinguishes them without the
      // per-emission pointer, and a blended answer would be wrong.
      expect(selectClassSnapshot(collided(false), '100')).toEqual([]);
    });
  });
});
