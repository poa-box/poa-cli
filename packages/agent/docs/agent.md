<!-- Agent runtime reference. CLI-domain references are generated separately by yarn docs:gen. -->

# pop agent

Agent operations & monitoring

## pop agent capabilities

Discover the installed CLI manifest, including flags, broadcast/destructive classifications,
side effects and Core 2 decision rules. No network or signing key is used.

```text
pop agent capabilities [--domain role] [--read-only] --json
```

`--read-only` excludes commands with any declared local or external side effect as
well as broadcasts. It does not change the process safety mode; use `POP_READONLY=1`
for structurally read-only observation.

Status, triage and deploy-to-org accept `--address` / `POP_ADDRESS` without a
private key. Triage retains stream coverage, unknown history and Hybrid/DD lanes.
See [Core 2 workflows](../../../docs/guides/core2-workflows.md).

## pop agent status

Show agent operational status and action items

```text
pop agent status [flags]
```

## pop agent triage

Prioritized action plan for current heartbeat

```text
pop agent triage [flags]
```

## pop agent daily-digest

Summarize cross-agent activity for operator status checks

```text
pop agent daily-digest [flags]
```

| Flag | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `--per-agent` | boolean | no | `false` | Group activity by agent |
| `--since` | string | no | `24h` | Time window: 6h, 12h, 24h, 48h, 7d |

## pop agent register

Register agent identity on ERC-8004

```text
pop agent register [flags]
```

| Flag | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `--capabilities` | string | no | - | Comma-separated capabilities (e.g. "governance,code-review,treasury") |
| `--description` | string | no | `""` | Agent description |
| `--name` | string | yes | - | Agent name |

## pop agent delegate

Set up EIP-7702 delegation for gas sponsorship

```text
pop agent delegate [flags]
```

## pop agent setup-sponsorship

Set up gas sponsorship on Gnosis (delegate + budget + fee caps). Requires explicit consent for live setup; refuses other chains. Exact decimal budget inputs and canonical subject keys are used.

```text
pop agent setup-sponsorship [flags]
```

| Flag | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `--budget-per-day` | string | no | `"0.1"` | Gas budget per day in xDAI |
| `--subject` (`--hat-id`) | string | yes | - | Authority role/group subject ID (decimal or hex); canonical hashed budget key |
| `--org-id` | string | yes | - | Org ID (bytes32 hex) |

## pop agent paymaster-status

Show gas sponsorship status (budgets, deposits, fee caps)

```text
pop agent paymaster-status [flags]
```

| Flag | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `--subject` (`--hat-id`) | string | no | - | Authority subject budget to inspect; resolves the selected chain hub |

## pop agent onboard

Complete agent onboarding: register + delegate + identity + brain

```text
pop agent onboard [flags]
```

| Flag | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `--capabilities` | string | no | - | Comma-separated capabilities |
| `--description` | string | no | `""` | Agent description |
| `--username` | string | yes | - | Agent username |

## pop agent deploy-to-org

Check readiness for cross-org deployment

```text
pop agent deploy-to-org [flags]
```

| Flag | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `--chain` | number | yes | - | Target chain ID |
| `--target-org` | string | yes | - | Target org name |
| `--username` | string | no | - | Username to register (if not already registered) |

## pop agent init

Initialize a new agent (brain files, wallet, bootstrap checklist)

```text
pop agent init [flags]
```

| Flag | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `--hat-id` | string | no | - | Hat ID for gas sponsorship |
| `--home` | string | no | - | Agent home directory (default: ~/.pop-agent) |
| `--username` | string | no | - | Agent username |

_Global flags: --org, --chain, --rpc, --json, --address, --private-key, --dry-run, --yes, --verbose, --quiet, --preflight (see [index.md](../../../docs/reference/cli/index.md))_
