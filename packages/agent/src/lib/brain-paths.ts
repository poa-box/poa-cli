/**
 * Where the REPO-TRACKED brain lives.
 *
 * The package split moved it from <repo>/agent/brain to
 * <repo>/packages/agent/brain. Three call sites used to build the old path
 * from process.cwd(), and after the move they all failed SILENTLY: genesis
 * seeding never happened (regressing the task #352 fix), the committed signer
 * allowlist stopped loading, and `pop brain snapshot` grew a fresh untracked
 * agent/ tree at the repo root instead of updating the tracked projection.
 *
 * Resolve relative to THIS package first (dist/lib → ../../brain), then fall
 * back to cwd-based layouts so an agent invoking the command from an older
 * checkout, or from outside the repo, still finds a brain if one exists.
 */

import { join, resolve } from 'path';
import { existsSync } from 'fs';

export function getRepoBrainRoot(): string {
  const candidates = [
    resolve(__dirname, '..', '..', 'brain'), // dist/lib → packages/agent/brain
    join(process.cwd(), 'packages', 'agent', 'brain'), // repo root as cwd
    join(process.cwd(), 'agent', 'brain'), // pre-split layout
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Nothing exists yet (fresh checkout mid-build): prefer the package-rooted
  // path so anything created lands in the TRACKED location.
  return candidates[0];
}
