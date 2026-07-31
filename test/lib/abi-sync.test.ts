import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * ABI drift canary.
 *
 * Asserts that the checked-in ABIs carry the protocol surface the CLI is
 * written against (contracts origin/main, TaskManager v6 era). If the
 * contracts change and `yarn sync-abis` regenerates these files, a failure
 * here means CLI code that depends on a signature below needs attention —
 * update the CLI, then update this list.
 */

const ABI_DIR = path.join(__dirname, '..', '..', 'src', 'abi');

function loadAbi(name: string): any[] {
  return JSON.parse(readFileSync(path.join(ABI_DIR, `${name}.json`), 'utf-8'));
}

function sigSet(abi: any[]): Set<string> {
  const sigs = new Set<string>();
  for (const item of abi) {
    if (!item.type || !item.name) continue;
    const inputs = (item.inputs || []).map((i: any) => i.type).join(',');
    sigs.add(`${item.type} ${item.name}(${inputs})`);
  }
  return sigs;
}

function expectSigs(abiName: string, expected: string[]) {
  const sigs = sigSet(loadAbi(abiName));
  const missing = expected.filter((s) => !sigs.has(s));
  expect(missing, `${abiName}.json missing: ${missing.join('; ')}`).toEqual([]);
}

describe('ABI sync canary (contracts origin/main)', () => {
  /**
   * ethers v5 writes "duplicate definition - X()" to STDOUT (not stderr) when an ABI carries
   * two fragments with the same signature, which corrupts any --json output the command then
   * prints. DirectDemocracyVotingNew.json shipped with a duplicate LengthMismatch() and broke
   * `pop vote list --json`; scripts/extract-abis.mjs now dedupes, but only on `yarn sync-abis`,
   * so a hand-edit or merge could reintroduce it. Lock the invariant here.
   */
  it('no ABI file contains duplicate fragment signatures', () => {
    // Recurse: src/abi/external/* and ERC20.json are hand-maintained and never pass through
    // scripts/extract-abis.mjs, so the generator's dedupe does not protect them.
    const abiFiles: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (e.name.endsWith('.json')) abiFiles.push(path.join(dir, e.name));
      }
    };
    walk(ABI_DIR);
    expect(abiFiles.length).toBeGreaterThan(0);

    for (const file of abiFiles) {
      const abi = JSON.parse(readFileSync(file, 'utf-8'));
      if (!Array.isArray(abi)) continue;
      const sigs = abi
        .filter((i: any) => i.type && i.name)
        .map((i: any) => `${i.type} ${i.name}(${(i.inputs || []).map((x: any) => x.type).join(',')})`);
      const dupes = [...new Set(sigs.filter((s2, i) => sigs.indexOf(s2) !== i))];
      expect(dupes, `${path.relative(ABI_DIR, file)} has duplicate fragments: ${dupes.join('; ')}`).toEqual([]);
    }
  });

  it('every ABI file parses as a bare array', () => {
    for (const file of readdirSync(ABI_DIR).filter((f) => f.endsWith('.json'))) {
      const parsed = JSON.parse(readFileSync(path.join(ABI_DIR, file), 'utf-8'));
      expect(Array.isArray(parsed), `${file} is not a bare ABI array`).toBe(true);
    }
  });

  it('TaskManager v6 surface', () => {
    expectSigs('TaskManagerNew', [
      // v6: 9-arg createTask with deadlines
      'function createTask(uint256,bytes,bytes32,bytes32,address,uint256,bool,uint48,uint32)',
      'function createTasksBatch(bytes32,tuple[])',
      'function updateTask(uint256,uint256,bytes,bytes32,address,uint256,uint48,uint32)',
      'function updateTaskMetadata(uint256,bytes,bytes32)',
      'function setFolders(bytes32,bytes32)',
      'function setProjectRolePerm(bytes32,uint256,uint8)',
      'function bootstrapGlobalPerms(uint256[],uint8[])',
      'function getLensData(uint8,bytes)',
      'function applyForTask(uint256,bytes32)',
      'function approveApplication(uint256,address)',
      'event TaskDeadlinesSet(uint256,uint48,uint32)',
      'event TaskClaimDeadlineSet(uint256,uint48)',
      'event TaskClaimExpired(uint256,address,address)',
      'error InvalidDeadline()',
      'error FoldersRootStale(bytes32,bytes32)',
    ]);
  });

  it('HybridVoting N-class + quorum surface', () => {
    expectSigs('HybridVotingNew', [
      'function getClasses()',
      'function quorum()',
      'function thresholdPct()',
      'function vote(uint256,uint8[],uint8[])',
      'function announceWinner(uint256)',
    ]);
  });

  it('DirectDemocracyVoting surface', () => {
    expectSigs('DirectDemocracyVotingNew', [
      'function vote(uint256,uint8[],uint8[])',
      'function announceWinner(uint256)',
    ]);
  });

  it('EligibilityModule v4 surface', () => {
    expectSigs('EligibilityModuleNew', [
      'function configureVouching(uint256,uint32,uint256,bool)',
      'function resetVouches(uint256)',
      'function vouchFor(address,uint256)',
      'function revokeVouch(address,uint256)',
      'function transferSuperAdmin(address)',
      'function applyForRole(uint256,bytes32)',
      'function claimVouchedHat(uint256)',
      'error VouchingRateLimitExceeded()',
    ]);
  });

  it('PaymasterHub surface', () => {
    expectSigs('PaymasterHub', [
      'function depositForOrg(bytes32)',
    ]);
  });

  it('PaymentManager surface', () => {
    expectSigs('PaymentManager', [
      'function finalizeDistribution(uint256,uint256)',
      'function createDistribution(address,uint256,bytes32,uint256)',
      'function claimDistribution(uint256,uint256,bytes32[])',
      'function optOut(bool)',
      'function withdraw(address,address,uint256)',
    ]);
  });

  it('QuickJoin surface', () => {
    expectSigs('QuickJoinNew', [
      'function quickJoinWithUser()',
      'function claimHatsWithUser(uint256[])',
    ]);
  });

  it('UniversalAccountRegistry surface', () => {
    expectSigs('UniversalAccountRegistry', [
      'function registerAccount(string)',
      'function changeUsername(string)',
      'function getUsername(address)',
      'function getAddressOfUsername(string)',
      'function setProfileMetadata(bytes32)',
    ]);
  });
});
