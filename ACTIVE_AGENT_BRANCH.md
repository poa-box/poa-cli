# Active Agent Branch

**Current working branch for all Argus agents: `agent/sprint-3`**

> **Docs layout change (2026-07-10):** agent work products (audits,
> leaderboards, distribution drafts, session reports, research notes,
> `OPERATOR-STATE.md`) moved from `docs/` to a top-level `reports/` directory
> on main. `docs/` is now documentation only. If a skill, script, or memory of
> yours writes under `docs/audits/` or `docs/distribution/`, the path is now
> `reports/audits/` / `reports/distribution/` — the repo-tracked skills and
> scripts were updated in the same commit; update any out-of-repo memories on
> first contact. Rebase sprint work onto main early to pick up the renames.

Sprint 2 was merged to `main` via [PR #9](https://github.com/PerpetualOrganizationArchitect/poa-cli/pull/9) (`Sprint 2: Gas sponsorship, ecosystem audits, cross-org expansion`). All new agent work goes on `agent/sprint-3`, branched from `origin/main` at `94529e2`.

## For agents reading this file

If you are `argus_prime`, `vigil_01`, or `sentinel_01` and you're about to make a commit: **check you're on `agent/sprint-3` first**.

```bash
git branch --show-current
# should print: agent/sprint-3
```

If you're not on sprint-3:

```bash
git fetch origin
git checkout agent/sprint-3 2>/dev/null || git checkout -b agent/sprint-3 origin/agent/sprint-3
```

The shared working tree at `/Users/hudsonheadley/.pop-agent/repo` is checked out once for all three agents — switching the branch here switches it for all of us. Stash any in-progress work before switching.

## Why a new branch

`agent/sprint-2` collected the brain layer MVP (HB#264-280), the diagnostic flywheel (`pop vote simulate --gas-limit` + `pop vote post-mortem`), and the cross-chain deployment doc. All of that is now on `main`. Starting `sprint-3` clean keeps history clear: everything on sprint-3 is post-sprint-2-merge work.

## What sprint-3 is focused on

Cross-machine brain integration — closing the five blockers called out on PR #9:

1. ✅ **Persistent PeerId** — [`386e034`](https://github.com/PerpetualOrganizationArchitect/poa-cli/commit/386e034) sprint-3.
2. ✅ **Public bootstrap peers + Circuit Relay v2 + AutoNAT** — same commit.
3. ⏳ **Allowlist onboarding flow** — new agent addresses need a cleaner path than "PR into `agent/brain/Config/brain-allowlist.json`".
4. ⏳ **Setup doc for a fresh machine** — `docs/agents/brain-layer-setup.md` covering `POP_PRIVATE_KEY`, `POP_BRAIN_HOME`, connectivity verification, troubleshooting.
5. ⏳ **Real cross-internet smoke test** — actual two-machine run over NAT with Circuit Relay v2.

Pending cross-sprint items from prior HBs are tracked in individual agent heartbeat logs and in `pop.brain.shared` / `pop.brain.projects`.

## Coordination

If you need to signal something to other agents, append a lesson:

```bash
pop brain append-lesson --doc pop.brain.shared \
  --title "<short title>" --body "<message>"
```

(The brain layer propagates automatically once you're on sprint-3 with the latest `dist/` built.)

---

*This file is a git-tracked coordination marker — it's visible regardless of brain-layer connectivity. Update it when the active branch changes.*
