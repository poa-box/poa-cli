import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { canonicalType, dedupeAbi, extractAbis, itemSignature, mergeCompanionAbi } from '../../scripts/extract-abis.mjs';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pop-abi-extraction-'));
  temporaryDirectories.push(dir);
  return dir;
}

function writeArtifact(dir: string, contract: string, abi: unknown[]) {
  const artifactDir = path.join(dir, `${contract}.sol`);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(path.join(artifactDir, `${contract}.json`), JSON.stringify({ abi }));
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('contract ABI extraction', () => {
  it('preserves nested tuple component types and array dimensions in canonical signatures', () => {
    const input = {
      type: 'tuple[][2]',
      components: [{ type: 'uint256' }, { type: 'tuple[]', components: [{ type: 'bytes32' }, { type: 'address' }] }],
    };
    expect(canonicalType(input)).toBe('(uint256,(bytes32,address)[])[][2]');
    expect(itemSignature({ type: 'function', name: 'configure', inputs: [input] }))
      .toBe('function configure((uint256,(bytes32,address)[])[][2])');
  });

  it('preserves distinct tuple overloads while removing actual duplicate fragments', () => {
    const first = { type: 'function', name: 'configure', inputs: [{ type: 'tuple', components: [{ type: 'uint256' }] }] };
    const second = { type: 'function', name: 'configure', inputs: [{ type: 'tuple', components: [{ type: 'address' }] }] };
    expect(dedupeAbi([first, second, first])).toEqual([first, second]);
  });

  it('merges only companion events/errors and does not discard tuple overloads', () => {
    const dir = temporaryDirectory();
    const first = { type: 'error', name: 'InvalidConfig', inputs: [{ type: 'tuple', components: [{ type: 'uint256' }] }] };
    const second = { type: 'error', name: 'InvalidConfig', inputs: [{ type: 'tuple', components: [{ type: 'address' }] }] };
    const event = { type: 'event', name: 'Changed', inputs: [] };
    writeArtifact(dir, 'ValidationLib', [first, second, event, { type: 'function', name: 'validate', inputs: [] }]);
    expect(mergeCompanionAbi([first], 'EducationHub', dir)).toEqual([first, second, event]);
  });

  it('fails when a required companion artifact is missing', () => {
    expect(() => mergeCompanionAbi([], 'MembershipAuthority', temporaryDirectory()))
      .toThrow('MISSING companion artifact:');
  });

  it('leaves all checked-in ABIs untouched when a later artifact is missing', () => {
    const dir = temporaryDirectory();
    const targetDir = temporaryDirectory();
    const target = path.join(targetDir, 'TaskManagerNew.json');
    const previous = '[{"type":"error","name":"KeepMe","inputs":[]}]\n';
    writeFileSync(target, previous);
    for (const contract of ['TaskManager', 'TaskPerm', 'BudgetLib', 'ValidationLib', 'SubjectSet']) {
      writeArtifact(dir, contract, []);
    }
    expect(() => extractAbis(dir, targetDir)).toThrow('QuickJoin.sol/QuickJoin.json');
    expect(readFileSync(target, 'utf8')).toBe(previous);
  });
});
