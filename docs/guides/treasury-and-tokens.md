# Treasury and Participation Tokens

Two different kinds of value live in a POP org, and it's important not to
conflate them:

- **Participation Tokens (PT)** — your *earned reputation and voting weight*.
  Non-transferable. Minted to you when you complete work.
- **The treasury** — the org's *actual money* (ERC-20 tokens like BREAD/WXDAI,
  plus native gas), held by the Executor and moved only through governance.

This guide covers both, and the end-to-end **distribution** flow that pays real
treasury tokens out to members in proportion to their PT.

Reference (exhaustive flags): [treasury](../reference/cli/treasury.md) ·
[token](../reference/cli/token.md).

---

## Part 1 — Participation Tokens (PT)

### PT is non-transferable, by design

You **cannot** send PT to anyone. `transfer`, `approve`, and `transferFrom` all
**revert** at the contract level — there is no market for PT and no way to buy
influence. If you try, the CLI decodes the revert to:
*"Participation tokens are non-transferable by design."*

This is the whole point: PT can only be *earned*, so voting weight tracks
contribution rather than capital.

### How you earn PT

| Source | How | Command |
| --- | --- | --- |
| Completing tasks | Finish and get a submission approved | see [tasks guide](./tasks.md) |
| Education modules | Pass a module's quiz | [education guide](./education.md) |
| Token requests | Ask members to mint you PT for off-board work | §"Token requests" below |

Check any address's balance (defaults to your signer):

```bash
pop token balance
pop token balance --address 0xSOMEONE
```

### Token requests — minting PT for work the board didn't track

Sometimes contribution happens outside the task system. A **token request** lets
a member ask for PT; approving the request **mints** it. This is a two-party
flow — requesting alone mints nothing.

```bash
# 1. A member requests PT, with a reason (pinned to IPFS)
pop token request --amount 25 --reason "Ran the community call for 6 weeks"

# 2. See what's pending (use --status all for the full history)
pop token requests

# 3. An approver approves it — this is the step that MINTS the PT
pop token approve --request 0

# Either side can cancel a still-pending request
pop token cancel --request 0
```

> `pop token approve` is the mint. Until someone approves, no PT exists for that
> request.

---

## Part 2 — The treasury

The treasury is real money. Reads are permissionless; every **movement** of
funds out of the Executor goes through a governance vote (see
[voting](./voting.md)).

### Look before you move

```bash
pop treasury view       # overview: balances + distribution history
pop treasury balance    # just the token holdings
```

Get in the habit of running these before proposing anything that spends.

### Deposit tokens into the treasury

Adding funds is permissionless — anyone can top the treasury up. Amounts are in
**human token units** (e.g. `100` = 100 whole tokens), not wei.

```bash
pop treasury deposit --token 0xTOKEN_ADDRESS --amount 100
```

### Direct sends (governed)

To pay someone straight from the Executor, `pop treasury send` creates a
governance proposal that, once passed and announced, executes the transfer.
`--token` defaults to `native` (the chain's gas token, e.g. xDAI).

```bash
# Single recipient
pop treasury send --to 0xRECIPIENT --amount 5 --duration 60

# Batch up to 8 recipients in one proposal
pop treasury send --recipients '[{"to":"0xA","amount":5},{"to":"0xB","amount":5}]' --duration 60
```

---

## Part 3 — PT-proportional distributions (the full walkthrough)

This is the flagship treasury flow: split a pot of a treasury token among
members **in proportion to their PT balance** at a checkpoint. It has five
phases — compute, propose, vote, announce, claim — plus an optional finalize to
sweep the leftovers.

```
compute-merkle → propose-distribution → vote → announce → claim / claim-mine → propose-finalize
```

### Step 1 — Compute the merkle tree

`compute-merkle` snapshots PT balances and computes each member's share of the
total, writing proofs to a file. `--amount` is the total to distribute, in
**human token units**.

```bash
pop treasury compute-merkle --amount 40 --token 0xTOKEN_ADDRESS --output merkle-distribution.json
```

### Step 2 — Propose the distribution

Turn that file into a governance proposal:

```bash
pop treasury propose-distribution --merkle-file merkle-distribution.json --duration 1440
```

### Step 3 — Vote

Members vote as with any hybrid proposal:

```bash
pop vote cast --type hybrid --proposal 0 --options 0 --weights 100
```

### Step 4 — Announce (creates the on-chain distribution)

After the vote ends, announcing executes the winning option, which creates the
claimable distribution:

```bash
pop vote announce-all
```

Confirm it's live:

```bash
pop treasury distributions --status Active
```

### Step 5 — Members claim their share

**The easy path** — auto-claim from every distribution you're owed, no proofs to
copy by hand:

```bash
pop treasury claim-mine
```

**The manual path** — claim a specific distribution with an explicit amount and
proof. Amounts are in **human token units by default** (e.g. `12.5`); reach for
`--wei` only if you're passing the raw integer leaf value:

```bash
# Amount in token units, proof read from the file compute-merkle produced
pop treasury claim --distribution 0 --amount 12.5 --proof-file merkle-distribution.json

# Same claim, but the amount is the raw wei-level integer
pop treasury claim --distribution 0 --amount 12500000000000000000 --wei --proof-file merkle-distribution.json
```

> Prefer `claim-mine`. Use `claim` only when you need to claim on behalf of a
> specific leaf, or the auto-claimer can't resolve your allocation.

### Step 6 — Finalize (return unclaimed funds)

Distributions don't stay open forever. `propose-finalize` opens a governance
proposal that, once executed, **closes the distribution and returns any
unclaimed funds to the treasury**.

```bash
pop treasury propose-finalize --distribution 0 --duration 60
```

The optional `--min-claim-blocks` sets an on-chain guard so finalize can't
execute until that many blocks have passed since the distribution's checkpoint —
a safety margin that guarantees members had a real window to claim.

### Opting out (and back in)

A member who doesn't want to be included in distributions can opt out; this
keeps their share in the pot for everyone else. It's reversible.

```bash
pop treasury opt-out
pop treasury opt-in
```

---

## Part 4 — Growing the treasury (swaps and yield)

Both of these are governed: they create a proposal, and the on-chain action
fires when it's announced.

### Swap one token for another (Curve)

Convert treasury holdings — for example BREAD → WXDAI to fund gas — through a
Curve pool:

```bash
pop treasury propose-swap \
  --from-token 0xBREAD --to-token 0xWXDAI \
  --amount 15 \
  --pool 0xCURVE_POOL --from-index 0 --to-index 1 \
  --duration 60
```

`--from-index` / `--to-index` are the token positions in the pool (check the
pool's `coins()`). `--min-out` guards against slippage and defaults to 95% of
the live pool quote.

### Earn yield on idle xDAI (sDAI)

Park idle native xDAI in sDAI to earn yield:

```bash
pop treasury propose-sdai --amount 100 --duration 60
```

When announced, the Executor deposits the xDAI into sDAI. See the
[governance templates](./governance-templates.md) for the reverse (unwrapping
WXDAI back to native xDAI for gas payouts).

---

## Human units vs wei — a quick rule

Nearly every amount flag in the treasury and token domains takes **human token
units** (`100` means 100 whole tokens). The one place raw integers show up is
`pop treasury claim`, and even there the default is human units — you must
explicitly pass `--wei` to switch. When in doubt, omit `--wei`.

## Related

- [Tasks](./tasks.md) — the main way members earn PT
- [Education](./education.md) — earn PT by passing learning modules
- [Voting](./voting.md) — every treasury *movement* is a governed proposal
- [Governance templates](./governance-templates.md) — copy-paste distribution, swap, and gas-funding patterns
- [Membership, roles & vouching](./membership-roles-vouching.md) — who can approve token requests and vote
- Reference: [treasury](../reference/cli/treasury.md) · [token](../reference/cli/token.md)
- [Errors & exit codes](../reference/errors-and-exit-codes.md)
