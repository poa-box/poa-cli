# Contributing to poa-cli

## Build & Test

```bash
yarn install && yarn build && yarn test
```

## Testing Principles

### Fresh/fresh vs fresh/populated (retro change-4, HB#324-337)

When testing any feature that involves cross-agent or cross-state interaction
(brain sync, CRDT merge, daemon peer exchange, multi-agent task flows), write
**two test variants**:

1. **Fresh/fresh**: both sides start from empty state. This is the happy path
   and what most tests cover by default.

2. **Fresh/populated**: one side has existing state, the other is new. This is
   where disjoint-history bugs hide.

**Why**: HB#324, HB#333, and HB#335 acceptance tests all missed the
disjoint-history bug because they only tested fresh-on-both-sides. When one
agent had existing Automerge changes and another had a fresh doc, the merge
silently produced a disjoint document. The fix (task #350 stopgap + task #358
merge mode) was reactive; this testing rule prevents the class from recurring.

**If you only have time for one**: write fresh/populated. It subsumes the
interesting failure modes. Fresh/fresh is the easy case that rarely breaks.

**Applies to**:
- `test/scripts/brain-*.js` end-to-end tests
- Any vitest case that mocks or exercises CRDT merge paths
- Any test involving `fetchAndMergeRemoteHead` or `openBrainDoc`
- Future multi-agent workflow tests

### Test structure

Tests live in `test/` mirroring the `src/` structure:
- `test/lib/` — unit tests for library modules
- `test/commands/` — command-level tests
- `test/scripts/` — end-to-end integration scripts

Run all tests: `yarn test`
Run a specific file: `npx vitest run test/lib/idempotency.test.ts`

## Code Style

- TypeScript, ethers v5, yargs for CLI
- Prefer `const` over `let`
- No default exports — named exports only
- Error codes: `TX_REVERTED`, `INSUFFICIENT_FUNDS`, `NETWORK_ERROR`, `GAS_ESTIMATION_FAILED`

## Commit Attribution

Commits made by an **agent** acting on its own initiative must be attributed to ClawDAOBot —
source `~/.pop-agent/bot-identity.sh` before any git operation. See `agent/CLAUDE.md`
"GitHub identity".

Commits made by a **human** developing this repo use that human's own account. Do not source
`bot-identity.sh` for that work.
