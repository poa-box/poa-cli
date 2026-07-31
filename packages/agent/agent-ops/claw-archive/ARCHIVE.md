# ClawDAOBot archive (Hoodi testnet, Feb 2026)

Migrated from ClawDAOBot-owned GitHub repos at HB#201 (2026-04-14) by vigil_01
after Hudson authorized the ClawDAOBot GH_TOKEN and directed "investigate your
existing repos and migrate anything over you would like to — some of the
insight could be useful."

## Source repos

All under https://github.com/ClawDAOBot/ — kept intact there, this archive
is a local working copy of the subset that is directly relevant to our
current POP / brain-layer / cross-agent work.

- `ClawDAOBot/erc8004-poa-integration` — ERC-8004 (Trustless Agents)
  integration proposal + reference contracts for POP. Dated 2026-02-03,
  author "Claw (ClawDAOBot)". Status: Draft.
- `ClawDAOBot/clawdao-docs` — operating docs for ClawDAO, an AI-operated
  DAO on Hoodi testnet. Governance / participation / voting / treasury /
  risk assessment guides. Same operational philosophy as our current work
  ("Contribution = Ownership", "Infrastructure > Philosophy", "Agent
  Autonomy").

Not migrated (lower relevance, still accessible via `gh api repos/ClawDAOBot/<name>`):
- `ClawDAOBot/POP` — fork of PerpetualOrganizationArchitect/POP, pushed
  2026-02-03. No custom commits visible above upstream.
- `ClawDAOBot/clawdao-cli` — 75 KB shell CLI for ClawDAO smart contracts.
  Useful as a reference for shell-based contract interaction patterns
  but superseded by our current TypeScript `pop` CLI.

## What's in this directory

Top-level files (from `erc8004-poa-integration`):

- `README.claw-upstream.md` — original repo README, 6.6 KB, "why this matters"
- `PROPOSAL.md` — full integration design, 23 KB / 678 lines:
  POAAgentRegistry, POAReputationBridge, POAVouchValidator,
  EligibilityModule extension, TaskManager + QuickJoin hooks,
  4-phase rollout, 5 open questions.
- `AGENT_CONFIGURATION.md` — 12 KB, how to configure an ERC-8004 agent
  identity for POA members
- `POAAgentRegistry.sol` — 13 KB reference implementation
- `IERC8004Identity.sol`, `IERC8004Reputation.sol`, `IERC8004Validation.sol` —
  ERC-8004 interfaces used by the above

`clawdao-docs/` subdirectory (from `clawdao-docs/governance/` plus the root
README + index):

- `README.md` — "AI-operated DAO" framing
- `documentation-index.md` — top-level navigation
- `governance-guide.md` — proposal lifecycle, voting
- `participation-guide.md` — how members contribute
- `voting-guide.md` — voting mechanics + quorum
- `treasury-management.md` — treasury ops + spending
- `risk-assessment-framework.md` — 4-category risk taxonomy (governance /
  technical / financial / operational) with concrete examples

## Why this matters right now

The `erc8004-poa-integration` proposal is a complete design for exactly what
our current work is trending toward. Key alignments:

- **POAAgentRegistry auto-registration on QuickJoin** — the two-phase
  onboarding trap documented in HB#92-120 is partially solved by this:
  ERC-8004 identity becomes part of the QuickJoin atomic step.
- **POAReputationBridge task-completion → feedback** — directly feeds
  the `#361` governance health leaderboard task. Reputation is the axis
  that's missing from our current probe-access-only corpus.
- **POAVouchValidator** — task `#277` (Poa HatClaim-members cannot vouch)
  has this as its implementation shape. The vouch-as-validation pattern
  fits the ERC-8004 Validation Registry natively.
- **EligibilityModule reputation eligibility** — connects our HB#153
  EligibilityModule probing work to a concrete extension point.

The `clawdao-docs/risk-assessment-framework.md` is a direct template for
a risk taxonomy we don't currently have. Governance / technical /
financial / operational categories with example risks per category.
Worth adapting as a Sprint 12 or Sprint 13 deliverable.

## Next steps (suggestions, not claims)

- **Seed a `pop.brain.projects` entry** at `propose` stage for the
  ERC-8004 integration. Use this proposal as the brief. The 5 open
  questions at the bottom of PROPOSAL.md are natural discussion seeds.
- **File a task** to adapt `risk-assessment-framework.md` into
  `agent/brain/Knowledge/risk-framework.md` as the team's shared risk
  taxonomy. Easy 3-4 PT.
- **Read `AGENT_CONFIGURATION.md`** before the `#354` brainstorm surface
  work — it explains the ERC-8004 agent URI / registration file format
  that vigil / sentinel / argus would each produce.
- **Decide on the `erc8004-poa-integration` contracts**: are they worth
  porting into `PerpetualOrganizationArchitect/poa-cli` as the
  canonical implementation, or should they live in a separate repo?
  This is an architectural call for Hudson.

Everything in this archive is preserved verbatim from the source repos
as of HB#201 (2026-04-14). The dates in each file reflect when Claw
originally authored them on Hoodi testnet. No edits on migration.
