import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { deriveProposalQuorum } from '../src/governance/power';
import { knownFact, unknownFact, type SourceRef } from '../src/data/facts';
const source: SourceRef = { chainId: 100, orgId: `0x${'11'.repeat(32)}`, contract: `0x${'22'.repeat(20)}`,
  endpoint: 'fixture://rpc', method: 'quorum', indexed: false, snapshot: 'pinned', block: { number: '100', hash: `0x${'33'.repeat(32)}` } };
const input = (global: string, override: string, executable: boolean) => ({ globalQuorum: knownFact(global, source), override: knownFact(override, source), executable: knownFact(executable, source) });
describe('proposal voter-count quorum policy', () => {
  it('tracks the inspected canonical policy, including zero sentinel, raise-only batches and replaceable signal quorum', () => {
    const fixture = readFileSync(new URL('./fixtures/core-update/governance/HybridVotingCore.sol.txt', import.meta.url), 'utf8');
    expect(fixture).toContain('if (ov == 0) return l.quorum');
    expect(fixture).toContain('return ov > l.quorum ? ov : l.quorum');
    for (const executable of [false, true]) expect(deriveProposalQuorum(input('12', '0', executable))).toMatchObject({ state: 'known', value: '12' });
    expect(deriveProposalQuorum(input('12', '2', false))).toMatchObject({ state: 'known', value: '2' });
    expect(deriveProposalQuorum(input('12', '2', true))).toMatchObject({ state: 'known', value: '12' });
    expect(deriveProposalQuorum(input('12', '15', true))).toMatchObject({ state: 'known', value: '15' });
  });
  it('preserves exact uint32 bounds and rejects malformed/overflowed counts', () => {
    expect(deriveProposalQuorum(input('4294967295', '4294967294', true))).toMatchObject({ state: 'known', value: '4294967295' });
    for (const bad of ['4294967296', '-1', '1.2', 'NaN']) expect(deriveProposalQuorum(input(bad, '1', true))).toMatchObject({ state: 'unknown' });
  });
  it('retains only genuine unknown dependencies; missing executable evidence cannot lower a nonzero global quorum', () => {
    expect(deriveProposalQuorum({ ...input('12', '2', false), executable: unknownFact('CREATION_UNAVAILABLE') })).toMatchObject({ state: 'unknown', code: 'CREATION_UNAVAILABLE' });
    expect(deriveProposalQuorum({ ...input('12', '0', false), executable: unknownFact('CREATION_UNAVAILABLE') })).toMatchObject({ state: 'known', value: '12' });
    expect(deriveProposalQuorum({ ...input('12', '2', false), globalQuorum: unknownFact('GLOBAL_UNAVAILABLE') })).toMatchObject({ state: 'known', value: '2' });
    expect(deriveProposalQuorum({ ...input('12', '2', true), globalQuorum: unknownFact('GLOBAL_UNAVAILABLE') })).toMatchObject({ state: 'unknown' });
  });
  it('refuses conflicting contract, chain or block provenance even when a policy branch would ignore that value', () => {
    for (const patch of [{ contract: `0x${'44'.repeat(20)}` }, { chainId: 42161 }, { block: { number: '99' } }]) {
      expect(deriveProposalQuorum({ ...input('12', '0', false), executable: knownFact(false, { ...source, ...patch }) })).toMatchObject({ state: 'unknown', code: 'QUORUM_POLICY_UNAVAILABLE' });
    }
  });
});
