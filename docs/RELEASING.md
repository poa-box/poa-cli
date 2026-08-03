# Releasing @poa-box/cli and @poa-box/agent

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
# 1. Everything green (yarn build builds packages/core first)
yarn build && yarn test
yarn --cwd packages/core test      # purity gate + calldata parity
yarn --cwd packages/agent build && yarn --cwd packages/agent test
yarn docs:check                    # generated reference + manifest + links

# 2. The contracts, verified
yarn contracts:check               # --json keys, against LIVE data
yarn --cwd packages/core api:check # @poa-box/core export surface (run after build)
#    Intentional shape change? contracts:update / api:update && review the
#    diff: additions are fine; a REMOVAL means this release is a major bump.

# 3. Version bumps (keep all three packages in lockstep unless truly independent)
#    Or skip 3-6 entirely: run the "Release" GitHub Action (workflow_dispatch,
#    dry_run=false) — it does everything below, skipping already-published
#    versions, and verifies the registry afterwards.
(cd packages/core && npm version patch)
npm version patch                  # or minor / major — updates package.json + git tag
(cd packages/agent && npm version patch)
#    If @poa-box/cli's major/minor changed: update the "^x.y.z" range in
#    packages/agent's prepack script. When @poa-box/core starts publishing to npm,
#    swap @poa-box/cli's "link:./packages/core" the same way at pack time.

# 4. Publish (order matters: core → cli → agent)
(cd packages/core && npm publish --access public --otp=<code>)
npm publish --access public --otp=<fresh code>
(cd packages/agent && npm publish --access public --otp=<fresh code>)

# 5. Prove the published artifacts cold
npx -y @poa-box/cli@latest --version
POP_READONLY=1 POP_DEFAULT_CHAIN=100 npx -y @poa-box/cli@latest org list --json
# link:-swap check — MUST print semver ranges, never "link:". The 0.1.0 agent
# shipped with dependencies["@poa-box/cli"]="link:../.." because the prepack
# npm-pkg-set targeted a stale key name; an installed link: dep fails for
# every consumer. Verify the swap actually landed in the registry:
npm view @poa-box/cli dependencies.@poa-box/core
npm view @poa-box/agent dependencies.@poa-box/cli

# 6. Push the tags
git push && git push --tags
```

## Version meaning while on 0.x

Semver treats 0.x minors as breaking. Our promise, stronger than semver:
**0.x.y → 0.x.(y+1) is always safe for consumers** (additive output, no flag
removals). Anything that would break a consumer bumps the minor (0.x → 0.x+1)
and is called out in the release notes. At 1.0.0 this becomes standard semver.

Consumers should pin `@poa-box/cli@~0.x` (Docker: exact version) and read
`pop --version` — which reports the real installed version — when debugging.
