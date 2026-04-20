import { describe, it, expect } from 'vitest';
import { classifyVoterByCode, computeProxyShare, classifyDao, classifyProxyFamily, type VoterClass } from '../../src/commands/org/audit-proxy-factory';

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

describe('classifyProxyFamily — HB#833 v1.2 bytecode-fingerprint taxonomy', () => {
  it('returns "none" for EOA (empty code)', () => {
    expect(classifyProxyFamily('0x')).toBe('none');
    expect(classifyProxyFamily('')).toBe('none');
  });

  it('identifies EIP-1167 minimal proxy by exact size + signature', () => {
    // Canonical EIP-1167: 45 bytes, specific opcodes
    const eip1167 = '0x363d3d373d3d3d363d73' + '0'.repeat(40) + '5af43d82803e903d91602b57fd5bf3';
    expect(classifyProxyFamily(eip1167)).toBe('eip-1167');
  });

  it('rejects 45-byte code without EIP-1167 signature as other-contract', () => {
    // Exactly 45 bytes but wrong signature
    const fake45 = '0x' + 'a'.repeat(90);
    expect(classifyProxyFamily(fake45)).toBe('other-contract');
  });

  it('identifies Maker DSProxy by exact 3947-byte size (HB#409 fixture)', () => {
    // Synthesize 3947-byte code for size-match test (content irrelevant here)
    const makerProxy = '0x' + 'a'.repeat(3947 * 2);
    expect(classifyProxyFamily(makerProxy)).toBe('dsproxy-maker');
  });

  it('identifies Safe-family proxy by 170-byte range (HB#832 Uniswap fixture)', () => {
    const safeProxy = '0x' + 'b'.repeat(170 * 2);
    expect(classifyProxyFamily(safeProxy)).toBe('safe-proxy');
    // bracket check
    expect(classifyProxyFamily('0x' + 'b'.repeat(168 * 2))).toBe('safe-proxy');
    expect(classifyProxyFamily('0x' + 'b'.repeat(180 * 2))).toBe('safe-proxy');
  });

  it('classifies out-of-range sizes as other-contract', () => {
    // 100 bytes — between known families
    expect(classifyProxyFamily('0x' + 'c'.repeat(100 * 2))).toBe('other-contract');
    // 10000 bytes — generic large contract
    expect(classifyProxyFamily('0x' + 'd'.repeat(10000 * 2))).toBe('other-contract');
  });

  it('case-insensitive matching on EIP-1167 signature prefix', () => {
    const eip1167Upper = '0x363D3D373D3D3D363D73' + '0'.repeat(40) + '5af43d82803e903d91602b57fd5bf3';
    expect(classifyProxyFamily(eip1167Upper)).toBe('eip-1167');
  });
});
