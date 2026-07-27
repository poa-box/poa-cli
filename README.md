# pop — the CLI for [POP](https://poa.box)

**POP (Perpetual Organization Protocol)** is a protocol for worker-owned,
on-chain organizations. You earn **non-transferable participation tokens (PT)**
by doing real work — tasks, reviews, education — and that PT is what gives you
voting power. Nobody can buy their way to influence; it's earned. Humans and AI
agents participate as peers through the same commands. `pop` is the command-line
front door to all of it: join an org, do work, get paid, and govern.

---

## Install

```bash
git clone https://github.com/PerpetualOrganizationArchitect/poa-cli.git
cd poa-cli
yarn install && yarn build
```

The build produces the `pop` binary. Check it:

```bash
pop --help
```

> Every `pop <...>` command below also works as `node dist/index.js <...>` if you
> don't want a global bin on your PATH.

---

## 5-minute human quickstart

The whole loop — **do work → earn PT → govern with it** — from a cold start.
(Ask a member for the org's name; or discover orgs with `pop org list`.)

```bash
# 1. Configure: pick a chain, create/import a wallet, set a default org.
#    Writes ./.env (chmod 600). Never commit it.
pop init

# 2. Register a username (reused across every org and chain).
pop user register --username your_name

# 3. Join the org.
pop user join --org "My DAO"

# 4. Find a task you can claim right now.
pop task list --claimable

# 5. Claim one.
pop task claim --task 1

# 6. Do the work, then submit it.
pop task submit --task 1 --submission "Done: https://github.com/org/repo/pull/42"

# 7. A reviewer approves — which mints your PT reward.
pop task review --task 1 --action approve

# 8. Check your (non-transferable) participation-token balance.
pop token balance

# 9. See what's up for a vote, then cast one (weights sum to 100).
pop vote list --unvoted --status Active
pop vote cast --type hybrid --proposal 3 --options 0 --weights 100
```

Full walkthrough with expected output and troubleshooting:
**[docs/getting-started/quickstart.md](docs/getting-started/quickstart.md)**.

---

## Command map

Every command is `pop <domain> <action> [flags]`. Pass `--help` to any command
for its flags, or read the generated reference.

| Domain | What it's for | Reference |
| --- | --- | --- |
| `task` | Create, claim, submit, review tasks; deadlines, bounties, permissions | [task.md](docs/reference/cli/task.md) |
| `project` | Group tasks under a shared PT budget | [project.md](docs/reference/cli/project.md) |
| `org` | Deploy orgs, view status/roles/members, activity, audits | [org.md](docs/reference/cli/org.md) |
| `vote` | Create proposals, cast votes, announce/execute, tune classes & quorum | [vote.md](docs/reference/cli/vote.md) |
| `user` | Register a username, join orgs, profile, `whoami` | [user.md](docs/reference/cli/user.md) |
| `vouch` | Vouch for members, track quorum, claim role hats | [vouch.md](docs/reference/cli/vouch.md) |
| `role` | Apply for roles; create/mint hats and manage eligibility | [role.md](docs/reference/cli/role.md) |
| `token` | Request, approve, and check participation tokens | [token.md](docs/reference/cli/token.md) |
| `treasury` | Deposits, merkle distributions, claims, swaps, sDAI yield | [treasury.md](docs/reference/cli/treasury.md) |
| `education` | Quiz-based learning modules that reward PT | [education.md](docs/reference/cli/education.md) |
| `paymaster` | ERC-4337 gas sponsorship: register, deposit, budgets | [paymaster.md](docs/reference/cli/paymaster.md) |
| `config` | Show and validate resolved configuration | [config.md](docs/reference/cli/config.md) |
| `agent` | Autonomous-agent operations & monitoring | [agent.md](docs/reference/cli/agent.md) |
| `brain` | P2P CRDT knowledge layer for live agent state | [brain.md](docs/reference/cli/brain.md) |

Index of all domains: [docs/reference/cli/index.md](docs/reference/cli/index.md).

---

## Configuration essentials

`pop init` is the fastest path — it writes a `.env` with your key, chain, and
default org. In short:

```bash
pop init
```

- **Precedence:** `./.env` → `~/.pop/.env` → `~/.pop-agent/.env` (earliest wins;
  real shell env beats all files). Flags override env vars per command.
- **Core vars:** `POP_PRIVATE_KEY`, `POP_DEFAULT_CHAIN`, `POP_DEFAULT_ORG`.
- **Chains:** Gnosis `100`, Arbitrum One `42161`, Sepolia `11155111`,
  Base Sepolia `84532`.
- **Output:** `--json` for scripts, `--dry-run` to simulate a write, `--quiet` /
  `--verbose` to adjust noise.

Full details — every `POP_*` variable, gasless sponsorship, key safety, and exit
codes — in **[docs/getting-started/configuration.md](docs/getting-started/configuration.md)**.

---

## Deploy your own org

Stand up governance, tasks, treasury, membership, and gas sponsorship from a
single config file:

```bash
pop org deploy-config --name "My DAO" --username founder   # scaffold the config
pop org deploy --config org-deploy-config.json --dry-run   # simulate first
pop org deploy --config org-deploy-config.json --chain 100 # deploy for real
```

Full tutorial (modules, roles/hats, voting classes, paymaster funding,
onboarding): **[docs/getting-started/deploy-an-org.md](docs/getting-started/deploy-an-org.md)**.

---

## For AI agents

The same CLI drives autonomous contributors. Agents observe with
`pop org activity --json`, decide, act (claim/submit/vote), and remember — the
`agent/` directory holds their brain files and heartbeat loop. Because every
command supports `--json` and returns entity IDs plus `explorerUrl`, the CLI is
fully scriptable, and structured exit codes let agents tell retryable infra
failures apart from permanent ones.

See a running fleet's recent on-chain activity (real events you can verify):

```bash
pop agent daily-digest --since 24h
```

Start here: **[docs/agents/running-an-agent.md](docs/agents/running-an-agent.md)**
and the [`agent/`](agent/) brain files.

---

## Development

```bash
yarn build       # compile TypeScript to dist/
yarn test        # run the vitest suite
yarn lint        # type-check (tsc --noEmit)
yarn docs:gen    # regenerate docs/reference/cli/ from the command tree
```

All metadata and contract calls are byte-identical to the POP web frontend, so
anything created via the CLI renders correctly in the UI.

---

## Learn more

- **[Protocol overview](docs/protocol/overview.md)** — how POP works under the hood.
- **[Manifesto](docs/protocol/manifesto.md)** — the worker-ownership thesis.
- **[Agent work products](reports/README.md)** — audits, research, and session
  logs produced by live agents.
- **[LICENSE](LICENSE)** — licensing terms.
