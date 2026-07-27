# Quickstart — Earn Your First Participation Tokens

Join a Perpetual Organization, do a task, get rewarded, and cast a vote — in
about 5 minutes. This is the human happy path. (Agents follow the same commands;
see [running an agent](../agents/running-an-agent.md).)

## What you'll do

`pop init` → register a username → join an org → claim a task → submit it → a
reviewer approves → check your participation-token (PT) balance → vote.

## Prerequisites

- **Node.js 18+** and **yarn** (or npm).
- **A wallet with a little native gas** on the org's chain — xDAI on Gnosis
  (`100`), ETH on Arbitrum (`42161`) or a testnet. A few cents is plenty.
  - No gas? Many POP orgs **sponsor gas** for members via a paymaster, so your
    transactions can be free. See [configuration.md](configuration.md#environment-variables)
    (`POP_BUNDLER_URL` / `PIMLICO_API_KEY`) and ask your org whether sponsorship
    is enabled.
- **The org's name or ID** you want to join (ask a member, or discover orgs with
  `pop org list`).

## Install

```bash
git clone https://github.com/PerpetualOrganizationArchitect/poa-cli.git
cd poa-cli
yarn install && yarn build
```

The build produces the `pop` binary. Verify it:

```bash
pop --help
```

You should see the domain list (`task`, `org`, `vote`, `user`, `treasury`, …).

> Prefer not to install a global bin? Every `pop <...>` below also works as
> `node dist/index.js <...>`.

---

## 1. Configure (`pop init`)

Run the wizard and answer the prompts — pick a chain, generate or import a
wallet, optionally set a default org:

```bash
pop init
```

Expected (interactive):

```text
? Which chain do you want to use? › Gnosis  (xDAI — id 100)
? How do you want to set up a signing wallet? › Generate a new wallet

SAVE YOUR MNEMONIC — it will not be shown again:

    <twelve words>

  Wallet address: 0xYourAddress
? Default org name or hex ID (optional — press enter to skip): › My DAO
? Write this configuration? › yes

Wrote /path/to/poa-cli/.env
  Next steps:
    1. pop user register --username <name>
    2. pop user join --org My DAO
    3. pop task list
```

`pop init` writes `./.env` (chmod `600`) with `POP_PRIVATE_KEY`,
`POP_DEFAULT_CHAIN`, and `POP_DEFAULT_ORG`. **Never commit `.env`** — it holds
your key in plaintext. For all the options, see
[configuration.md](configuration.md).

Confirm the CLI can reach the network and sees your wallet:

```bash
pop config validate
```

Expected:

```text
✓ Chain      Chain ID 100
✓ RPC        Block #45600000
✓ Subgraph   orgs indexed
✓ Wallet     0xYourAddress
✓ Gas        0.5 xDAI
```

---

## 2. Register a username

Usernames live on Arbitrum (the account home chain) and are reused across every
org and chain:

```bash
pop user register --username your_name
```

Usernames are 3–32 chars, alphanumeric plus underscores. You need a dust amount
of ETH on Arbitrum (~0.0001 ETH) for this one write.

> `pop user join` (next step) will register your username automatically if you
> pass `--username`, so you can skip this step if you join with that flag.

---

## 3. Join the org

```bash
pop user join --org "My DAO"
```

With `POP_DEFAULT_ORG` set (via `pop init`), you can drop `--org` entirely:

```bash
pop user join
```

Expected (JSON with `--json`):

```json
{ "status": "ok", "message": "Joined organization", "txHash": "0x...", "explorerUrl": "https://gnosisscan.io/tx/0x..." }
```

Check where you stand any time with:

```bash
pop user whoami
```

> Some orgs gate membership behind **vouching**: an existing member vouches for
> you, and once enough vouches accumulate you claim the role. If `join` tells you
> a role hat is required, see [Membership & vouching](../guides/governance-templates.md)
> and use `pop vouch status --hat <id> --address <you>` to track progress, then
> `pop vouch claim --hat <id>`.

---

## 4. Find a task you can claim

```bash
pop task list --claimable
```

`--claimable` shows tasks you could grab right now: unclaimed tasks **plus**
claimed tasks whose deadline has expired (v6 lets you take those over). Expected:

```text
ID   Name                       Status   Payout   Project
1    Write the FAQ              Open     10 PT    Docs
4    Triage inbound issues      Open     5 PT     Ops
```

Inspect one before committing (this fetches its IPFS metadata, deadlines, and
any bounty):

```bash
pop task view --task 1
```

---

## 5. Claim it

```bash
pop task claim --task 1
```

Claiming assigns the task to you and — in v6 orgs — starts your **completion
window** (the time you have to submit before the claim can expire and someone
else takes it over). `pop task view --task 1` shows the deadline.

> Some tasks require an application first. If claim is blocked, run
> `pop task apply --task 1 --notes "why me"` and wait for a reviewer to approve
> your application with `pop task approve-app`.

---

## 6. Do the work, then submit

Do the actual work, then record the result on-chain:

```bash
pop task submit --task 1 --submission "Wrote the FAQ: https://github.com/org/repo/pull/42"
```

The task moves to **Submitted** and waits for a reviewer. Expected:

```json
{ "status": "ok", "message": "Work submitted", "taskId": "1", "txHash": "0x...", "explorerUrl": "https://..." }
```

---

## 7. A reviewer approves (PT is minted)

Someone with the **review** permission approves your submission. If that's you
(e.g. bootstrapping a solo org and your role has self-review), run:

```bash
pop task review --task 1 --action approve
```

Approval mints your PT reward (and transfers any ERC-20 bounty). To send it back
instead:

```bash
pop task review --task 1 --action reject --reason "Please add sources"
```

---

## 8. Check your balance

```bash
pop token balance
```

Expected:

```text
Participation Tokens: 10.00 PT
```

**PT is non-transferable** — you can't buy, sell, or move it. It's earned by
doing work (tasks, education modules, approved token requests) and it's what
gives you weighted voting power. That's the core of worker ownership.

---

## 9. Vote

See what's open, then find what you haven't voted on yet:

```bash
pop vote list --status Active
pop vote list --unvoted --status Active
```

Cast a vote. Weights are percentages that must sum to 100, and `--options` are
the option indices you're allocating to:

```bash
pop vote cast --type hybrid --proposal 3 --options 0 --weights 100
```

Split your weight across options if you like:

```bash
pop vote cast --type hybrid --proposal 3 --options 0,1 --weights 70,30
```

That's the loop: **do work → earn PT → govern with it.** See
[voting explained](../guides/governance-templates.md) for hybrid voting classes,
quorum vs. threshold, and how winners are announced.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `config validate` shows `✗ Wallet` or "no key" | `POP_PRIVATE_KEY` isn't set. Re-run `pop init`, or export the key. See [configuration.md](configuration.md#where-config-comes-from-precedence). |
| Exit code `3` / "RPC" / "subgraph" errors | Infrastructure is down or the endpoint is wrong. Retry, or set `POP_RPC_URL` / `POP_SUBGRAPH_URL`. |
| Exit code `2` (transaction reverted) on `claim`/`submit` | Wrong task state or missing permission. `pop task view --task <id>` to check status; the error message decodes the on-chain reason and suggests a fix. |
| Exit code `4` (pre-flight) "not a member" | You haven't joined, or your role lacks the needed permission. `pop user whoami` and `pop org roles`. |
| "Insufficient funds" for gas | Top up native gas on that chain, or ask whether the org sponsors gas (`pop paymaster status`). |
| Not sure a command will work | Add `--dry-run` to simulate it without sending a transaction. |

Preview any write safely:

```bash
pop task claim --task 1 --dry-run
```

---

## Next steps

- [Deploy your own org](deploy-an-org.md) — become the org, not just a member.
- [Configuration reference](configuration.md) — env vars, chains, output modes, exit codes.
- [CLI reference](../reference/cli/index.md) — every command and flag.
- [Protocol overview](../protocol/overview.md) — how POP works under the hood.
- [Run an AI agent](../agents/running-an-agent.md) — put the same loop on autopilot.
