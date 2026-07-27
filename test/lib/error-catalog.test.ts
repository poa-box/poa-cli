/**
 * Error Catalog Tests
 * Verifies decodeContractError against real revert-data shapes produced by
 * ethers v5 providers, using the actual checked-in ABIs. Includes the drift
 * guard: every distinct custom error name across src/abi/*.json must have an
 * ERROR_MESSAGES entry so ABI regenerations cannot silently lose coverage.
 */

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import path from 'path';
import fs from 'fs';
import { decodeContractError, ERROR_MESSAGES, getErrorHint } from '../../src/lib/error-catalog';

const ABI_DIR = path.join(__dirname, '..', '..', 'src', 'abi');

function loadAbi(name: string): any[] {
  return JSON.parse(fs.readFileSync(path.join(ABI_DIR, `${name}.json`), 'utf-8'));
}

const taskManagerIface = new ethers.utils.Interface(loadAbi('TaskManagerNew'));

describe('decodeContractError', () => {
  const badStatusData = taskManagerIface.encodeErrorResult('BadStatus', []);

  const providerShapes: Array<[string, (data: string) => any]> = [
    ['error.data', (data) => ({ data })],
    ['error.error.data', (data) => ({ error: { data } })],
    ['error.error.error.data', (data) => ({ error: { error: { data } } })],
    ['error.error.data.data', (data) => ({ error: { data: { data } } })],
  ];

  for (const [shape, wrap] of providerShapes) {
    it(`decodes BadStatus nested at ${shape}`, () => {
      const decoded = decodeContractError(wrap(badStatusData), taskManagerIface);
      expect(decoded).not.toBeNull();
      expect(decoded!.name).toBe('BadStatus');
      expect(decoded!.args).toEqual([]);
      expect(decoded!.human).toBe(ERROR_MESSAGES.BadStatus.human);
      expect(decoded!.suggestion).toBe(ERROR_MESSAGES.BadStatus.suggestion);
    });
  }

  it('decodes without a caller-supplied interface via the global registry', () => {
    const decoded = decodeContractError({ data: badStatusData });
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe('BadStatus');
    expect(decoded!.human).toBe(ERROR_MESSAGES.BadStatus.human);
  });

  it('decodes parameterized errors with args (FoldersRootStale)', () => {
    const expected = ethers.utils.hexZeroPad('0x01', 32);
    const actual = ethers.utils.hexZeroPad('0x02', 32);
    const data = taskManagerIface.encodeErrorResult('FoldersRootStale', [expected, actual]);
    const decoded = decodeContractError({ error: { data } }, taskManagerIface);
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe('FoldersRootStale');
    expect(decoded!.args).toHaveLength(2);
    expect(decoded!.args[0]).toBe(expected);
    expect(decoded!.args[1]).toBe(actual);
    expect(decoded!.human).toBe(ERROR_MESSAGES.FoldersRootStale.human);
    expect(decoded!.suggestion).toBe(ERROR_MESSAGES.FoldersRootStale.suggestion);
  });

  it('returns UnknownCustomError for an unrecognized selector', () => {
    const data = '0xdeadbeef' + '00'.repeat(32);
    const decoded = decodeContractError({ data }, taskManagerIface);
    expect(decoded).not.toBeNull();
    expect(decoded!.name.startsWith('UnknownCustomError')).toBe(true);
    expect(decoded!.name).toBe('UnknownCustomError(0xdeadbeef)');
    expect(decoded!.args).toEqual([]);
    expect(decoded!.suggestion).toBeUndefined();
  });

  it('returns null for Error(string) reverts (already surfaced as error.reason)', () => {
    const data =
      '0x08c379a0' +
      ethers.utils.defaultAbiCoder.encode(['string'], ['plain revert']).slice(2);
    expect(decodeContractError({ data }, taskManagerIface)).toBeNull();
  });

  it('returns null when no revert data is present', () => {
    expect(decodeContractError({ message: 'boom' })).toBeNull();
    expect(decodeContractError({})).toBeNull();
  });
});

describe('getErrorHint', () => {
  it('returns the catalog entry for known names', () => {
    expect(getErrorHint('BadStatus')).toEqual(ERROR_MESSAGES.BadStatus);
  });

  it('returns undefined for unknown names', () => {
    expect(getErrorHint('DefinitelyNotAnError')).toBeUndefined();
  });
});

describe('ERROR_MESSAGES drift guard', () => {
  it('has an entry for every distinct error name across all src/abi/*.json', () => {
    const files = fs.readdirSync(ABI_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    const names = new Set<string>();
    for (const file of files) {
      const abi = JSON.parse(fs.readFileSync(path.join(ABI_DIR, file), 'utf-8'));
      if (!Array.isArray(abi)) continue;
      for (const fragment of abi) {
        if (fragment && fragment.type === 'error' && fragment.name) {
          names.add(fragment.name);
        }
      }
    }
    expect(names.size).toBeGreaterThan(0);

    const missing = [...names].filter((name) => !ERROR_MESSAGES[name]).sort();
    expect(missing).toEqual([]);
  });
});
