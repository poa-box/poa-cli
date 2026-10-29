# Releasing the Poa packages

The authority-only 1.0 release has intentional access API removals. Read the [Wave G migration and upgrade order](WAVE-G-1.0.md) before publishing.

The CLI is the compatibility layer for the whole ecosystem: the frontend,
org brains, and agents parse its `--json` output so that protocol and
subgraph churn stays absorbed HERE. A release is therefore a contract event,
not just a version bump.

## Published core 2.1.0

Core 2.1.0 adds the five reviewed role-operation functions, their public types,
canonical role metadata, and packaged operation documentation/catalog. It retains
the execution and recovery fixes from the reviewed 2.0 line. Existing APIs remain
available; the minor bump makes the frontend's additional imports installable as
one registry version. CLI and agent versions stay unchanged.

Staged status requires a separate configuration proposal whose supported calls
bind to the proven created subject. Email allowlist status additionally accepts an
optional explicit read-only document fetch and verifies the committed root/org
and actual-subject leaf. Creation replay or unrelated configuration cannot report
completion. Earlier local 2.1.0 candidate archives remain diagnostic artifacts;
use the final hash recorded by the acceptance owner.

Build core, run its full tests and API check, then pack with lifecycle scripts
disabled. Verify that explicit archive through
`node packages/core/scripts/verify-packed-consumer.mjs PATH_TO_CORE_TGZ` before
installing it into a frontend. The verifier isolates the archive, checks public
declarations and packaged documentation, and runs synthetic Node/browser workflows.
Its evidence lives under `.context/registry-integration/`. Fixture success does not
prove deployed endpoint coverage, browser wallet consent, passkey prompts or live
vote creation. Frontend acceptance must exercise those host boundaries separately.

Core 2.1.0 is published. Do not republish that version. The release wrapper
derives core `^2.1.0` for a later CLI release while restoring local links after
its check; browser instead retains its explicitly tested exact core pin.

## Historical core 2.0.0 candidate

This update prepares `@poa-box/core@2.0.0` only. CLI and agent remain 1.0.0 with
local `link:` dependencies; unchanged published versions are not republished.
The major bump reflects optional/nullable historical OrgUser arrays and the
expanded organization metadata ReturnType. Default metadata calls preserve the
old exact-null contract. Raw metadata extension bookkeeping keys now survive
merging. See [core migration guidance](../packages/core/README.md#migrating-from-10-to-20).

The candidate is built, tested and packed locally. Integration evidence records
source/declaration/API/lock/build hashes and the exact tarball. Independent final
packed and live checks plus root review decide acceptance; this work authorizes
no npm publication, push, merge or deployed changes. A later CLI/agent adoption
release is separate. Local capture-only metadata verification must derive
core ^2.0.0 for a hypothetical CLI manifest and CLI ^1.0.0 for the agent, then
restore the original links. It is not a publication.

## Historical prepared 1.0.0 release

All three packages are already bumped to `1.0.0`. Do not run the generic version
bump examples below again for this release. Publish in dependency order:
`@poa-box/core` → `@poa-box/cli` → `@poa-box/agent`.

Merging the reviewed PR into `main` starts the Release workflow automatically.
For a manual release instead, run from the reviewed repository root, after the
validation checklist passes:

```bash
npm login
node scripts/release-preflight.mjs &&
node scripts/publish-package.mjs packages/core --access public --tag latest &&
node scripts/publish-package.mjs . --access public --tag latest &&
node scripts/publish-package.mjs packages/agent --access public --tag latest
```

Use the wrapper for every publish: it converts local `link:` dependencies into
registry-compatible semver ranges before npm reads the manifests. npm prompts for
an OTP if required; an individual invocation can also take `--otp=123456` with a
fresh code. If a publish fails, stop, rerun preflight, and publish only its remaining
`PUBLISH` entries. Versions already on npm cannot be republished.

The automated and manual paths are alternatives; do not run them concurrently.
Verify the published versions and dependency ranges:

```bash
npm view @poa-box/core@1.0.0 version
npm view @poa-box/cli@1.0.0 version dependencies.@poa-box/core
npm view @poa-box/agent@1.0.0 version dependencies.@poa-box/cli
npx -y @poa-box/cli@1.0.0 --version
npx -y @poa-box/agent@1.0.0 --version
```

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
# 1. Everything green (root tests also require the built agent)
yarn build && yarn --cwd packages/agent build
yarn test
yarn --cwd packages/core test      # purity gate + calldata parity
yarn --cwd packages/browser build && yarn --cwd packages/browser test
yarn --cwd packages/browser api:check
yarn --cwd packages/agent test
yarn docs:check                    # generated reference + manifest + links

# 2. The contracts, verified
yarn contracts:check               # --json keys, against LIVE data
yarn --cwd packages/core api:check # @poa-box/core export surface (run after build)
#    Intentional shape change? contracts:update / api:update && review the
#    diff: additions are fine; a REMOVAL means this release is a major bump.

# 3. Version bumps (only packages whose release is intended)
#    NORMALLY YOU STOP HERE: bump the versions in a PR and merge it. Merging to
#    main runs the Release workflow, which publishes exactly the bumped
#    packages and skips the rest. Steps 4-6 below are the manual fallback.
#    --no-git-tag-version: `npm version` otherwise tries to commit each bump,
#    and the second call then aborts on the dirty tree left by the first,
#    leaving a partially recorded release. Bump intended packages, then commit once; the
#    Release workflow pushes the per-package tags after publishing.
(cd packages/core   && npm version patch --no-git-tag-version)
npm version patch --no-git-tag-version   # or minor / major
(cd packages/agent  && npm version patch --no-git-tag-version)
git commit -am "Release: core X.Y.Z, cli X.Y.Z, agent X.Y.Z"
#    CLI/agent linked ranges need no hand-editing — see step 4.
#    Browser has its own version and exact core pin: update only after verification.

# 4. Publish ONLY the preflight PUBLISH entries (core → browser → cli → agent)
#    NEVER run `npm publish` directly here. npm reads the manifest it uploads
#    BEFORE running prepack, so a direct publish ships the local
#    "@poa-box/core": "link:./packages/core" range as REGISTRY METADATA and
#    the package is uninstallable — that is exactly how @poa-box/agent@0.1.0
#    shipped broken (`npm view @poa-box/agent@0.1.0 dependencies` still shows
#    it). publish-package.mjs applies the real range before invoking npm and
#    restores the link: afterwards, even if the publish fails or is killed.
yarn release:verify-metadata       # proves what npm WOULD send; publishes nothing
node scripts/publish-package.mjs packages/core  --access public --otp=<code>
node scripts/publish-package.mjs .              --access public --otp=<fresh code>
node scripts/publish-package.mjs packages/agent --access public --otp=<fresh code>

# 5. Prove the published artifacts cold
npx -y @poa-box/cli@latest --version
POP_READONLY=1 POP_DEFAULT_CHAIN=100 npx -y @poa-box/cli@latest org list --json
# link:-swap check — MUST print semver ranges, never "link:". The 0.1.0 agent
# shipped with dependencies["@poa-box/cli"]="link:../.." because the prepack
# npm-pkg-set targeted a stale key name; an installed link: dep fails for
# every consumer. Verify the swap actually landed in the registry:
npm view @poa-box/cli dependencies.@poa-box/core
npm view @poa-box/agent dependencies.@poa-box/cli

# 6. Record successful manual publishes (run from the exact published commit)
#    Substitute the actual versions; tag ONLY packages that published successfully.
git tag -a core-vX.Y.Z -m '@poa-box/core X.Y.Z'
git tag -a cli-vX.Y.Z -m '@poa-box/cli X.Y.Z'
git tag -a agent-vX.Y.Z -m '@poa-box/agent X.Y.Z'
git push origin core-vX.Y.Z cli-vX.Y.Z agent-vX.Y.Z
```

## How a release happens

**Merging to `main` is the release.** Bump the version of each package you are
releasing in a PR (`npm version patch --no-git-tag-version`), merge, and the
Release workflow publishes them — in dependency order, with provenance, then
pushes per-package tags and verifies the registry. A merge that changes no
version publishes nothing: a ~15s `plan` job sees every version already on the
registry and stops, so ordinary merges cost almost nothing.

This is safe because publishability is proven BEFORE merge, not after: CI runs
the full suite plus `release:verify-metadata`, which performs a real
`npm publish` against a capture-only localhost server and asserts the registry
metadata is clean. A PR that would publish a broken package fails review, not
production.

Manual dispatch (Actions → Release → Run workflow) remains for three cases:
a **dry run** (`dry_run: true` — verifies everything, publishes nothing),
**re-running after a partial publish failure** (already-published versions are
skipped, so it resumes the remaining uploads), and **prereleases** (`dist_tag: next`, since an rc on
`latest` would become every consumer's default install).

### Recovering after a tag or verification failure

A successful npm publish remains published even if a later tag push or registry
check fails. The workflow attempts tags for every successful upload, then reports
any tag failures. Rerunning does **not** repair missing tags or repeat checks for
already-published versions; if all versions exist, there is no remaining publish
work. Verify those exact versions manually with the commands above.

If registry propagation alone caused verification to time out, confirm the exact
published version and integrity before retrying. Re-run **all jobs**, so the plan
is recomputed and already-published versions are skipped. Do not re-run only the
failed publish job: its saved plan still requests the original publication.

Recover each missing tag from the **exact commit used by the successful publish**,
as shown in the failed workflow run, rather than the current tip of `main`. For
example, if only the core `1.0.0` tag is missing, replace `RELEASE_COMMIT` below:

```bash
npm view @poa-box/core@1.0.0 version
git fetch origin --tags
git tag -a core-v1.0.0 RELEASE_COMMIT -m '@poa-box/core 1.0.0'
git push origin core-v1.0.0
```

If the tag already exists locally, check that `git rev-parse core-v1.0.0^{commit}`
matches the release commit and push that tag instead of creating it again. Do not
replace an existing remote tag. Apply the same process only to other missing tags
whose package versions were successfully published.

## Publishing auth: trusted publishing (preferred) vs a token

npm warns that automation tokens carry security risk, and it is right: a
long-lived token stored as a repo secret can publish as you forever if it
leaks — via an exfiltrated secret, a compromised third-party action, or a
departing collaborator. **Trusted publishing** removes the credential
entirely: npm trusts *this repository + this workflow filename* over OIDC and
mints a short-lived, workflow-scoped token per run. Provenance is generated
automatically.

Set it up once per package (npmjs.com → package → **Settings** → **Trusted
Publisher** → GitHub Actions):

| Field | Value |
|---|---|
| Organization or user | `poa-box` |
| Repository | `poa-cli` |
| Workflow filename | `release.yml` (filename only, no path) |
| Environment | leave blank |

Then **delete the `NPM_TOKEN` secret**. The Release workflow detects which
mode is in play and prints it; it already sets `id-token: write` and runs
Node 22 + npm ≥ 11.5.1, which trusted publishing requires.

All three package names already exist on npm. Configure trusted publishing on
`@poa-box/core`, `@poa-box/cli` and `@poa-box/agent`; none needs a placeholder
first release. A token-based fallback requires a valid granular publish token
with the appropriate package permissions and bypass-2FA setting.

The workflow forwards the preflight step's outputs to the release job and records
only successful package uploads as tags/published entries, including after a
partial failure. Registry verification checks the exact expected dependency ranges.

## Version meaning while on 0.x

Semver treats 0.x minors as breaking. Our promise, stronger than semver:
**0.x.y → 0.x.(y+1) is always safe for consumers** (additive output, no flag
removals). Anything that would break a consumer bumps the minor (0.x → 0.x+1)
and is called out in the release notes. At 1.0.0 this becomes standard semver.

Consumers should pin the MINOR line — `@poa-box/cli@~0.1.1`, which resolves
`>=0.1.1 <0.2.0` — so they receive safe patches and never a breaking minor.
(Do not write `~0.x` literally: npm reads that as `~0`, i.e. `<1.0.0`, which
accepts every breaking release the policy allows — the exact opposite of a
pin.) Docker should pin an exact version. `pop --version` reports the real
installed version when debugging.


## Optional browser integration

`@poa-box/browser` is a separate package. Its first candidate is `0.1.0` and
it depends on the **published exact `@poa-box/core@2.1.0`**, not the repository's
local linked core. Changing core alone must not silently change that dependency.
The release preflight checks this exact version exists in the registry or is
included in the same release, and publishes browser after core. Browser releases
use `browser-v<version>` tags and the same metadata, artifact, tests and API gates.

Before the first publication, use a packed archive in consuming applications;
record its hash and run `packages/browser/scripts/verify-packed-consumer.mjs`
against that exact archive. This validates public imports and declarations,
executes the distributed runtime and independent role host, and bundles browser
code without Node globals. The reference frontend commits its candidate archive
for reproducible CI; switch it to the exact registry version after publication.
The package README explicitly labels this pre-publication state.

A new npm package name needs the one-time token-based publication described
above before trusted publishing can be configured for it. Do not merge or dispatch
a publishing workflow until the intended package/version plan has been reviewed.
Merging this package on main can trigger its first publication through the normal
release workflow; packing, CI and `dry_run=true` never publish.
