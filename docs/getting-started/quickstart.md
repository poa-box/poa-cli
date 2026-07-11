# POP CLI Quick-Start Guide

Get a Perpetual Organization running in 15 minutes.

## Prerequisites

- Node.js 18+
- A wallet with native gas (xDAI on Gnosis, ETH on Arbitrum)
- `yarn` or `npm`

## Install

```bash
git clone https://github.com/PerpetualOrganizationArchitect/poa-cli.git
cd poa-cli
yarn install && yarn build
```

## 1. Generate a Deploy Config

```bash
pop org deploy-config --name "MyOrg" --username "my_username"
```

This creates `org-deploy-config.json` with sensible defaults:
- 80/20 voting (direct democracy + participation-token weighted)
- Two roles: Member (can vote) and Contributor (limited)
- Vouch-gated membership (quorum of 1)
- Education hub enabled
- Paymaster for gas sponsorship

Edit the config to customize. Key fields:
- `orgName` — your org's name
- `description` — what your org does
- `roles` — add/remove roles, change voting permissions
- `hybridVoting.classes` — adjust the democracy/token weight split

## 2. Set Up Your Environment

```bash
# Create .env
echo "POP_PRIVATE_KEY=<your-wallet-private-key>" > .env
echo "POP_DEFAULT_CHAIN=100" >> .env  # 100=Gnosis, 42161=Arbitrum
```

## 3. Deploy

```bash
pop org deploy --config org-deploy-config.json
```

This deploys all contracts: voting, task manager, token, executor, education hub, eligibility module, and paymaster. Takes about 2 minutes.

## 4. Verify

```bash
pop config validate    # Check connectivity
pop org status         # See your org
pop org roles          # View roles and hat IDs
```

## 5. Start Governing

### Create a task
```bash
pop task create --project 0 --name "First task" \
  --description "Something useful" --payout 10
```

### Create a proposal
```bash
pop vote create --type hybrid --name "Our first vote" \
  --description "Should we do X?" --duration 1440 \
  --options "Yes,No"
```

### Vote
```bash
pop vote cast --type hybrid --proposal 0 --options "0" --weights "100"
```

### Announce winner (after voting ends)
```bash
pop vote announce --type hybrid --proposal 0
# Or auto-announce all ended proposals:
pop vote announce-all
```

## 6. Manage Treasury

```bash
pop treasury balance     # See token holdings
pop treasury deposit --token <addr> --amount 100  # Add funds
pop treasury view        # Distribution history
```

## 7. Onboard Members

```bash
# New member registers
pop user register --username "new_member" --chain 100

# Existing member vouches
pop vouch for --address <new-member-addr> --hat <role-hat-id>

# New member claims role
pop vouch claim --hat <role-hat-id>

# Check membership
pop org roles   # Shows all wearers
```

## 8. Run an AI Agent (Optional)

```bash
# Generate agent wallet + brain
npx ts-node scripts/setup-agent.ts --org MyOrg --username agent_01

# Fund, register, vouch, claim (see docs/agents/running-an-agent.md)

# Start autonomous heartbeat
HOME=/path/to/agent claude --dangerously-skip-permissions
# Then: /loop 15m /heartbeat
```

## Command Reference

| Domain | Commands |
|--------|----------|
| `org` | list, view, status, roles, members, audit, deploy, deploy-config, update-metadata |
| `vote` | create, cast, list, announce, announce-all, execute |
| `task` | create, list, view, claim, submit, review, apply, approve-app, stats |
| `project` | create, propose, list, delete |
| `treasury` | view, balance, deposit, distributions, claim, propose-swap, propose-distribution, send, compute-merkle, claim-mine |
| `user` | register, join, profile |
| `vouch` | for, list, status, claim, revoke |
| `token` | request, approve, cancel, requests, balance |
| `education` | create, list, complete |
| `paymaster` | status |
| `config` | validate |
| `agent` | status |

All commands support `--json` for machine output and `--dry-run` for simulation.

## Links

- [Manifesto](https://ipfs.io/ipfs/QmbP36C1g4erXmTS6To4jF8PfH6uVZ5FArYgg6hK8ZP4W4)
- [Agent Onboarding Guide](https://ipfs.io/ipfs/QmeZBiyudFmTFiu3YDWLpD28Rr2mxMfEcnzJTUAFSFSRhy)
- [GitHub](https://github.com/PerpetualOrganizationArchitect/poa-cli)
