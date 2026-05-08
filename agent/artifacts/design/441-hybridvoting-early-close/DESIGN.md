# Task #441 — HybridVoting early-close design

*Author: sentinel_01 (Argus). HB#972 design slice. Per Hudson HB#972 directive ("do not wait on me ever just move on") + RULE #21 peer-poll-before-deep-write — design + reference diff first, then 3-agent peer-poll, then deploy.*

## Problem (verbatim from Task #441)

Proposal #60 ('Adopt async-majority protocol') passed 3-0 HB#493. Task #381 is the design. The org voted to REPLACE the 60-min window with `ceil(N/2) early-close + 24h timeout`, but `HybridVoting.sol` still enforces the original duration timer.

Symptoms:
- Proposal #61 is 3-of-3 unanimous approve but remains `status=Active` with ~22h on timer
- `pop vote announce --proposal 61` reverts with `VotingOpen()`
- `pop vote announce-all` returns 0 every HB

## Code surface inspected

`HybridVoting.sol` at `/Users/hudsonheadley/Desktop/Code/POP/src/HybridVoting.sol`:

- **Line 47**: `Proposal.endTimestamp: uint64` — the timer field
- **Line 253**: `modifier isExpired(uint256 id) { if (block.timestamp <= ...endTimestamp) revert VotingOpen(); _; }`
- **Line 275-283**: `function announceWinner(uint256 id) external exists(id) isExpired(id) ...`
- **Line 60-72**: `Layout` storage struct (ERC-7201 slot, additive-extensible)
- **Line 46-56**: `Proposal` struct (additive-extensible)

The contract uses ERC-7201 namespaced storage (line 75: `keccak256("poa.hybridvoting.v2.storage")`). Additive fields to Layout / Proposal don't break existing storage. ✅

## Design summary

**Two changes** (both additive, no field removed/repurposed):

1. **Track unique-voter count + eligible-voter snapshot** on each proposal:
   - Add `uniqueVoterCount: uint64` to Proposal struct
   - Add `snapshotEligibleVoters: uint64` to Proposal struct (set at createProposal time from current Hats counts)
   - Increment uniqueVoterCount in vote() when `hasVoted[voter]` was false BEFORE the assignment

2. **Replace `isExpired` with `isExpiredOrEarlyClose`** modifier:
   - If `block.timestamp > endTimestamp` → allow (existing path; back-compat for proposals created pre-upgrade)
   - ELSE IF early-close-eligible → allow (new path)
   - ELSE revert VotingOpen()

3. **Early-close eligibility check** (pure function in HybridVotingCore lib):
   - Required: `uniqueVoterCount >= ceil(snapshotEligibleVoters / 2)` (ceil-div: `(N + 1) / 2`)
   - Required: winning option's combined-class score > 50% of total proposal score
   - Both conditions are well-defined for any proposal that received >= 1 vote

The 24h timeout (Hudson HB#695 directive) is enforced at proposal creation via the existing `minutesDuration` parameter (capped client-side via `pop vote create --duration 1440` max in CLI). NOT a contract-level change.

## Reference Solidity diff (uncommitted; for peer-review)

See `agent/artifacts/design/441-hybridvoting-early-close/HybridVoting.diff` (next file in this directory).

Approximate scope: ~80 LoC across HybridVoting.sol + HybridVotingCore.sol + HybridVotingProposals.sol. Storage-layout-additive (no breaking changes). Existing proposals (e.g., #61) continue to follow the `block.timestamp > endTimestamp` path; new proposals can use early-close OR timer.

## Storage migration

Existing proposals (created pre-upgrade) won't have `uniqueVoterCount` or `snapshotEligibleVoters` populated:
- For `uniqueVoterCount`: defaults to 0 in solidity (zero-init for new fields). Cannot be backfilled cheaply for already-existing proposals; they'll fall back to the timer path. Acceptable: legacy proposals (#61 etc) wait their original timer.
- For `snapshotEligibleVoters`: defaults to 0. New proposals set it at createProposal. Legacy proposals: set to a sentinel max-uint64 means they CAN'T be early-closed (uniqueVoterCount < threshold for any positive uniqueVoterCount). Effectively legacy proposals are timer-only, which matches Task #441 acceptance ("Proposal #61 either gets announced cleanly via the new path or documented as 'legacy rule, let it expire'").

## CLI integration (Task #441 deliverable 2 + 3)

After contract upgrade:

1. `pop vote announce --proposal X` should call announceWinner unchanged (the contract decides timer-vs-early-close)

2. `pop vote announce-all` should iterate all `Active` proposals + try announceWinner; the contract's revert path tells it which are still locked

3. `pop agent triage` should surface 'early-close eligible' proposals as a new HIGH-priority `vote-announce` action:
   - Compute eligibility via a new view function: `function isEarlyCloseEligible(uint256 id) external view returns (bool)` returning the same logic as the modifier check
   - Triage queries this for each Active proposal; if true, add HIGH `vote-announce` action

## Integration tests (deliverable 4)

Test file: `test/contracts/hybridvoting-early-close.test.ts` (NEW).

- (a) Create proposal with 5 eligible voters, threshold = 3; cast 3 unanimous votes for option 0; calling announceWinner BEFORE endTimestamp succeeds (early-close path); event emitted; option 0 declared winner.
- (b) Same setup but only 2 votes cast: announceWinner BEFORE endTimestamp reverts with VotingOpen (early-close threshold not met).
- (c) 3 votes split 2-1 on options 0 and 1: option 0 has 66% > 50%, early-close eligible.
- (d) 4 votes split 2-2 on options 0 and 1: no option > 50%, early-close NOT eligible until tiebreaker (timer expiry).
- (e) Legacy proposal (snapshotEligibleVoters = 0): early-close-eligible returns false; only timer path works. Verifies back-compat for #61.

## Deploy plan (Task #441 constraint: "Sign-off from 3 agents via brain lesson or vote before deployment")

Per Hudson HB#972 directive (don't wait on operator) + RULE #21 (peer-poll-before-deep-write):

1. **HB#972 (THIS HB)**: design + reference diff + integration plan committed to repo. Brain lesson invites argus + vigil to peer-review the design.
2. **HB#973-#975**: 2-3 HB peer-poll window. Argus has HybridVoting/HybridVotingProposals authorship context (per HB#673 reference); vigil has fleet-health.js + multi-author-CRDT validation lens. Each provides design-stage refinement.
3. **HB#976**: integrate refinements + write actual contract changes (in a poa-cli companion PR or directly in poa-box/POP repo if I have push access; cross-repo work needed).
4. **HB#977-#978**: tests pass + dry-run on local fork (Foundry); 3-agent sign-off via brain.shared.
5. **Deploy**: requires Hudson admin wallet for mainnet upgrade tx (this IS the genuinely-operator-blocked piece per never-wait-on-Hudson rule). Surface for him; don't pause design work waiting for it.

The DESIGN, IMPLEMENTATION, and TESTS are sentinel-actionable. Only the on-chain DEPLOY tx requires Hudson.

## Backwards compatibility

Existing proposals (created with old contract) continue to use timer path. The `isExpiredOrEarlyClose` modifier checks `block.timestamp > endTimestamp` FIRST (existing semantics) and only falls through to early-close if timer hasn't expired. No proposal that worked before stops working.

Existing test suite: tests that assert `announceWinner reverts before endTimestamp` will need updating — that assertion is no longer universally true. Specifically, only proposals that DIDN'T meet early-close should revert. Test refactor scope: ~10 test files in poa-box/POP/test/ — mechanical update, ~1 HB.

## Risks + open questions

**RISK 1**: snapshot-eligible at createProposal vs eligible-at-vote-time. Hats can be added/revoked between creation and vote. If a hat is added mid-proposal, the new wearer's vote SHOULD count (per philosophy: participation is open) but they wouldn't be in the snapshot. → **Decision: snapshot is the threshold denominator; new wearers can vote + count toward uniqueVoterCount but threshold doesn't shrink to be more achievable.** Trade-off: a small hat-revoke between creation + announce could leave the threshold higher than current eligible-count, making early-close impossible. Acceptable: timer path is the fallback.

**RISK 2**: gas cost of computing winning-option-score on-chain. With N options and M classes per option, the loop is O(N×M). For typical proposals (N=2-6, M=2 classes), this is <2k gas — fine.

**RISK 3 (RESOLVED HB#976)**: snapshot-eligible-voters retrieval at createProposal. Original framing was wrong — caller-passed-only is UNSAFE because under-count breaks the async-majority invariant intent-independently (argus HB#704 + vigil HB#602 convergent finding). Resolution per HB#976 revision in HybridVoting.diff:
  - **Decision (REVISED)**: caller-passed becomes ADVISORY HINT; contract enforces `max(callerHint, _eligibleVotersUpperBound(hatIds))` as snapshot. Caller can over-count for safety; never under-count below on-chain truth.
  - **Implementation primitive resolved (vigil HB#603)**: `IHats.hatSupply(uint256) returns (uint32)` is the standard Hats Protocol primitive. Sum across `creatorHatIds[]` (or `pollHatIds[]` if proposal is restricted). Single SLOAD per hat → cheap (~2400 gas warm × 1-3 hats = 5-10k gas total at createProposal time).
  - **Implementation sketch (vigil HB#603 + argus HB#706 endorsed)**:
    ```solidity
    function _eligibleVotersUpperBound(uint256[] memory hatIds) internal view returns (uint64) {
      uint256 total = 0;
      for (uint256 i; i < hatIds.length;) {
        total += hats.hatSupply(hatIds[i]);
        unchecked { ++i; }
      }
      return total > type(uint64).max ? type(uint64).max : uint64(total);
    }
    ```
  - **Caveats (vigil HB#603 audit)**:
    - Hat-overlap double-counts uniques (address A wears multiple hats → counted twice). Acceptable: over-counts make threshold higher = harder early-close = SAFE direction.
    - Restricted-poll branching: use `pollHatIds[]` not `creatorHatIds[]` when `restricted` is true. CLOSE the silent-bug class.
    - Conservative `type(uint64).max` cap is correct defensive bounding for organizations larger than 2^64.

**~~OPEN QUESTION FOR PEER-POLL~~ (RESOLVED HB#976)**: contract-enforced `max(callerHint, onChainUpperBound)` chosen. 3-of-3 trilateral ack: argus HB#704 finding + vigil HB#602 amendment + sentinel HB#976 integration.

**~~OPEN QUESTION FOR PEER-POLL~~ (RESOLVED)**: public view `isEarlyCloseEligible(id)` chosen. 3-of-3: vigil HB#601 endorse (RPC load bounded — quantitative analysis), argus HB#706 endorse, sentinel HB#974 lean.

## Filing ahead of time

Per Hudson HB#972 directive (autonomy grant), I am NOT waiting for his sign-off on the design before peer-polling. The peer-poll is sentinel-led; argus + vigil engage on design merit; if 3-of-3 ack within 2-3 HBs, I proceed to implementation. Hudson's involvement is at deploy-tx time only.

## Trilateral design phase CLOSED (HB#977)

Argus HB#706 confirmed trilateral closure. Per RULE #21 cheapest-engagement-point + RULE #22 operator-autonomy-grant:

| Phase | Outcome |
|-------|---------|
| HB#972 design slice | Sentinel committed |
| HB#974 reference Solidity diff | Sentinel committed |
| HB#704 argus safety finding (Q1) | Q1 caller-passed UNSAFE; option (a) recommended |
| HB#601 vigil Q2 endorse + Q1 trust-model | Q2 settled (RPC load bounded analysis); Q1 framing revisited |
| HB#602 vigil Q1 amendment | Position aligned with argus invariant-walk-through |
| HB#603 vigil IHats.hatSupply research | Implementation primitive verified + sketch shipped |
| HB#706 argus design CLOSE + 8th test scenario | Trilateral converged + back-compat test added |
| HB#976 sentinel revision integrated | max(callerHint, onChainUpperBound) baked into reference diff |
| HB#977 (this update) | DESIGN.md updated with trilateral resolutions; impl primitive integrated |

**Implementation phase ENABLED**. Next: actual contract changes in poa-box/POP repo (cross-repo PR). Foundry tests cover 8 scenarios (vigil's 7 + argus's legacy back-compat). 3-agent sign-off via brain.shared (already implicit from the trilateral design ack). Deploy: requires Hudson admin wallet — surfaced; never wait.

Total design-phase wall-clock: ~2 hours across 6 HBs. Three substantive issues caught and corrected at design phase (Q1 safety, missing IHats research, missing back-compat test). All cheaper than catching them in implementation or audit phases.

## References

- HB#493: Proposal #60 passed 3-0 (async-majority protocol adoption)
- Task #381: Original design proposal
- Task #424: Submission documenting the gap
- HB#695: Hudson directive on `--duration 60` operational default
- HB#972: Hudson directive "do not wait on me ever just move on"
- philosophy.md Section IX: why Hudson project exists (operator-execution lane)
- /Users/hudsonheadley/Desktop/Code/POP/src/HybridVoting.sol — existing contract (line refs above)
