import { describe, it, expect } from 'vitest';
import {
  FETCH_PROJECTS_DATA,
  FETCH_PROJECTS_DATA_LEGACY,
  FETCH_PROJECTS_DATA_WITH_RELEASES,
  PROJECTS_DATA_TIERS,
  projectsDataTiers,
  FETCH_TASK_RELEASE_HISTORY,
  FETCH_TASK_RELEASE_HISTORY_LEGACY,
  FETCH_ORG_TASK_RELEASES,
  chainIndexesTaskReleases,
} from '../../src/queries/task';

/**
 * The projects document is served through three tiers: v7 releases (Gnosis only), v6 deadlines
 * (Arbitrum today), and pre-#192 legacy. Each tier is DERIVED from FETCH_PROJECTS_DATA by a
 * line-anchored regex, so a purely cosmetic reflow of the source document can make a derivation
 * match nothing and produce a tier byte-identical to its neighbour. `queryWithFieldFallback`
 * then retries the same failing document, the fallback stops working, and nothing anywhere
 * says so — the read just fails on the chain the tier existed to rescue.
 *
 * These are pure string assertions over the exported documents: no mocks, no network.
 */

const RELEASE_FIELDS = ['releaseCount', 'lastReleasedAt'];
const V6_DEADLINE_FIELDS = ['completionWindow', 'absoluteDeadline', 'claimDeadline', 'reclaimCount'];

const onOwnLine = (doc: string, field: string) =>
  (doc.match(new RegExp(`^\\s*${field}\\s*$`, 'gm')) || []).length;

const ALL_TIER_DOCS = [
  ['withReleases', FETCH_PROJECTS_DATA_WITH_RELEASES],
  ['base', FETCH_PROJECTS_DATA],
  ['legacy', FETCH_PROJECTS_DATA_LEGACY],
  ['releaseHistory', FETCH_TASK_RELEASE_HISTORY],
  ['releaseHistoryLegacy', FETCH_TASK_RELEASE_HISTORY_LEGACY],
  ['orgReleases', FETCH_ORG_TASK_RELEASES],
] as const;

describe('projects data tiers', () => {
  it('tier 0 requests both release fields, each alone on its own line', () => {
    for (const f of RELEASE_FIELDS) {
      expect(onOwnLine(FETCH_PROJECTS_DATA_WITH_RELEASES, f), `${f} must be on its own line`).toBe(1);
    }
  });

  it('tier 0 is genuinely richer than tier 1 — the insertion actually fired', () => {
    // The load-bearing assertion. FETCH_PROJECTS_DATA_WITH_RELEASES is built by .replace() on the
    // `reclaimCount` anchor; rename or reflow that anchor and the replace silently no-ops, leaving
    // tier 0 identical to tier 1. queryWithFieldFallback would then retry the same failing document
    // — the fallback is dead and there is no visible symptom.
    expect(FETCH_PROJECTS_DATA_WITH_RELEASES).not.toBe(FETCH_PROJECTS_DATA);
    expect(FETCH_PROJECTS_DATA_WITH_RELEASES.length).toBeGreaterThan(FETCH_PROJECTS_DATA.length);
  });

  it('tier 1 has no release fields but keeps every v6 deadline field', () => {
    for (const f of RELEASE_FIELDS) {
      expect(FETCH_PROJECTS_DATA, `${f} must not reach Arbitrum`).not.toContain(f);
    }
    for (const f of V6_DEADLINE_FIELDS) {
      expect(onOwnLine(FETCH_PROJECTS_DATA, f), `${f} must survive in tier 1`).toBeGreaterThan(0);
    }
  });

  it('tier 2 has neither the release fields nor the v6 deadline fields', () => {
    for (const f of [...RELEASE_FIELDS, ...V6_DEADLINE_FIELDS]) {
      expect(FETCH_PROJECTS_DATA_LEGACY, `${f} must be stripped from the legacy tier`).not.toContain(f);
    }
  });

  it('tier 0 minus the two release lines is exactly tier 1', () => {
    // Proves the insertion disturbed nothing else — no reordered field, no altered argument.
    const stripped = FETCH_PROJECTS_DATA_WITH_RELEASES
      .split('\n')
      .filter((line) => !/^\s*(releaseCount|lastReleasedAt)\s*$/.test(line))
      .join('\n');
    expect(stripped).toBe(FETCH_PROJECTS_DATA);
  });

  it('orders the tiers richest-first', () => {
    expect(PROJECTS_DATA_TIERS).toEqual([
      FETCH_PROJECTS_DATA_WITH_RELEASES,
      FETCH_PROJECTS_DATA,
      FETCH_PROJECTS_DATA_LEGACY,
    ]);
  });

  it('binds orgId into every tier for queryWithFieldFallback', () => {
    expect(projectsDataTiers('0xabc')).toEqual([
      { query: FETCH_PROJECTS_DATA_WITH_RELEASES, variables: { orgId: '0xabc' } },
      { query: FETCH_PROJECTS_DATA, variables: { orgId: '0xabc' } },
      { query: FETCH_PROJECTS_DATA_LEGACY, variables: { orgId: '0xabc' } },
    ]);
  });
});

describe('task release history tiers', () => {
  it('the legacy tier drops every v7 field and is shorter for it', () => {
    for (const f of ['releases', ...RELEASE_FIELDS]) {
      expect(FETCH_TASK_RELEASE_HISTORY_LEGACY, `${f} must not appear in the legacy tier`).not.toContain(f);
    }
    expect(FETCH_TASK_RELEASE_HISTORY_LEGACY.length).toBeLessThan(FETCH_TASK_RELEASE_HISTORY.length);
  });
});

describe('org task releases document', () => {
  it('keeps every variable scalar and the where/orderBy args inline', () => {
    // An `orderBy`/`where` a deployment does not know yields "Invalid value provided for argument
    // `where`" / "Variable `w` must have an input type". None of isUnknownFieldError's five regexes
    // match those, so a filter-typed variable would escape the tier machinery entirely and kill the
    // command instead of degrading to a lower tier.
    const varList = FETCH_ORG_TASK_RELEASES.match(/query\s+\w+\(([^)]*)\)/)?.[1];
    expect(varList).toBeDefined();
    expect(varList).not.toMatch(/_filter/);
    expect(varList!.replace(/\s+/g, ' ').trim())
      .toBe('$taskManager: Bytes!, $first: Int!, $skip: Int!');
    expect(FETCH_ORG_TASK_RELEASES).toContain('where: { task_: { taskManager: $taskManager } }');
    expect(FETCH_ORG_TASK_RELEASES).toContain('orderBy: releasedAt');
  });
});

describe('every task tier document', () => {
  it('is brace-balanced with no empty selection set', () => {
    for (const [name, doc] of ALL_TIER_DOCS) {
      expect((doc.match(/\{/g) || []).length, `${name} brace balance`).toBe((doc.match(/\}/g) || []).length);
      // A stripped field must never leave `foo { }`, which is invalid GraphQL.
      expect(doc, `${name} has an empty selection set`).not.toMatch(/\{\s*\}/);
    }
  });

  it('carries no comment quoting a validation-error phrase', () => {
    // isUnknownFieldError also inspects error.message, and graphql-request v6's ClientError embeds
    // a JSON dump of the whole request — query text included — there. A `#` comment quoting one of
    // those phrases would make EVERY error from that document look like a validation error, so the
    // tier loop would silently swallow real network failures and fall through to a lower tier.
    for (const [name, doc] of ALL_TIER_DOCS) {
      const comments = doc
        .split('\n')
        .filter((line) => line.includes('#'))
        .map((line) => line.slice(line.indexOf('#')))
        .join('\n');
      expect(comments, `${name} comment quotes "has no field"`).not.toMatch(/has no field/i);
      expect(comments, `${name} comment quotes "cannot query field"`).not.toMatch(/cannot query field/i);
    }
  });
});

describe('chainIndexesTaskReleases', () => {
  it('is Gnosis-only until other subgraphs ship the #201 handler', () => {
    expect(chainIndexesTaskReleases(100)).toBe(true);
    expect(chainIndexesTaskReleases(42161)).toBe(false);
    expect(chainIndexesTaskReleases(undefined)).toBe(false);
    expect(chainIndexesTaskReleases(31337)).toBe(false);
  });
});
