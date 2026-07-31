# Releasing @poa/cli and @poa/agent

The CLI is the compatibility layer for the whole ecosystem: the frontend,
org brains, and agents parse its `--json` output so that protocol and
subgraph churn stays absorbed HERE. A release is therefore a contract event,
not just a version bump.

## The compatibility contract (what consumers may rely on)

1. **`--json` output is additive-only.** Every key in
   [`docs/reference/cli/output-contracts.json`](reference/cli/output-contracts.json)
   is promised. Adding keys: always fine. Removing or renaming one: breaking
   change → major version bump, migration note in the changelog.
2. **Error codes** (`TX_REVERTED`, `INSUFFICIENT_FUNDS`, `NETWORK_ERROR`,
   `GAS_ESTIMATION_FAILED`) and **exit codes** are stable identifiers.
3. **The manifest** (`docs/reference/cli/manifest.json`) is the authoritative
   command surface; its `schemaVersion` bumps only on structural changes.
4. **Flags never disappear silently.** Deprecate first: keep the old flag
   working, emit a warning to **stderr** (never stdout — it would corrupt
   `--json` parsing), remove no sooner than the next major.
5. **Protocol/subgraph churn is not the consumer's problem.** Subgraph schema
   changes are absorbed with `queryWithFieldFallback` tiers; contract
   upgrades with on-chain condition detection (never version guessing). If a
   change forces an output change, it goes through rule 1.

## Release checklist

```bash
# 1. Everything green
yarn build && yarn test
yarn --cwd packages/agent build && yarn --cwd packages/agent test
yarn docs:check                    # generated reference + manifest + links

# 2. The output contract, verified against LIVE data
yarn contracts:check               # fails on any missing promised key
#    Intentional shape change? contracts:update && review the diff:
#    additions are fine; a REMOVAL means this release is a major bump.

# 3. Version bumps (keep both packages in lockstep unless truly independent)
npm version patch                  # or minor / major — updates package.json + git tag
(cd packages/agent && npm version patch)
#    If @poa/cli's major/minor changed: update the "^x.y.z" range in
#    packages/agent's prepack script.

# 4. Publish (order matters: cli first — agent's manifest depends on it)
npm publish --access public --otp=<code>
(cd packages/agent && npm publish --access public --otp=<fresh code>)

# 5. Prove the published artifacts cold
npx -y @poa/cli@latest --version
POP_READONLY=1 POP_DEFAULT_CHAIN=100 npx -y @poa/cli@latest org list --json

# 6. Push the tags
git push && git push --tags
```

## Version meaning while on 0.x

Semver treats 0.x minors as breaking. Our promise, stronger than semver:
**0.x.y → 0.x.(y+1) is always safe for consumers** (additive output, no flag
removals). Anything that would break a consumer bumps the minor (0.x → 0.x+1)
and is called out in the release notes. At 1.0.0 this becomes standard semver.

Consumers should pin `@poa/cli@~0.x` (Docker: exact version) and read
`pop --version` — which reports the real installed version — when debugging.
