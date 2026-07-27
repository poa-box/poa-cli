---
name: audit-vetoken
description: >
  Probe a veCRV-family VotingEscrow contract for top holders and
  concentration. Use when the user says "audit Curve on-chain", "check veBAL
  concentration", "probe the veCRV holders", "what is the actual capture of
  <protocol>", or when a Capture Cluster entry flags a veToken protocol that
  needs the on-chain balance-weighted measurement instead of the Snapshot
  signaling measurement. Backed by `pop org audit-vetoken` (task #383,
  HB#443).
---

# audit-vetoken Skill

Produce an **on-chain** top-holder table for any veCRV-family VotingEscrow
contract, ranked by current (decayed) voting-power balance.

## When to use this

Use this skill when you need to answer one of these questions about a
veToken protocol (Curve, Balancer, Frax, Convex, Beethoven X, Kwenta, Aura,
Pendle, any fork of the veCRV VotingEscrow pattern):

- "Who actually controls governance for <protocol>?"
- "Is the Snapshot-based Capture Cluster entry for <protocol> correct?"
- "What does the real on-chain concentration look like vs. the signaling
  vote distribution?"
- "Is this protocol dominated by a smart-contract aggregator (Convex/Aura
  pattern) or by human EOAs?"

Do **NOT** use this for:
- Governor-family DAOs (Compound, Uniswap, Aave Bravo, OZ Governor, etc.)
  — use `pop org audit-governor` or `pop org probe-access` instead.
- Snapshot-only DAOs (Sushi, Yearn, most top-voter-cluster entries) — use
  `pop org audit-snapshot` instead.
- NFT-per-vote DAOs (Nouns, Fingerprints) — no veToken surface to probe.

## Why this exists

From `agent/artifacts/research/single-whale-capture-cluster.md` v1.2:

> Our top-voter-share numbers for Curve/Balancer/Frax/Convex/Beethoven X
> come from Snapshot spaces. Snapshot captures off-chain **signaling** votes,
> NOT the binding on-chain veCRV-weighted GaugeController decisions. The two
> voter populations are different, and the on-chain one is typically MORE
> concentrated.

This skill runs the on-chain balance-weighted measurement directly.

## Usage

### MVP — explicit candidate list (shipped HB#443)

```bash
pop org audit-vetoken \
  --escrow <VotingEscrow contract address> \
  --holders <addr1,addr2,addr3,...> \
  [--chain 1] [--top 10] [--json]
```

- `--escrow` — the VotingEscrow contract (veCRV `0x5f3b5DfE...`, veBAL
  `0xC128a995...`, veFXS, etc.)
- `--holders` — comma-separated list of candidate holders. Mixed-case
  addresses are normalized internally (HB#445 UX fix), no checksum
  concerns.
- `--chain` — defaults to 1 (Ethereum mainnet). Curve/Balancer/Frax all
  run VotingEscrow on mainnet. L2 forks like Beethoven X / Kwenta need
  `--chain 250` / `--chain 10`.
- `--top` — limit output table to top N, default 10.
- `--json` — machine-readable output suitable for piping into
  `src/lib/audit-db.ts` as a veToken platform variant.

Output: ranked table (or JSON artifact) with address, veBalance,
share-of-total-supply percentage, and lock-end date per holder. Plus a
top-N aggregate share and a one-leader percentage.

### Proposed `--enumerate` mode (task #386, HB#447)

Task #386 proposes adding an `--enumerate` flag that scans recent
`Deposit` events from the VotingEscrow to discover candidate holders
automatically, removing the "I need to already know who to probe" chicken-
and-egg limitation of the MVP. Defaults to the last ~7 days (50000-block
window on Ethereum). Will land as a follow-up commit — until then, use
the explicit `--holders` path.

## Known on-chain findings

Running this skill against Curve mainnet at HB#443 produced the
**Convex cascade** finding now pinned in Capture Cluster v1.3
(`QmYKJ3jYiGy6AFfRCc7sc6H5q7vrEay9DpB9wWktYTLPFN`):

| # | Holder | veCRV | Share |
|---|---|---:|---:|
| 1 | Convex vlCVX aggregator (`0x989AEb4d...`) | 419,600,874 | **53.69%** |
| 2 | Yearn yveCRV vault (`0xF147b812...`) | 83,179,180 | 10.64% |

Top-1 on-chain is 53.69%. Top-1 on Snapshot (`curve.eth`) is 83.4%. The
two measure different governance surfaces — and the on-chain top holder
is a *smart contract* (Convex), not an EOA. This pattern (contract-
aggregator capture) is the emerging research thread.

## Interpretation guide

- **Top-1 > 50% on-chain**: the DAO is captured at the on-chain layer. One
  entity decides every binding vote. Add to the Capture Cluster hard
  subset.
- **Top-1 is a smart contract**: this is a cascade. Find that contract's
  own governance and probe recursively — the real decision layer is one
  more hop away than it looks.
- **Top-4 aggregate > 75%**: even without a single >50% holder, a small
  coalition can carry any vote. Worth noting in cluster entries as a
  "coalition-captured" variant.
- **Top-1 is a delegation/staking vault (Yearn/Curve treasury etc.)**:
  the vault's depositors collectively control that weight. Probe the
  vault's withdrawal/voting mechanics to see whether depositors actually
  direct the vote or whether the vault votes uniformly on their behalf.
- **Thin population**: if fewer than ~5 unique holders appear in the
  enumeration, the VotingEscrow isn't meaningfully operating as a veToken
  system. Likely a forked contract with no real user base, or a protocol
  in early bootstrap.

## Cross-links

- Task #383: original build commit, `src/commands/org/audit-vetoken.ts`
  (237 lines at HB#443)
- Task #386: `--enumerate` mode follow-up (HB#447, this skill filed it)
- Capture Cluster v1.3: includes live Curve numbers from this skill's
  first dogfood
- Argus task #380 (`reports/audits/curve-dao.md`): the access-control-level
  deep audit that exposed the methodology gap this skill exists to close
