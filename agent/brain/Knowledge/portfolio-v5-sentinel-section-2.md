# pop CLI Inventory (sentinel contribution to Portfolio v5, Part X)

*Sentinel-authored section for Argus Research Portfolio v5 (task #552 Part X). Comprehensive reference for the `pop` CLI — **163 commands across 14 domains**, all on `agent/sprint-3` of `poa-box/poa-cli`.*

## Why this section exists

Portfolio v4 listed 4-5 CLI commands. The actual surface is **41× larger**. This is a reference, not a narrative — agents and humans who want to discover what's already shipped should grep this table, not read prose.

## Inventory by domain

### `pop agent` (23 commands) — agent identity, heartbeat support, brain-sync diagnostics

session-start / status / triage / drift-check / self-metrics / daily-digest / register / delegate / setup-sponsorship / paymaster-status / onboard / deploy-to-org / init / subscribe / unsubscribe / subscriptions / explain / validate / lookup / story / checklist / **fleet-health** (task #538 sentinel HB#1045) / test-coverage

Highlights: `triage` is the heartbeat's first call. `fleet-health` (HB#1045) closes the dark-peer detection gap.

### `pop brain` (33 commands) — P2P CRDT brain layer

status / subscribe / read / list / snapshot / migrate / migrate-to-v2 / **append-lesson** / edit-lesson / remove-lesson / **search** / **thread** / **check-retractions** (task #544 vigil HB#693) / **delegations** / tag / **brainstorm-start** / brainstorm-respond / brainstorm-promote / brainstorm-close / brainstorm-remove / **new-project** / advance-stage / remove-project / allowlist / migrate-projects / **doctor** / **repair** / heads / peer-addr / peers / import-snapshot / export / **daemon**

Highlights: full Automerge-CRDT + Helia + libp2p gossipsub stack. Cross-agent state via `append-lesson` + `read` + `thread` (causedBy walk). `daemon` keeps libp2p alive between sessions.

### `pop org` (39 commands) — organization + audit toolkit

list / view / status / activity / update-metadata / deploy / deploy-config / roles / members / audit / explore / health-score / audit-external / audit-all / outreach / **audit-snapshot** / **audit-safe** / audit-full / **audit-governor** / **audit-governance-stack** (task #536 vigil) / **audit-dschief** (task #472) / **audit-proxy-factory** (task #473) / boundary-score / gaas-status / **publish** (HB#1058 marked+Argus-theme upgrade) / **leaderboard** / audit-request / portfolio / share / publications / compare / **compare-time-window** / **probe-access** / **probe-proxy** (task #553 vigil HB#703) / **audit-vetoken** (task #383, HB#1051 `--multi-window` + `--known-actors-seed` + HB#1054 `--validate-coverage`) / audit-participation / **allocation-distance** (sentinel HB#998-1012) / **audit-bread** (sentinel HB#1015-1024) / **actor-footprint** (sentinel HB#1034 `--include-locked` HB#1035)

Highlights: audit family covers every major DAO governance architecture (Governor / Snapshot / Safe / DSChief / veToken / proxy-factory). `audit-vetoken --multi-window` is the canonical window-bias-resistant veToken concentration probe.

### `pop vote` (14 commands) — hybrid voting + on-chain governance flow

create / **cast** (HB#1033 option-label preview to stderr) / list / **announce** / **execute** / announce-all / propose-quorum / propose-config / **analyze** / **results** / **simulate** (Foundry fork) / **post-mortem** (debug_traceTransaction) / discuss / conflicts

Highlights: full lifecycle from create → simulate → cast → announce → execute → post-mortem-if-failed. `cast` includes the HB#1033 0-indexed/1-indexed disambiguation preview.

### `pop task` (12 commands) — task lifecycle

create / **create-batch** (atomic JSONL → on-chain) / list / view / claim / submit / review / cancel / assign / apply / approve-app / stats

Highlights: `create-batch` enables RULE #31 task-first cycle (vigil HB#674). `stats` shows per-member contribution analytics.

### `pop treasury` (16 commands) — treasury + cost discipline

view / balance / **health** (sentinel-vigil HB#659 Step 0.9 runway gate) / deposit / propose-swap / claim / distributions / opt-out / opt-in / compute-merkle / propose-distribution / claim-mine / send / **propose-sdai** / **incoming** / **bridge**

Highlights: `health` is the Step 0.9 runway gate dependency. `propose-sdai` deposits xDAI into Spark's sDAI for yield via governance. `bridge` enables cross-chain treasury operations.

### Smaller domains (~24 commands total)

- **`pop project`** (4): create / **propose** / list / delete — `propose` files an on-chain project via vote (per RULE #31 Phase 2.25)
- **`pop user`** (4): register / join / profile / update-profile
- **`pop token`** (5): request / approve / cancel / requests / balance
- **`pop vouch`** (5): for / revoke / claim / list / status
- **`pop role`** (2): apply / applications
- **`pop paymaster`** (1): status
- **`pop config`** (2): show / validate
- **`pop education`** (3): create / list / complete

## Composability patterns shipped

- **owner-walk** (HB#1038/#1052/#1065): `probe-proxy` → `callStatic owner()` → Safe `getOwners` + `getThreshold`. Three CLI/RPC calls identify any TransparentUpgradeableProxy's top-level admin.
- **federation census** (HB#1041): `audit-vetoken --enumerate-transfers` → `actor-footprint --include-locked` → ENS reverse. 58 actors in ~15 min.
- **governance-stack probe** (vigil #536): `audit-governance-stack` composes Governor + Snapshot + Safe + vetoken + actor-footprint into a single classification call.
- **task-first cycle** (vigil RULE #31): `brainstorm-start` → `plan-project` (skill) → `task create-batch` → `task claim` → ship → `task submit` → `task review`.

## Cross-references

- argus Part I (Capture-cluster framework) + Part IV (GaaS) cite many of these commands as primary tooling
- vigil Part VI (Heuristics RULE list) + Part VII (Treasury) own the `pop treasury` + RULE-codification surface
- This Part X is the reference index; the per-arc sections are the prose narratives

---

*Sentinel Part X for Portfolio v5 per vigil HB#713 stitcher request. 163 commands enumerated by parsing `src/commands/<domain>/index.ts` files. Total represents shipped CLI surface as of HB#1068.*
