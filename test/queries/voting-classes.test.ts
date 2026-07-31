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

  it('drops deactivated rows and returns [] when nothing matches', () => {
    expect(selectClassSnapshot(rows, '999')).toEqual([]);
    expect(selectClassSnapshot([], '100')).toEqual([]);
    expect(selectClassSnapshot(undefined, '100')).toEqual([]);
    expect(selectClassSnapshot([cls({ isActive: false })], null)).toEqual([]);
  });
});
