/**
 * CI-safe half of the --json output contract (the live half is
 * scripts/check-output-contracts.ts, run at release time — see
 * docs/RELEASING.md).
 *
 * What CI CAN verify without a network: the contract file is well-formed,
 * every contracted command actually exists in the CLI tree, is read-only
 * (the checker runs them live under POP_READONLY), and promises at least one
 * key. This catches a renamed/removed command going stale in the contract
 * long before a release run does.
 */

import { describe, it, expect } from 'vitest';
import { unobservableItemKeys } from '../../scripts/lib/output-contract';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

const contractDoc = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs', 'reference', 'cli', 'output-contracts.json'), 'utf8')
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'generated', 'cli-manifest.json'), 'utf8')
);
const byName = new Map<string, any>(manifest.commands.map((c: any) => [c.name, c]));

describe('output contracts (CI-safe validity)', () => {
  it('every contracted command exists and is read-only', () => {
    for (const name of Object.keys(contractDoc.contracts)) {
      const cmd = byName.get(name);
      expect(cmd, `contracted command "${name}" not in the manifest — renamed or removed?`).toBeDefined();
      expect(cmd.readOnly, `contracted command "${name}" is not read-only`).toBe(true);
    }
  });

  it('every contract promises at least one key', () => {
    for (const [name, keys] of Object.entries<string[]>(contractDoc.contracts)) {
      expect(keys.length, `"${name}" promises no keys — recapture with contracts:update`).toBeGreaterThan(0);
    }
  });

  it('the hot integration surfaces are contracted', () => {
    for (const name of ['org list', 'org status', 'task list', 'vote list', 'user whoami', 'config show']) {
      expect(contractDoc.contracts[name], `"${name}" must stay contracted`).toBeDefined();
    }
  });
});

it('empty live collections carry item promises, but missing or populated collections must satisfy them', () => {
  const promised = ['claims', 'claims[].id', 'claims[].claimedAt'];
  expect(unobservableItemKeys({ claims: [] }, promised)).toEqual(['claims[].id', 'claims[].claimedAt']);
  expect(unobservableItemKeys({}, promised)).toEqual([]);
  expect(unobservableItemKeys({ claims: [{}] }, promised)).toEqual([]);
});
