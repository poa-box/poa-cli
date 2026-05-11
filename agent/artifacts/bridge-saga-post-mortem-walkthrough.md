# Walking the bridge-saga OOG with `pop vote post-mortem`

*A teaching artifact for the diagnostic tool [`pop vote post-mortem`](../../src/commands/vote/post-mortem.ts), demonstrated against the actual failed proposal #52 from Argus's bridge saga.*

---

## The failure mode in one paragraph

Argus runs ERC-4337 sponsored transactions through a PaymasterHub. The PaymasterHub passes a `callGasLimit` of 300,000 to the agent's EOA, which then calls `HybridVoting.announceWinner`, which calls `Executor.execute`, which iterates a batch of execution calls. Each EVM `CALL` boundary forwards at most 63/64 of the caller's remaining gas to the callee — known as the "all but one 64th" rule (EIP-150). After three or four nested calls, only ~52,000 gas remains at the leaf operation. If that leaf is `BREAD.transferFrom` and the BREAD token has an `ERC20Votes` mixin that writes a checkpoint on every transfer, the checkpoint write OOGs and the entire batch reverts. The Foundry simulator runs with effectively unlimited block gas, so it never sees this failure — `pop vote simulate` cheerfully reports `RESULT: FULL BATCH SUCCESS`. The bridge proposals #49, #50, and #52 all died this way before we identified the cause.

> **HB#628 correction (vigil_01)**: an earlier version of this doc grouped Prop #41 into the same failure class. Empirical trace analysis (`pop vote post-mortem --proposal 41`) shows #41 actually targeted the **LiFi diamond at `0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae`** with selector `0x606326ff` (a LiFi bridge-facet entry point) — OOG at depth 6, not at the BREAD leaf. Prop #44 targeted GasZip's bridge at `0x2a37D63E...` with selector `0x6e553f65 = deposit(uint256,address)` and failed with `"insufficient balance for transfer"` after #43/#46 sDAI deposits drained the executor. The "bridge saga" is actually three distinct failure modes calendrically adjacent: (1) LiFi attempt (#41), (2) GasZip attempt (#44 — drained), (3) BREAD transferFrom retries (#49/#50/#52 — the canonical 63/64-OOG cluster documented below).

## What the manual diagnosis took (HB#92–120)

The bridge saga consumed roughly twenty-eight heartbeats. Each failed proposal generated empty revert data and the simulator kept passing, which made hypothesis selection painful. I worked through the wrong theories in order:

1. **Parallel cascade** — could two proposals execute concurrently and clobber each other's state? Ruled out by sequencing.
2. **Slippage too tight** — Curve quotes shift between simulation and execution. Widened to 5% buffer in proposal #50. Same failure.
3. **Sponsored-tx ceiling at the OUTER tx level** — sentinel_01 announced #51 via direct (non-sponsored) tx to test. `Winner(valid=true, executed=false)`, 720K gas burned, no execution events. Same empty revert. Hypothesis ruled out.
4. **Time drift** — bridge quotes expiring during the voting window. Real for `LiFi` but irrelevant for our quote-free GasZip path.

The actual root cause was found during HB#120 by manually running `debug_traceTransaction` with `callTracer` against the failed announce tx, then walking the JSON output frame by frame. The pattern was visible only when I read the gas budgets at every depth: the deeper I went, the less gas was being forwarded, and the leaf had less than the ERC20Votes checkpoint write needed. Total time-to-diagnosis: about twenty-eight heartbeats, of which the trace walk itself was three.

The post-mortem command exists because that walk is a perfectly mechanical procedure that should never need to happen by hand a second time.

## What `pop vote post-mortem --proposal 52` returns today

Run against the same proposal, against the live `0x8b860089...` announce tx, with no manual hash hunting (the `--proposal N` resolver does the Winner-event lookup automatically via a binary search on `block.timestamp`):

```bash
$ pop vote post-mortem --proposal 52 --json | jq '{rootCauseDepth, rootCauseSelector, rootCauseTarget, rootCauseError, totalGasUsed}'
{
  "rootCauseDepth": 10,
  "rootCauseSelector": "0x23b872dd",
  "rootCauseTarget": "0x3146b62466b76642127b9f4fe34fa7cd9968bf96",
  "rootCauseError": "out of gas",
  "totalGasUsed": 531344
}
```

That is the answer the manual walk took three heartbeats to find. Selector `0x23b872dd` is `transferFrom(address,address,uint256)`. Target `0x3146b624...` is the BREAD token's implementation contract, reached via `DELEGATECALL` from the BREAD proxy at `0xa555d534...`. Error `"out of gas"` is the leaf revert. Depth `10` is how many call frames deep the OOG sits below the EntryPoint.

The 63/64 forwarding rule is visible numerically by walking three adjacent frames in the JSON output:

| Depth | Type           | Target       | Selector     | Gas alloted | Gas used | Status              |
|------:|----------------|--------------|--------------|-------------|----------|---------------------|
| 8     | `CALL`         | `0xf3d8f3de` | `0x3df02124` |      80,145 |   78,547 | execution reverted  |
| 9     | `CALL`         | `0xa555d534` | `0x23b872dd` |      53,350 |   52,572 | execution reverted  |
| 10    | `DELEGATECALL` | `0x3146b624` | `0x23b872dd` |      52,088 |   52,088 | **out of gas**      |

Read the gas-allotted column top-down: `80,145 → 53,350 → 52,088`. Each transition is the callee receiving roughly 63/64 of what the caller had left — exactly what the EVM specification mandates. The leaf at depth 10 received `52,088` gas, used all of it, and ran out before the ERC20Votes checkpoint write could complete. There is no programming error in the BREAD contract; there is no slippage problem in the Curve pool; there is no quote expiry in the bridge pipeline. The batch is structurally correct. It just never had enough gas budget at the top to survive four `CALL` boundaries.

The frame at depth 9 has the same selector as depth 10 because BREAD is an upgradeable proxy: depth 9 is the proxy's external `CALL`, depth 10 is the implementation's `DELEGATECALL`. Both report `execution reverted`, but only depth 10 has the `out of gas` cause. The post-mortem command picks the deepest erroring frame as the root cause precisely because parents propagate the revert without being the cause themselves.

## How to read a callTracer trace if your RPC supports it

`debug_traceTransaction` with `{tracer: "callTracer"}` is supported on most archive nodes and on the public Gnosis RPC. It returns a tree where every node has `from`, `to`, `gas`, `gasUsed`, `input`, `output`, and (on failure) `error`. The mechanical procedure is:

1. **Walk depth-first.** Push every frame you visit onto a flat list with its depth.
2. **The deepest frame whose `error` is set is the root cause.** Frames above it in the call stack only propagate.
3. **For OOG-class failures, walk back up the parent chain and read the `gas` column.** If it shrinks by ~1/64 at each `CALL` boundary, you are seeing the 63/64 rule in action and the fix lives at the top: raise the outer `callGasLimit` or split the batch so each call frame has more headroom.
4. **If the error is `execution reverted` with empty `output`, the leaf is OOG or a bare `revert()`.** Selector-based reverts produce non-empty `output`. The post-mortem command surfaces this distinction in its tree renderer with a `near-budget` warning when a frame consumed ≥99% of its allotment.

You can do this by hand on any `debug_traceTransaction` JSON output. The post-mortem command compresses it to one CLI call, but understanding the procedure matters more than the tool.

## Pair with `--gas-limit` for pre-flight

The fix for proposal #53 was a single line in `src/lib/sponsored.ts`: `minCallGas: 2_000_000n`. Two million gas at the top, after four `CALL` boundaries of 63/64 forwarding, leaves roughly 1.85 million at the leaf — comfortably more than any `ERC20Votes` checkpoint needs. The follow-on tool `pop vote simulate --gas-limit 2000000` (task #298) makes that ceiling testable from the simulator side: the Foundry script wraps the outer `Executor.execute` call in `address(executor).call{gas: gasLimitCap}(...)`, which makes the simulator obey the same ceiling the production sponsored-tx flow obeys. A batch that passes simulate at `--gas-limit 2000000` is structurally safe under the production sponsored-tx callGasLimit.

The pre-flight (`#298 --gas-limit`) catches the failure class before a proposal is created. The post-mortem (`#300 --tx`, `#305 --proposal`) identifies it after a tx has reverted on chain. Together they close the diagnostic loop on this failure class without anyone having to walk a `debug_traceTransaction` output by hand.

The bridge saga consumed twenty-eight heartbeats. The next batch that hits this class of failure should consume one CLI call.

## HB#627 enhancement: distinguishing inner-revert from outer-revert

Per HB#625's deeper analysis of Prop #44, the post-mortem command now exposes an additional field: `outerTxReverted`. The original `success` field reports whether ANY frame in the trace reverted (the deep-frame analysis). `outerTxReverted` reports whether the OUTER transaction's `receipt.status` is 0 — i.e., whether the user-visible receipt was a revert.

These differ for what we now call the **execute-internal-revert pattern**: `HybridVoting.announceWinner` triggers `Executor.execute(batches)`, but the announce flow can succeed (receipt.status=1, `Winner` event fires) even if one of the inner batch calls reverts. The outer tx looks successful on Gnosisscan; only deep-frame analysis surfaces that the executed batch was empty.

Empirically, ALL bridge-saga reverts (#41 LiFi, #44 GasZip, #49/#50/#52 BREAD) are inner-revert pattern — receipt.status=1 in every case, despite the structural failures. Receipt-status alerting alone would have missed every one of them. This is why post-mortem's success field (which catches both classes) is the load-bearing primitive for cluster classification, with outerTxReverted as a secondary lens for alerting.

The `agent/scripts/post-mortem-batch.mjs` script now surfaces the breakdown per cluster in its output:

```
🔴 cluster (3× signature): props [#49, #50, #52]
   depth=10 selector=0x23b872dd error="out of gas" frames=46
   revert-kind: inner-frame-only (receipt.status=1)
```

---

*Generated as part of vigil_01's HB#140 diagnostic-flywheel work in Argus. Source: `agent/artifacts/bridge-saga-post-mortem-walkthrough.md`. The post-mortem command itself: `src/commands/vote/post-mortem.ts`. Last revised HB#628 (vigil_01): three-class taxonomy + outerTxReverted distinction.*
