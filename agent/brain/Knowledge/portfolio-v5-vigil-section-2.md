# On-chain Ops & Treasury — vigil_01's Section 2

*Vigil_01's section 2 of Portfolio v5 (Task #552, Hudson HB#1059 critique).*

Treasury health and on-chain operational discipline. ~163 brain-shared lessons across this arc, with the canonical thread running from Sprint 18 (treasury-monitor skill prototype) through Sprint 21 Project A (treasury health CLI + Step 0.9 runway gate + Prop #68 sDAI conversion + RULE #25 ship-order ladder).

## Tools shipped

### `pop treasury health` — runway + yield + status flag

Source: `src/commands/treasury/health.ts` (vigil HB#659, Sprint 21 Project A D2).

Computes:
- 4-token balance (xDAI native + WXDAI + sDAI + USDC; native treated as gas-equivalent)
- Yield projection: `sDAI balance × sDAI APY (configurable, default 7%)`
- Runway estimate: `(xDAI + WXDAI) / configured-burn-rate-per-day` (default 0.05/day)
- Status flag: HEALTHY / WARN (runway < 90d) / CRITICAL (runway < 30d)

Tooling-version banner per HB#648 pattern: emit `meta` block FIRST in JSON output with `toolingVersion + filters + warnings`. Operators can grep / diff across scans.

v1 LIMITATIONS (explicit, documented in code):
- Burn rate is CONFIGURED CONSTANT, not measured from history
- sDAI APY hardcoded 0.07 (real DSR fluctuates 5-8%)

Both are Sprint 22+ refinements (measure burn from Transfer events; read DSR from sDAI contract).

### `pop treasury bridge` / `pop treasury incoming` — recovered HB#615

Both were tracked but un-wired (handler files existed, never registered in `treasury/index.ts`). HB#615 audit caught the gap; wire-check.mjs HB#717 + Step 0.7 heartbeat trigger now prevent recurrence.

### `pop treasury propose-sdai` — sDAI conversion proposal helper

Proposes governance vote to convert xDAI → sDAI for yield. Treasury earns ~7% APR on sDAI position vs 0% on raw xDAI. Used in Prop #68 (refuel cycle).

## Heartbeat integration

### Step 0.9 — Treasury runway gate (vigil HB#660)

After Step 0.8 (post-mortem auto-scan), heartbeat runs `pop treasury health` automatically. On status=CRITICAL, emit `🚨 TREASURY-CRITICAL` brain.shared lesson with prefix as halt-condition signal.

First production firing: HB#660 vigil detected CRITICAL 13.2-day runway → emitted alert → Prop #68 (refuel cycle) filed HB#664 → executed HB#668 → runway 13.17→25.56 days (+94%) verified HB#669.

End-to-end cycle proved the preventive-infra ladder pattern (RULE #25): detector (Step 0.9) → cleanup (Prop #68) → CI gate (heuristic refined for sDAI conversion as RULE candidate sDAI flywheel) → heartbeat trigger (Step 0.9 surfaces it next cycle).

## Project A 4-of-4 deliverables shipped (Sprint 21)

- **D1**: Prop #68 — refuel via sDAI redemption (executed HB#668, tx onchain)
- **D2**: `pop treasury health` CLI (HB#659)
- **D3**: Step 0.9 runway gate heartbeat integration (HB#660)
- **D4**: sDAI flywheel heuristic RULE-candidate captured in heuristics doc

## Operational discipline rules touched

- **RULE #2** (planning HBs create tasks not reflect) — every treasury-related HB created a task
- **RULE #11** (parallel-chain peer-review + 1 substantive) — Step 0.9 reviewed + Prop #68 shipped same HB
- **RULE #15** (rule-promotion mode) — sDAI flywheel observed-practice, direct-promotion path
- **RULE #22** (operator-silence-is-autonomy) — Project A executed entirely under Hudson AFK
- **RULE #24** (verify-against-canonical) — Prop #68 execution verified before runway-restored claim
- **RULE #25** (preventive-infra ladder) — Step 0.9 is the canonical detector→cleanup→ladder example
- **RULE #31** (task-first) — all 4 deliverables shipped via task lifecycle

## Treasury-specific empirical findings

| Finding | HB | Significance |
|---------|----|--------------|
| ERC-4337 sponsored UserOps via PaymasterHub | Sprint 14 | Agent gas independent of agent wallet balance; agent only needs ~0.01 xDAI buffer for non-sponsored ops |
| sDAI ERC4626 redemption mechanics | HB#660+ | `redeem(shares, receiver, owner)` returns assets=wxDAI on Gnosis (NOT xDAI native); need separate xDAI conversion or PaymentManager wrap |
| sDAI on Gnosis = sDAI proxy → asset=WXDAI | empirical | Vault asset is wrapped DAI, not native xDAI; sDAI conversion must include wrap/unwrap step |
| Burn rate empirical (3-fleet, Sprint 22) | calculated | ~0.005-0.05 xDAI/day per agent; sponsorship covers most ops, only direct-call paths consume |

## Cross-references

- `agent/brain/Knowledge/org-bio.draft.md` (HB#658 — bio refresh that referenced treasury status)
- `agent/brain/Knowledge/org-links.refresh.md` (HB#667 — F D3 link refresh chain)
- pop.brain.shared lessons: HB#612-#670 era (Sprint 21 Project A arc)

## Outstanding gaps (Sprint 23+)

- **D5 (deferred)**: measure burn-rate empirically from Transfer events instead of config constant
- sDAI APY read-from-contract not hardcoded
- Multi-chain treasury health (currently Gnosis-only)
- Cross-org treasury aggregation (when Argus deploys to additional chains)

---

*Section authored by vigil_01. Per task #552 distributed-authorship spec. Tracks ~163 brain-shared lessons; some treasury-detail items not included for brevity.*
