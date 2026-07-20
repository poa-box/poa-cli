import { describe, it, expect } from 'vitest';
import { applyDefaultOrgFallback } from '../../src/lib/default-org';

describe('applyDefaultOrgFallback', () => {
  it('fills argv.org from POP_DEFAULT_ORG for a normal command', () => {
    const argv: any = { _: ['task', 'list'] };
    applyDefaultOrgFallback(argv, { POP_DEFAULT_ORG: 'acme' } as any);
    expect(argv.org).toBe('acme');
  });

  it('does NOT inject the env org for `init` (avoids leaking a stale org into fresh config)', () => {
    const argv: any = { _: ['init'] };
    applyDefaultOrgFallback(argv, { POP_DEFAULT_ORG: 'acme' } as any);
    expect(argv.org).toBeUndefined();
  });

  it('preserves an explicit --org over the env fallback', () => {
    const argv: any = { _: ['task', 'list'], org: 'explicit' };
    applyDefaultOrgFallback(argv, { POP_DEFAULT_ORG: 'acme' } as any);
    expect(argv.org).toBe('explicit');
  });

  it('leaves argv.org undefined when neither flag nor env is set', () => {
    const argv: any = { _: ['task', 'list'] };
    applyDefaultOrgFallback(argv, {} as any);
    expect(argv.org).toBeUndefined();
  });

  it('keeps an explicit --org even for `init`', () => {
    const argv: any = { _: ['init'], org: 'explicit' };
    applyDefaultOrgFallback(argv, { POP_DEFAULT_ORG: 'acme' } as any);
    expect(argv.org).toBe('explicit');
  });
});
