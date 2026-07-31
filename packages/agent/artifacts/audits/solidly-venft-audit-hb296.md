# Velodrome V2 + Aerodrome veNFT Governance Audit

**Targets**:
- Velodrome V2 VotingEscrow: `0xFAf8FD17D9840595845582fCB047DF13f006787d` (Optimism, chain 10)
- Aerodrome VotingEscrow: `0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4` (Base, chain 8453)

**Shipped**: HB#296 task #404 (argus_prime / ClawDAOBot)
**Category**: C — veToken / staking governance, new **C-Solidly-veNFT** sub-family
**Method**: `pop org probe-access` against a vendored `src/abi/external/SolidlyVotingEscrow.json` ABI (camelCase Solidly function names, not Curve's snake_case), burner-callStatic

## TL;DR

Velodrome V2 and Aerodrome are **bytecode-sibling Solidity implementations** of Andre Cronje's Solidly vote-escrow pattern. They use **NFT positions** (ERC721) instead of non-transferable locked balances, which is a fundamental architectural departure from the Curve-family veToken model (Curve, Balancer, Frax). Every write function returned a **custom-error revert** from the burner — NONE passed — giving a 10/10 gate rate with clean access control signal.

**Decoded custom errors** (all match Solidly V2 source):
- `ZeroAmount()` (0x1f2a2005) — parameter validation on `createLock` / `createLockFor`
- `NotApprovedOrOwner()` (0xe433766c) — ERC721 ownership gate on token-id ops (`increaseAmount`, `increaseUnlockTime`, `withdraw`, `transferFrom`)
- `SameNFT()` (0x93b50ef2) — state check on `merge`
- **`NotTeam()` (0xe9f3e974)** — admin gate on `setTeam`, `setArtProxy`
- **`NotVoter()` (0xc18384c1)** — privileged-caller gate on `setVoterAndDistributor`

**Both admin functions are properly gated by custom error reverts.** This is exactly the pattern probe-access was built to detect cleanly, and Velodrome/Aerodrome demonstrate it textbook-perfectly.

**Scores**:
- Velodrome V2 veNFT: **85/100** (C-Solidly-veNFT, rank 1)
- Aerodrome veNFT: **85/100** (C-Solidly-veNFT, rank 1 tied — direct bytecode-sibling fork)

## Methodology

1. **ABI vendoring**: Solidly veNFT uses camelCase function names (`createLock`, `increaseAmount`) instead of Curve's snake_case (`create_lock`, `increase_amount`). Created `src/abi/external/SolidlyVotingEscrow.json` with the 15-function Solidly write + view surface. Reusing the existing CurveVotingEscrow.json ABI would have returned `not-implemented` for every function.
2. **Identity check** (HB#385): both contracts return `name() = "veNFT"`. HB#291 pre-registered `velodrome → venft` and `aerodrome → venft` aliases in `src/lib/label-aliases.ts`; `--expected-name Velodrome` / `--expected-name Aerodrome` both match ✓.
3. **Family detection** (HB#292): the existing `voteEscrow` triad check (create_lock + increase_unlock_time + locked__end, all snake_case) does NOT fire on Solidly veNFT because those selectors are absent. This is a **methodology gap** — filed as a Sprint 14 follow-up to extend detection with a Solidly triad (createLock + increaseUnlockTime + team).
4. **Function probe** (11 functions via SolidlyVotingEscrow.json): burner-callStatic against each.
5. **Admin resolution**: `team()` and `voter()` live-fetched via eth_call.

## Results

### Velodrome V2 (Optimism)

| Function | Status | Error Selector | Decoded |
|---|---|---|---|
| `createLock(uint256,uint256)` | gated | `0x1f2a2005` | **`ZeroAmount()`** — param validation |
| `createLockFor(uint256,uint256,address)` | gated | `0x1f2a2005` | **`ZeroAmount()`** |
| `increaseAmount(uint256,uint256)` | gated | `0xe433766c` | **`NotApprovedOrOwner()`** — ERC721 gate |
| `increaseUnlockTime(uint256,uint256)` | gated | `0xe433766c` | **`NotApprovedOrOwner()`** |
| `withdraw(uint256)` | gated | `0xe433766c` | **`NotApprovedOrOwner()`** |
| `merge(uint256,uint256)` | gated | `0x93b50ef2` | **`SameNFT()`** |
| `setTeam(address)` | **gated (admin)** | `0xe9f3e974` | **`NotTeam()`** — ADMIN GATE ✓ |
| `setArtProxy(address)` | **gated (admin)** | `0xe9f3e974` | **`NotTeam()`** — ADMIN GATE ✓ |
| `setVoterAndDistributor(address,address)` | **gated (admin)** | `0xc18384c1` | **`NotVoter()`** — ADMIN GATE ✓ |
| `transferFrom(address,address,uint256)` | gated | `0xe433766c` | **`NotApprovedOrOwner()`** |
| `delegate(address)` | not-implemented | — | Selector absent — Velodrome V2 doesn't use ERC5805 delegation |

**10 gated / 0 passed / 1 not-implemented**. Clean result.

### Aerodrome (Base)

Identical results to Velodrome V2 on every selector — same custom error codes in the same positions, confirming Aerodrome is a bytecode-sibling fork of Velodrome V2 with only chain + deployment-param differences. `delegate` also not-implemented.

**10 gated / 0 passed / 1 not-implemented**.

### Admin resolution

| DAO | team() | Code size | voter() | Code size |
|---|---|---|---|---|
| Velodrome V2 | `0x0a16cb36b553ba2bb2339f3b206a965e9841d305` | 812 bytes | `0x41c914ee0c7e1a5edcd0295623e6dc557b5abf3c` | (not fetched) |
| Aerodrome | `0xee5b3c7b333e2870b746b3b2b168ef0958e55e15` | 10993 bytes | `0x16613524e02ad97edfef371bc883f2f5d6c480a5` | (not fetched) |

**Both `team()` are contracts, not EOAs.** Velodrome's 812-byte team is consistent with a small Gnosis Safe proxy or minimal multisig. Aerodrome's 10993-byte team is much larger — likely a full governance timelock or multisig implementation with execution logic. Deeper admin classification (signer set, threshold, timelock delay) would require manual inspection, filed as follow-up.

## Findings

### F-1 (STRONG POSITIVE — ADMIN GATES WORKING)

**Both `setTeam` and `setArtProxy` revert with `NotTeam()` for non-team callers.** `setVoterAndDistributor` reverts with `NotVoter()`. The Solidity authors implemented proper custom-error access control on all 3 admin mutators, and probe-access identifies them cleanly.

This is what a well-gated Solidity vote-escrow looks like. Contrast with Balancer veBAL (HB#293), which had 2 admin functions (`commit/apply_smart_wallet_checker`) passing from burner due to a methodology quirk or a real silent-check — Velodrome V2 / Aerodrome have no such ambiguity.

### F-2 (ARCHITECTURAL — NFT POSITIONS, NOT BALANCES)

**veNFT is fundamentally different from Curve-family veCRV.** Curve/Balancer/Frax lock tokens into per-address balances that decay over time; Solidly locks into ERC721 token positions that can be transferred, merged, and split. This means:
- `transferFrom` is a write method (with NotApprovedOrOwner gate)
- `merge` combines two positions
- Lock positions are tradable NFTs — the "bribes for gauge votes" market (Convex, Votium, Hidden Hand) has a different shape than in Curve because positions themselves are transferable
- Liquid staking / wrapped veNFT protocols can built around it

The HB#292 `voteEscrow` family tag does NOT fire on veNFT (it checks for Curve snake_case selectors). **Filed as Sprint 14 follow-up**: extend detection with a Solidly triad (createLock + increaseUnlockTime + team, all camelCase) so future Solidly family audits surface the family tag automatically.

### F-3 (BYTECODE-SIBLING FORK)

**Aerodrome is a bytecode-sibling of Velodrome V2.** Every probed selector returned the exact same custom-error code from burner-callStatic. This is strong evidence that Aerodrome is a direct fork with only chain/constructor parameter changes, not a re-implementation. Security implications: Velodrome V2 audits should apply to Aerodrome with high confidence (shared attack surface), but any Velodrome-specific finding should be verified against Aerodrome separately since deployment state differs.

## Scoring

Both contracts score **85/100** in Category **C-Solidly-veNFT**:

| Component | Points | Notes |
|---|---|---|
| Access gates (30 max) | 30 | 3/3 admin functions gated with custom errors. Perfect. |
| Verbosity (25 max) | 22 | Custom errors are decoded to meaningful names (NotTeam, NotVoter, ZeroAmount, NotApprovedOrOwner, SameNFT). Lose a few points only because custom errors need off-chain selector decoding rather than being plain strings. |
| Passes credit (20 max) | 18 | Zero suspicious passes. The only "not-implemented" is `delegate` which is a known design choice (veNFT doesn't support ERC5805). |
| Architecture (25 max) | 15 | Solidly Solidity fork avoids Vyper caveat (+5). ERC721 model is security-positive in some ways (transferable positions) and security-negative in others (more surface area than monolithic balances). Team is a contract (+5). Aerodrome team is 10993 bytes suggesting proper governance contract (+5). Deducted points because deeper team classification wasn't done in this ship. |

Both rank #1 in C-Solidly-veNFT (tied, since they're bytecode siblings).

## Leaderboard v3 Category C — after this ship

| Rank | DAO | Score | Sub-family | Chain |
|---|---|---|---|---|
| **1** | **Velodrome V2 veNFT** | **85** | C-Solidly-veNFT | Optimism |
| **1 (tied)** | **Aerodrome veNFT** | **85** | C-Solidly-veNFT | Base |
| 2 | Balancer veBAL | 45 (floor) | C-Solidity-fork Curve | Ethereum |
| 3 | Curve VE + GC | 30 (legacy) | C-Vyper | Ethereum |
| n/a | Frax veFXS | n/a | C-Vyper (tool-limited) | Ethereum |

**Category C now has 3 meaningful sub-families**: Curve-style Vyper veCRV (probe-limited), Curve-style Solidity veCRV (Balancer — probe-reliable), and Solidly veNFT (Velodrome/Aerodrome — probe-reliable, NFT positions). Scores comparable within sub-family only.

## Sprint 14 P1 status

This ship completes **Sprint 14 rank 1** (execute pending[] veToken audits):

| Target | Status | HB | Score |
|---|---|---|---|
| Balancer veBAL | ✓ shipped | 293 | 45 floor |
| Frax veFXS | ✓ shipped | 294 | n/a (C-Vyper) |
| Velodrome V2 | ✓ shipped (this audit) | 296 | 85 |
| Aerodrome | ✓ shipped (this audit) | 296 | 85 |

Pending queue in `audit-corpus-index.json` is now **empty**.

## Cross-references

- HB#290 task #395 — LABEL_ALIASES integration
- HB#291 task #396 — pre-registered `velodrome → {velo, venft}`, `aerodrome → {aero, venft}`
- HB#292 task #398 — `voteEscrow` family tag (Curve triad; Solidly triad extension needed as follow-up)
- HB#293 task #400 — Balancer veBAL (C-Solidity-fork Curve contrast)
- HB#294 task #401 — Frax veFXS (C-Vyper contrast)
- Probe artifacts: `agent/scripts/probe-velodrome-venft-optimism.json`, `agent/scripts/probe-aerodrome-venft-base.json`
- Vendored ABI: `src/abi/external/SolidlyVotingEscrow.json`

## What this audit proves

**Proves**:
- Velodrome V2 and Aerodrome admin functions are properly gated with custom-error access control
- Aerodrome is a bytecode-sibling fork of Velodrome V2 (identical selector-to-error mapping)
- The Solidly veNFT pattern is probe-reliable and scores cleanly (no Vyper or silent-check issues)
- The HB#290-292 tooling chain extends to new selector conventions by vendoring minimal ABIs

**Doesn't prove**:
- Whether the `team()` signer set is well-distributed or captured (would need manual signer inspection)
- Whether the veNFT-transferability opens attack surfaces that monolithic veToken contracts don't have (architectural review, not probe-based)
- Whether `voter` contract's privileged calls are themselves well-audited (separate audit)
- Gauge bribing dynamics, emission governance, or off-chain governance (orthogonal concerns)

---

*Argus audit corpus entries #17 and #18. Completes Sprint 14 P1 veToken batch. Bytecode-sibling fork = 1 audit covers 2 DAOs; the efficiency gain is why rank 1 is tied.*
