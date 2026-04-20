import { describe, it, expect } from 'vitest';
import { classifyVoterByCode, computeProxyShare, classifyDao, type VoterClass } from '../../src/commands/org/audit-proxy-factory';

describe('classifyVoterByCode — EOA vs proxy-candidate heuristic', () => {
  it('classifies empty code "0x" as EOA', () => {
    expect(classifyVoterByCode('0x')).toBe('eoa');
  });

  it('classifies "0x0" as EOA', () => {
    expect(classifyVoterByCode('0x0')).toBe('eoa');
  });

  it('classifies empty string as EOA', () => {
    expect(classifyVoterByCode('')).toBe('eoa');
  });

  it('classifies minimal proxy bytecode (EIP-1167) as proxy-candidate', () => {
    // EIP-1167 minimal proxy is ~45 bytes
    const minimalProxy = '0x363d3d373d3d3d363d73' + 'a'.repeat(40) + '5af43d82803e903d91602b57fd5bf3';
    expect(classifyVoterByCode(minimalProxy)).toBe('proxy-candidate');
  });

  it('classifies large contract bytecode as proxy-candidate', () => {
    const largeContract = '0x' + 'a'.repeat(10000);
    expect(classifyVoterByCode(largeContract)).toBe('proxy-candidate');
  });

  it('returns unknown for undefined code', () => {
    expect(classifyVoterByCode(undefined as any)).toBe('eoa'); // treated as no code
  });
});

describe('computeProxyShare — aggregation logic', () => {
  it('returns zero proxy-share when all EOAs', () => {
    const classes: VoterClass[] = ['eoa', 'eoa', 'eoa'];
    const { summary, proxyShare } = computeProxyShare(classes);
    expect(summary.eoa).toBe(3);
    expect(summary['proxy-candidate']).toBe(0);
    expect(proxyShare).toBe(0);
  });

  it('returns 1.0 proxy-share when all proxies', () => {
    const classes: VoterClass[] = ['proxy-candidate', 'proxy-candidate'];
    const { summary, proxyShare } = computeProxyShare(classes);
    expect(summary['proxy-candidate']).toBe(2);
    expect(proxyShare).toBe(1);
  });

  it('returns 0.5 for half-and-half', () => {
    const classes: VoterClass[] = ['eoa', 'eoa', 'proxy-candidate', 'proxy-candidate'];
    const { summary, proxyShare } = computeProxyShare(classes);
    expect(summary.eoa).toBe(2);
    expect(summary['proxy-candidate']).toBe(2);
    expect(proxyShare).toBe(0.5);
  });

  it('excludes unknown from denominator', () => {
    const classes: VoterClass[] = ['eoa', 'proxy-candidate', 'unknown', 'unknown'];
    const { summary, proxyShare } = computeProxyShare(classes);
    // total = eoa + proxy = 2; proxy-share = 1/2 = 0.5
    expect(summary.unknown).toBe(2);
    expect(proxyShare).toBe(0.5);
  });

  it('handles empty input safely', () => {
    const { summary, proxyShare } = computeProxyShare([]);
    expect(summary.eoa).toBe(0);
    expect(proxyShare).toBe(0);
  });
});

describe('classifyDao — E-proxy classification', () => {
  it('flags E-proxy-identity-obfuscating when proxy-share > 0.5 + voters ≥ 5', () => {
    expect(classifyDao(0.7, 10)).toBe('E-proxy-identity-obfuscating');
    expect(classifyDao(0.51, 5)).toBe('E-proxy-identity-obfuscating');
  });

  it('flags not-E-proxy when proxy-share ≤ 0.5 + voters ≥ 5', () => {
    expect(classifyDao(0.4, 10)).toBe('not-E-proxy');
    expect(classifyDao(0.5, 5)).toBe('not-E-proxy');
    expect(classifyDao(0, 5)).toBe('not-E-proxy');
  });

  it('flags inconclusive when voters < 5 regardless of proxy-share', () => {
    expect(classifyDao(0.9, 4)).toBe('inconclusive');
    expect(classifyDao(0.1, 3)).toBe('inconclusive');
    expect(classifyDao(0, 0)).toBe('inconclusive');
  });

  it('Maker Chief-like scenario: 5+ voters all proxy → E-proxy', () => {
    // Historical Maker Chief: most voters were DSProxy owners
    expect(classifyDao(1.0, 20)).toBe('E-proxy-identity-obfuscating');
  });

  it('Aave-like scenario: 5+ voters mostly EOAs → not-E-proxy', () => {
    // Aave: delegates are mostly EOAs or multisig, but not factory-deployed
    expect(classifyDao(0.2, 50)).toBe('not-E-proxy');
  });
});
