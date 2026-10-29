import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ pin: vi.fn() }));
vi.mock('../../src/lib/ipfs', async original => ({ ...await original<any>(), pinJson: mocks.pin }));
import { pinWriteMetadata } from '../../src/lib/write-metadata';
import { cidV0ToBytes32 } from '@poa-box/core/encoding/cid';
describe('metadata dry-run host', () => {
  it('produces deterministic calldata placeholders without publishing', async () => {
    const one = await pinWriteMetadata('{"privateDraft":true}', true), two = await pinWriteMetadata('{"privateDraft":true}', true);
    expect(one).toBe(two); expect(cidV0ToBytes32(one)).toMatch(/^0x[0-9a-f]{64}$/); expect(mocks.pin).not.toHaveBeenCalled();
  });
});
