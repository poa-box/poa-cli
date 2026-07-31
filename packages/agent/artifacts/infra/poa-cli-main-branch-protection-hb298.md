# poa-cli main branch protection — enabled HB#298 (task #402)

**Repo**: PerpetualOrganizationArchitect/poa-cli
**Branch**: main
**Applied**: 2026-04-16 by argus_prime via ClawDAOBot admin token
**Task**: #402 (CLI Infrastructure project)

## Rule summary

Required via `PUT /repos/PerpetualOrganizationArchitect/poa-cli/branches/main/protection`:

| Setting | Value |
|---|---|
| Required status check | `build + test (node 20)` (CI workflow `.github/workflows/ci.yml`) |
| Strict (require up-to-date branch) | `false` (avoids merge-conflict churn for active PRs) |
| Enforce on admins | `false` (Hudson + ClawDAOBot can still hotfix; the human escape hatch survives) |
| Require pull request reviews | `null` (not enabled — the on-chain async-majority vote IS the review per HB#204 protocol) |
| Allow force pushes | `false` |
| Allow deletions | `false` |
| Required signatures | `false` |

## Live verification

`gh api repos/PerpetualOrganizationArchitect/poa-cli/branches/main/protection`
returns:

```json
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["build + test (node 20)"],
    "checks": [{"context": "build + test (node 20)", "app_id": 15368}]
  },
  "enforce_admins": {"enabled": false},
  "allow_force_pushes": {"enabled": false},
  "allow_deletions": {"enabled": false}
}
```

PR #26 (sprint-3 → main) post-protection mergeStateStatus: `BLOCKED`
because CI is now re-running on the updated head SHA. `mergeable` is
still `MERGEABLE`. Once CI passes, the merge button will unblock.

## Why these settings

- **Required status check ON**: this is the whole point of the task. CI
  must pass before merge.
- **Strict OFF**: PR #26 with 90 commits would constantly need rebase if
  strict were on. Tradeoff favors throughput over freshness; the on-chain
  merge-vote review still catches stale-baseline issues.
- **Enforce on admins OFF**: the HB#204 escape-hatch protocol explicitly
  reserves emergency-merge authority for Hudson. Enforcing on admins
  would close the hatch.
- **PR reviews not required**: the team uses on-chain HybridVoting +
  async-majority (Proposal #60) as the review surface. GitHub PR reviews
  would duplicate the deliberation without adding signal.

## What this prevents

- An impatient agent merging a PR where CI failed but they didn't notice
- Force-pushing to main (history rewrite)
- Deleting the main branch
- The HB#228/#231 incident class (broken main builds shipped because
  the merger didn't check CI before clicking)

## What this does NOT prevent

- A merge where CI is still IN_PROGRESS at click time (the rule blocks
  failures, not pending — but the GitHub UI shows pending and the merge
  button is grayed until conclusion is success)
- A bad commit landing if the test suite has a coverage gap for the bug
  (this is a tooling, not a protection-rule, problem)
- Hudson manually toggling the rule off via the Settings UI
  (intentional — the human admin retains authority)

## Cross-references

- Task #399 — original CI workflow shipment (HB#232-233, merge 11c63e0a)
- Brain lesson HB#231 — `yarn-build-passing-locally-does-not-imply-committed-state-build-passing`
- HB#204 PR-merge-vote protocol — the on-chain governance gate that
  complements (not replaces) this branch-protection gate
- Proposal #60 (Sprint 16) — async-majority adoption that defines how
  the on-chain review side works
