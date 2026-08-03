# Gas Sponsorship (Free Transactions)

Most actions in a POP org — joining, voting, claiming tasks, submitting work —
can cost you **nothing**. The org pays the gas on your behalf through an
ERC-4337 paymaster. This guide explains why that works, what the experience is
for a plain member, and what an org admin has to set up to make it happen.

Reference (exhaustive flags): [paymaster](../reference/cli/paymaster.md).

---

## Why transactions can be free

Normally every transaction needs the sender to hold the chain's gas token
(xDAI on Gnosis). POP removes that requirement using **account abstraction**
(ERC-4337):

1. Your action is packaged as a **UserOperation** instead of a raw transaction.
2. A **bundler** relays it to the on-chain **EntryPoint** contract.
3. The org's **PaymasterHub** validates that you're an authorized member (by
   your hat) and that the org has budget, then **pays the gas** out of the org's
   deposit.
4. The target contract (TaskManager, HybridVoting, …) executes as usual.

The result: members transact without ever holding gas, and the org funds a
shared pool rather than airdropping dust to everyone.

```
You → UserOperation → Bundler → EntryPoint → PaymasterHub (pays gas) → Target contract
```

---

## The human experience

As a member, sponsorship is mostly invisible — you run the same commands, they
just don't draw down your own balance. Two things are worth knowing:

- **Check whether you're covered.** `pop paymaster status` shows the org's
  registration, its remaining sponsorship balance, per-hat budgets, and
  solidarity state. If a command unexpectedly asks *you* to pay, this is the
  first thing to look at.

  ```bash
  pop paymaster status
  pop paymaster status --hat <your-hat-id>   # include a specific hat's budget
  ```

- **Anyone can top up the pot.** Funding an org's gas balance is permissionless
  (and one-way — there is no withdraw):

  ```bash
  pop paymaster deposit --amount 0.05
  ```

  `--amount` is in ether units of the native gas token (`0.05` = 0.05 xDAI on
  Gnosis).

If sponsorship isn't configured for your org, transactions simply fall back to
paying from your own wallet — nothing breaks, it's just not free.

---

## Org-admin setup

Setting up sponsorship is a one-time-ish job for an org admin. There are three
moving parts: **register** the org with the PaymasterHub, **deposit** funds, and
optionally set **budgets and fee caps** so no single hat can drain the pool.

### 1. Register the org

Registration ties the org to an **admin hat** (usually the org top hat) that
will control its paymaster config, and optionally an **operator hat** allowed to
manage budgets/rules. `pop paymaster register` sends the call via the PoaManager
owner, or prints the exact registrar call for you to submit.

```bash
# Register, and fund + configure in one shot
pop paymaster register \
  --admin-hat <org-top-hat-id> \
  --operator-hat <ops-hat-id> \
  --deposit 0.1 \
  --config paymaster-config.json
```

- `--deposit` funds the org immediately after registration (permissionless
  `depositForOrg`).
- `--config` points at a JSON file of initial **fee caps** (in gwei), sponsorship
  **rules**, and **budgets** (in ether caps) — this uses
  `registerAndConfigureOrg` so registration and configuration happen together.

### 2. Fund it

Deposits are permissionless and one-way, so anyone (not just the admin) can keep
the pool healthy:

```bash
pop paymaster deposit --amount 0.1
```

### 3. Budgets, fee caps, and solidarity

`pop paymaster status` is your dashboard for the sponsorship economics:

- **Fee caps** (`maxFeePerGas` / `maxPriorityFeePerGas`, in gwei) — the ceiling
  the paymaster is willing to pay per user op, so a gas spike can't drain the
  deposit.
- **Budgets** — per-subject (per-hat) spend limits. Admin and operator hats are
  probed automatically; pass extra hats with `--hat` to include their budgets in
  the report.
- **Solidarity fund + financials** — deposited vs spent over the org's ~90-day
  period, plus shared-fund usage and whether the org is banned from solidarity.

```bash
pop paymaster status --json   # full machine-readable economics dump
```

Keep budgets and fee caps tight enough that a misbehaving or compromised hat
can't burn the whole deposit in a day.

---

## Two sponsorship paths: 4337 accounts vs EIP-7702 delegation

POP supports gas sponsorship for two kinds of accounts, and the difference
matters mostly for **agents** and power users:

| | Standard ERC-4337 | EIP-7702 delegation |
| --- | --- | --- |
| Who it's for | Smart-contract accounts | Plain EOAs (a normal private-key wallet) |
| Setup | Account is already a 4337 account | One-time on-chain **delegation** of the EOA to the delegation contract |
| How | UserOp → bundler → EntryPoint → PaymasterHub | Same pipeline, but the EOA is authorized via an EIP-7702 authorization in the UserOp |

The point of the EIP-7702 path: an ordinary wallet (like an agent's EOA) can get
its user ops sponsored **without** first migrating to a smart-contract account.
It delegates once, then transacts sponsored from then on.

For agents, that one-time delegation is a single command — `pop agent delegate`,
from the [@poa-box/agent](../../packages/agent/) package:

```bash
pop-agent agent delegate
```

After delegating, sponsored actions flow through the same PaymasterHub as
everyone else. (Agent-side sponsorship setup is covered end-to-end in
[running an agent](../../packages/agent/docs/agents/running-an-agent.md); the
`setup-sponsorship` command there wires the pieces together.)

---

## Bundler configuration

The bundler is the service that relays UserOperations to the EntryPoint. The CLI
resolves it from the environment, in this order:

1. **`POP_BUNDLER_URL`** — if set, this exact URL is used. This is how you point
   at a **self-hosted** bundler.
2. **`PIMLICO_API_KEY`** — if `POP_BUNDLER_URL` is unset, the CLI builds a
   [Pimlico](https://pimlico.io) endpoint from this key.

If neither is set, sponsored sends fail fast with a message telling you to set
one of the two.

```bash
# Hosted: just provide a Pimlico key
export PIMLICO_API_KEY=pim_xxx

# Self-hosted: point at your own bundler and Pimlico is bypassed entirely
export POP_BUNDLER_URL=http://localhost:14337/rpc
```

Because `POP_BUNDLER_URL` takes precedence and falls back to Pimlico when unset,
a common pattern is to keep a Pimlico key configured as the default and only
export `POP_BUNDLER_URL` while your local bundler is up — unset it and Pimlico
takes over automatically.

### Running your own bundler (optional)

At low volume you don't need a self-hosted bundler — a hosted one is simplest.
But self-hosting cuts cost and latency and removes a third-party dependency. The
operational essentials:

- **Any ERC-4337-compliant bundler works.** The CLI speaks standard bundler
  JSON-RPC (`eth_sendUserOperation`, `eth_estimateUserOperationGas`, …), so the
  only integration step is pointing `POP_BUNDLER_URL` at it.
- **It must support EntryPoint v0.7 and EIP-7702** if you sponsor agent EOAs
  (the 7702 path). EntryPoint v0.7 is at the canonical address
  `0x0000000071727De22E5E9d8BAf0edAc6f37da032` on Gnosis (same across chains).
- **It needs a funded relayer key.** The bundler fronts the gas to submit
  bundles on-chain; the PaymasterHub reimburses it via the EntryPoint. Keep a
  small native balance (a fraction of an xDAI covers weeks at low volume) on the
  relayer account.
- **A public RPC is fine at low volume.** Standalone bundlers run against a
  public Gnosis RPC; no local full node required. Add a dedicated endpoint only
  if you outgrow public rate limits.
- **Keep it supervised.** Run the bundler under a process manager (launchd,
  systemd, pm2) so it restarts if it crashes, and bind it to localhost.

The canonical smoke test after switching bundlers:

```bash
export POP_BUNDLER_URL=http://localhost:14337/rpc
pop config validate --json
```

Then send one **real** sponsored action (not a dry run) and confirm on the
explorer that the UserOp landed with the PaymasterHub paying gas and — for the
7702 path — that the authorization was included. If that works, the bundler is
safe to rely on.

> A deeper evaluation of self-hosted bundler options (Skandha, Voltaire, Alto,
> …), the full migration path, and a startup script live in the operator report
> at `reports/research/self-hosted-bundler-research.md`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A command asks *you* to pay gas | Org isn't registered, or its deposit is empty | `pop paymaster status`; top up with `pop paymaster deposit` |
| Sponsored send fails: "set POP_BUNDLER_URL or PIMLICO_API_KEY" | No bundler configured | Export one of the two env vars |
| Agent's sponsored tx reverts on validation | EOA never delegated (7702 path) | Run `pop-agent agent delegate` once (@poa-box/agent) |
| Specific hat can't be sponsored | That hat's budget is exhausted or unset | Check/raise it via the paymaster config; see `pop paymaster status --hat <id>` |
| Deposit "vanished" from view | Deposits are one-way and pooled per org | Confirm balance with `pop paymaster status` — there is no withdraw |

## Related

- [Running an agent](../../packages/agent/docs/agents/running-an-agent.md) — agent sponsorship + `pop agent delegate` / `setup-sponsorship`
- [Configuration](../getting-started/configuration.md) — where `POP_BUNDLER_URL` / `PIMLICO_API_KEY` live in env precedence
- [Membership, roles & vouching](./membership-roles-vouching.md) — hats are what the paymaster checks to authorize you
- Reference: [paymaster](../reference/cli/paymaster.md)
- [Errors & exit codes](../reference/errors-and-exit-codes.md)
