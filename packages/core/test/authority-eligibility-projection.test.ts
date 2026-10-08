import { describe, expect, it } from 'vitest';
import { projectAuthorityMembership, readAuthorityMemberships } from '../src/reads/authority';

const row = (overrides: any = {}) => ({
  id: '7-0xmember', user: '0xmember', accepted: false, acceptedAt: null, seededWhilePaused: false,
  eligible: true, isMember: false, claimable: true, ruleKind: 'None', emailVerified: false,
  eligibilitySource: 'SubjectDefault', vouchCount: 3, vouchEpoch: '1', vouchMet: true,
  subject: { id: '7', subjectId: '7', kind: 'Role', defaultAllow: false, vouchConfig: { quorum: 2, epoch: '1' } },
  ...overrides,
});

describe('current eligibility from authority inputs', () => {
  it('invalidates unaccepted cached vouches after an epoch reset while preserving their indexed provenance', () => {
    const before = row();
    before.subject.vouchConfig.epoch = '2';
    const result = projectAuthorityMembership(before);
    expect(result).toMatchObject({ id: before.id, vouchCount: 3, effectiveVouchCount: 0, vouchMet: false,
      eligible: false, claimable: false, isMember: false, eligibilitySource: 'None',
      membershipProjection: 'current-authority-inputs', indexedEligibility: { eligible: true, claimable: true, vouchMet: true } });
    expect(before.claimable).toBe(true);
  });

  it.each([
    { allow: false, cached: true, expected: false },
    { allow: true, cached: false, expected: true },
  ])('re-folds an unaccepted seat after a default flip to $allow', ({ allow, cached, expected }) => {
    const result = projectAuthorityMembership(row({ eligible: cached, claimable: cached,
      subject: { id: '7', subjectId: '7', kind: 'Role', defaultAllow: allow, vouchConfig: null } }));
    expect(result).toMatchObject({ eligible: expected, claimable: expected, isMember: false });
  });

  it.each([
    { quorum: 4, cached: true, expected: false },
    { quorum: 2, cached: false, expected: true },
    { quorum: 0, cached: true, expected: false },
  ])('re-folds the unaccepted vouch arm when quorum becomes $quorum', ({ quorum, cached, expected }) => {
    const result = projectAuthorityMembership(row({ eligible: cached, claimable: cached, vouchMet: cached,
      subject: { id: '7', kind: 'Role', defaultAllow: false, vouchConfig: { quorum, epoch: '1' } } }));
    expect(result).toMatchObject({ vouchMet: expected, eligible: expected, claimable: expected, effectiveVouchCount: 3 });
  });

  it('preserves ban supremacy and a renounced sticky grant independently of stale vouch eligibility', () => {
    expect(projectAuthorityMembership(row({ ruleKind: 'Ban', emailVerified: true })))
      .toMatchObject({ eligible: false, claimable: false, eligibilitySource: 'ExplicitBan' });
    const offer = row({ ruleKind: 'Grant', pendingAction: { action: 'Offer', status: 'Pending', activatesAt: '9999999999' },
      subject: { id: '7', kind: 'Role', defaultAllow: false, vouchConfig: null } });
    expect(projectAuthorityMembership(offer)).toMatchObject({ eligible: true, claimable: true, isMember: false,
      eligibilitySource: 'ExplicitGrant', pendingAction: offer.pendingAction });
  });

  it('returns cache provenance for incomplete low-level input without fabricating fold inputs', () => {
    expect(projectAuthorityMembership({ accepted: true, isMember: true, subject: { kind: 'Role' } }))
      .toMatchObject({ isMember: true, membershipProjection: 'indexed-cache' });
  });

  it('uses current subject inputs in the actual paginated read, not a second mutable snapshot', async () => {
    const query = async (document: string) => {
      expect(document).toContain('name defaultAllow vouchConfig { quorum epoch }');
      return { subjectMemberships: [row({ subject: { id: '7', kind: 'Role', defaultAllow: false, vouchConfig: null } })] };
    };
    expect((await readAuthorityMemberships({ query } as any, 'org'))[0])
      .toMatchObject({ eligible: false, claimable: false, membershipProjection: 'current-authority-inputs' });
  });
});
