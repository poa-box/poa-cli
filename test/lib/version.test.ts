import { describe, it, expect, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import {
  computeSelector,
  getImplementation,
  detectTaskManagerFeatures,
  TM_FEATURE_FRAGMENTS,
  EIP1967_BEACON_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
  _clearVersionCacheForTest,
} from '../../src/lib/version';

const ZERO_WORD = '0x' + '00'.repeat(32);
const PROXY = '0x' + '11'.repeat(20);
const BEACON = '0x' + 'aa'.repeat(20);
const IMPL = '0x' + 'bb'.repeat(20);

/** Minimal provider mock: plain object with the methods version.ts touches. */
function mockProvider(overrides: {
  storage?: Record<string, string>;
  code?: (address: string) => string;
  call?: (tx: { to: string; data: string }) => string;
  chainId?: number;
}) {
  return {
    async getStorageAt(_address: string, slot: string): Promise<string> {
      return overrides.storage?.[slot] ?? ZERO_WORD;
    },
    async getCode(address: string): Promise<string> {
      return overrides.code ? overrides.code(address) : '0x';
    },
    async call(tx: { to: string; data: string }): Promise<string> {
      if (!overrides.call) throw new Error(`unexpected call to ${tx.to}`);
      return overrides.call(tx);
    },
    async getNetwork(): Promise<{ chainId: number; name: string }> {
      return { chainId: overrides.chainId ?? 100, name: 'test' };
    },
  } as unknown as ethers.providers.Provider;
}

beforeEach(() => {
  _clearVersionCacheForTest();
});

describe('computeSelector', () => {
  it('matches ethers Interface.getSighash for a known fragment', () => {
    const fragment = 'function transfer(address to, uint256 amount) returns (bool)';
    const iface = new ethers.utils.Interface([fragment]);
    expect(computeSelector(fragment)).toBe(iface.getSighash('transfer'));
    // Canonical ERC-20 transfer selector — guards against signature drift
    expect(computeSelector(fragment)).toBe('0xa9059cbb');
  });

  it('pins the unclaimTask selector published by contracts PR #187', () => {
    // The probe scans raw bytecode for this literal, so a typo in the fragment
    // (an argument name change is harmless, a type change is not) would silently
    // report v7 orgs as lacking unclaim.
    expect(computeSelector(TM_FEATURE_FRAGMENTS.unclaim)).toBe('0x6103955a');
  });

  it('matches getSighash for every feature fragment', () => {
    for (const fragment of Object.values(TM_FEATURE_FRAGMENTS)) {
      const iface = new ethers.utils.Interface([fragment]);
      const signature = Object.keys(iface.functions)[0];
      expect(computeSelector(fragment)).toBe(iface.getSighash(iface.functions[signature]));
    }
  });
});

describe('detectTaskManagerFeatures', () => {
  it('flags exactly the selectors present in the implementation bytecode', async () => {
    // Synthetic bytecode containing only the deadlines + batchCreate selectors
    const code =
      '0x6080604052' +
      computeSelector(TM_FEATURE_FRAGMENTS.deadlines).slice(2) +
      '57' +
      computeSelector(TM_FEATURE_FRAGMENTS.batchCreate).slice(2) +
      '5b';
    const provider = mockProvider({ code: () => code });

    const features = await detectTaskManagerFeatures(provider, PROXY, 100);
    expect(features).toEqual({
      deadlines: true,
      batchCreate: true,
      editMeta: false,
      folders: false,
      legacyCreate7: false,
      unclaim: false,
    });
  });

  it('flags unclaim when the v7 unclaimTask selector is in the bytecode', async () => {
    const code = '0x6080604052' + computeSelector(TM_FEATURE_FRAGMENTS.unclaim).slice(2) + '5b';
    const provider = mockProvider({ code: () => code });

    const features = await detectTaskManagerFeatures(provider, PROXY, 100);
    expect(features.unclaim).toBe(true);
    expect(features.deadlines).toBe(false);
  });

  it('probes the proxy itself when neither EIP-1967 slot is set (non-proxy)', async () => {
    const probed: string[] = [];
    const code = '0x00' + computeSelector(TM_FEATURE_FRAGMENTS.legacyCreate7).slice(2);
    const provider = mockProvider({
      code: (address) => {
        probed.push(address);
        return code;
      },
    });

    const features = await detectTaskManagerFeatures(provider, PROXY.toLowerCase(), 100);
    expect(probed).toEqual([ethers.utils.getAddress(PROXY)]);
    expect(features.legacyCreate7).toBe(true);
    expect(features.deadlines).toBe(false);
  });

  it('caches results per chainId:proxy (one getCode per implementation)', async () => {
    let getCodeCalls = 0;
    const provider = mockProvider({
      code: () => {
        getCodeCalls++;
        return '0x6080';
      },
    });

    await detectTaskManagerFeatures(provider, PROXY, 100);
    await detectTaskManagerFeatures(provider, PROXY, 100);
    expect(getCodeCalls).toBe(1);

    _clearVersionCacheForTest();
    await detectTaskManagerFeatures(provider, PROXY, 100);
    expect(getCodeCalls).toBe(2);
  });

  it('resolves chainId via getNetwork when not passed', async () => {
    let networkCalls = 0;
    const provider = mockProvider({ code: () => '0x6080' });
    (provider as any).getNetwork = async () => {
      networkCalls++;
      return { chainId: 100, name: 'test' };
    };

    await detectTaskManagerFeatures(provider, PROXY);
    expect(networkCalls).toBe(1);
  });
});

describe('getImplementation', () => {
  it('follows the EIP-1967 beacon slot and calls implementation() on the beacon', async () => {
    const beaconIface = new ethers.utils.Interface(['function implementation() view returns (address)']);
    const calls: Array<{ to: string; data: string }> = [];
    const provider = mockProvider({
      storage: { [EIP1967_BEACON_SLOT]: ethers.utils.hexZeroPad(BEACON, 32) },
      call: (tx) => {
        calls.push(tx);
        return ethers.utils.hexZeroPad(IMPL, 32);
      },
    });

    const impl = await getImplementation(provider, PROXY);
    expect(impl).toBe(ethers.utils.getAddress(IMPL));
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(ethers.utils.getAddress(BEACON));
    expect(calls[0].data).toBe(beaconIface.encodeFunctionData('implementation'));
  });

  it('falls back to the EIP-1967 implementation slot when no beacon is set', async () => {
    const provider = mockProvider({
      storage: { [EIP1967_IMPLEMENTATION_SLOT]: ethers.utils.hexZeroPad(IMPL, 32) },
    });

    const impl = await getImplementation(provider, PROXY);
    expect(impl).toBe(ethers.utils.getAddress(IMPL));
  });

  it('returns the checksummed input address when both slots are zero (non-proxy)', async () => {
    const provider = mockProvider({});
    const impl = await getImplementation(provider, PROXY.toLowerCase());
    expect(impl).toBe(ethers.utils.getAddress(PROXY));
  });
});
