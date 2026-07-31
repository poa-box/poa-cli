import { describe, it, expect } from 'vitest';
import { validateBrainDocShape } from '../../src/lib/brain-schemas';

describe('validateBrainDocShape — pop.brain.shared', () => {
  it('accepts a canonical lesson', () => {
    const doc = {
      lessons: [
        {
          id: 'test-1',
          author: '0xabc',
          title: 'Canonical lesson',
          body: 'Body content here.',
          timestamp: 1776183000,
        },
      ],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts legacy lessons with text/ts synonyms', () => {
    const doc = {
      lessons: [
        { id: 'legacy-1', text: 'Old shape body', ts: 1776000000, author: '0xabc' },
      ],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(true);
  });

  it('rejects a lesson missing body and text', () => {
    const doc = {
      lessons: [{ id: 'bad-1', title: 'No body', author: '0xabc' }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('body/text'))).toBe(true);
  });

  it('rejects a lesson missing both title and id', () => {
    const doc = {
      lessons: [{ body: 'Body only, no identifier', author: '0xabc' }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('title/id'))).toBe(true);
  });

  it('rejects an empty-string body', () => {
    const doc = {
      lessons: [{ id: 'bad-2', title: 'Empty body', body: '', author: '0xabc' }],
    };
    const result = validateBrainDocShape('pop.brain.shared', doc);
    expect(result.ok).toBe(false);
  });

  it('accepts a doc with no lessons array (bootstrap case)', () => {
    const result = validateBrainDocShape('pop.brain.shared', {});
    expect(result.ok).toBe(true);
  });
});

describe('validateBrainDocShape — pop.brain.projects', () => {
  it('accepts a canonical project', () => {
    const doc = {
      projects: [
        { id: 'proj-1', name: 'My Project', stage: 'propose', proposedBy: '0xabc' },
      ],
    };
    const result = validateBrainDocShape('pop.brain.projects', doc);
    expect(result.ok).toBe(true);
  });

  it('accepts all canonical lifecycle stages', () => {
    for (const stage of ['propose', 'discuss', 'plan', 'vote', 'execute', 'review', 'ship']) {
      const doc = { projects: [{ id: 'p', name: 'n', stage }] };
      const result = validateBrainDocShape('pop.brain.projects', doc);
      expect(result.ok).toBe(true);
    }
  });

  it('rejects a project with an invalid stage', () => {
    const doc = {
      projects: [{ id: 'proj-1', name: 'Bad', stage: 'not-a-real-stage' }],
    };
    const result = validateBrainDocShape('pop.brain.projects', doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('stage'))).toBe(true);
  });

  it('rejects a project missing id', () => {
    const doc = {
      projects: [{ name: 'No id', stage: 'propose' }],
    };
    const result = validateBrainDocShape('pop.brain.projects', doc);
    expect(result.ok).toBe(false);
  });
});

describe('validateBrainDocShape — pop.brain.brainstorms (task #354 phase a)', () => {
  it('accepts a bootstrap doc with no brainstorms array', () => {
    const result = validateBrainDocShape('pop.brain.brainstorms', {});
    expect(result.ok).toBe(true);
  });

  it('accepts a canonical brainstorm with ideas + votes', () => {
    const doc = {
      brainstorms: [
        {
          id: 'brainstorm-1',
          title: 'Sprint 13 direction',
          prompt: 'What should we focus on next sprint?',
          author: '0xabc',
          status: 'open',
          openedAt: 1776206000,
          window: { from: 207, to: 222 },
          ideas: [
            {
              id: 'idea-a',
              author: '0xdef',
              message: 'Extend the audit corpus',
              timestamp: 1776206100,
              votes: { '0xabc': 'support', '0x123': 'explore' },
              priority: 'high',
            },
          ],
        },
      ],
    };
    const result = validateBrainDocShape('pop.brain.brainstorms', doc);
    expect(result.ok).toBe(true);
  });

  it('rejects brainstorm missing id', () => {
    const doc = { brainstorms: [{ title: 't', status: 'open' }] };
    const result = validateBrainDocShape('pop.brain.brainstorms', doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('rejects brainstorm with invalid status', () => {
    const doc = { brainstorms: [{ id: 'b1', title: 't', status: 'pending' }] };
    const result = validateBrainDocShape('pop.brain.brainstorms', doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('status'))).toBe(true);
  });

  it('rejects idea missing message', () => {
    const doc = {
      brainstorms: [
        { id: 'b1', title: 't', status: 'open', ideas: [{ id: 'i1' }] },
      ],
    };
    const result = validateBrainDocShape('pop.brain.brainstorms', doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('message'))).toBe(true);
  });

  it('rejects idea with invalid vote stance', () => {
    const doc = {
      brainstorms: [
        {
          id: 'b1',
          title: 't',
          status: 'open',
          ideas: [{ id: 'i1', message: 'hi', votes: { '0xabc': 'maybe' } }],
        },
      ],
    };
    const result = validateBrainDocShape('pop.brain.brainstorms', doc);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('stance'))).toBe(true);
  });

  it('accepts all 4 canonical brainstorm statuses', () => {
    for (const status of ['open', 'voting', 'closed', 'promoted']) {
      const doc = { brainstorms: [{ id: 'b', title: 't', status }] };
      const result = validateBrainDocShape('pop.brain.brainstorms', doc);
      expect(result.ok).toBe(true);
    }
  });

  it('accepts all 3 canonical vote stances', () => {
    for (const stance of ['support', 'explore', 'oppose']) {
      const doc = {
        brainstorms: [
          {
            id: 'b',
            title: 't',
            status: 'open',
            ideas: [{ id: 'i', message: 'm', votes: { '0xabc': stance } }],
          },
        ],
      };
      const result = validateBrainDocShape('pop.brain.brainstorms', doc);
      expect(result.ok).toBe(true);
    }
  });
});

describe('validateBrainDocShape — unknown doc ids', () => {
  it('accepts unknown doc ids with a warning', () => {
    const result = validateBrainDocShape('pop.brain.experimental', { anything: 42 });
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
