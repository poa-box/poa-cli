# Education Modules

Education modules are on-chain learning units with a quiz. Complete one
correctly and the EducationHub **mints you participation tokens (PT)** — the
same non-transferable governance/reward token you earn from tasks. Modules are
the lowest-friction way to onboard members and reward learning.

## Prerequisites

- A deployed org with the EducationHub enabled (`educationHub.enabled: true` in
  the [deploy config](../reference/org-deploy-config.md); it's on by default).
- To **create** modules: a hat in `educationCreatorRoles`.
- To **complete** modules: a hat in `educationMemberRoles`.
- Configuration set: see [getting-started/configuration.md](../getting-started/configuration.md).

## Command map

| Command | Who | Does |
|---|---|---|
| `pop education create` | creator hat | Create a module that pays PT on completion. |
| `pop education list` | anyone | List modules. |
| `pop education complete` | member hat | Answer the quiz and claim the PT reward. |
| `pop education update` | creator hat | Change payout/metadata (read-then-merge). |
| `pop education remove` | creator hat | Permanently delete a module (destructive). |

## The answer-hash model

The key design point: **the correct answer is hashed into the module at
creation and can never be changed.** `updateModule` can re-pin the quiz text,
options, payout, and links, but not the correct answer. So:

1. `create` takes `--correct-answer <index>` (0-based). That index is baked in permanently — pick it carefully.
2. The quiz questions and answer *options* live in IPFS metadata (`--quiz`, `--answers`).
3. `complete` takes `--answer <index>`. The contract checks it against the stored answer:
   - correct → PT is minted to you and the module is marked completed for your address;
   - wrong → the transaction reverts `InvalidAnswer` (nothing is minted, nothing is spent beyond gas).
4. Each module pays out **once per account** — a second attempt reverts `AlreadyCompleted`.

Because completion is one shot per account, `complete` runs a pre-flight that
fails fast (exit `4`) if the module doesn't exist (`ModuleUnknown`) or you've
already completed it — before spending any gas. A wrong answer is only knowable
on-chain, so preview a completion with `--dry-run` if unsure.

## Create a module

Minimal module (no quiz — just an acknowledgement that pays PT):

```bash
pop education create --name "Intro to POP" --payout 5 --correct-answer 0
```

A one-question quiz where option index `1` ("4") is the correct answer:

```bash
pop education create \
  --name "Basic Math" \
  --description "Confirm you can add" \
  --payout 5 \
  --quiz '["What is 2 + 2?"]' \
  --answers '[["3","4","5"]]' \
  --correct-answer 1 \
  --link "https://example.com/lesson"
```

Notes:
- `--payout` must be `> 0` (the contract reverts `InvalidPayout` for 0).
- `--quiz` and `--answers` are JSON: a quiz is an array of question strings; answers is an array of option-arrays (one per question). If both are given, their lengths must match.
- `--correct-answer` is an integer 0–255 (uint8), **permanent**.
- Only a creator hat (or the executor) may create — otherwise the tx reverts `NotCreator`.

The command prints the new `moduleId` and the metadata `ipfsCid`.

## Complete a module

```bash
pop education list                          # find the module ID
pop education complete --module 2 --answer 1 # answer index 1, claim the PT
```

Check your new balance:

```bash
pop token balance
```

## Update a module

`update` is a read-then-merge full edit: it fetches the current module, applies
the flags you pass, re-pins metadata, and writes it back. You can change the
payout and any metadata — but **not** the correct answer.

```bash
pop education update --module 2 --payout 8
pop education update --module 2 --name "Basic Math (v2)" --quiz '["2+2 = ?"]' --answers '[["3","4"]]'
```

## Remove a module

Destructive and permanent — there is no undo:

```bash
pop education remove --module 2
```

## Full flag reference

See [reference/cli/education.md](../reference/cli/education.md) for every flag
on every subcommand.

## Related

- [guides/treasury-and-tokens.md](treasury-and-tokens.md) — what PT is and how distributions work.
- [guides/membership-roles-vouching.md](membership-roles-vouching.md) — who holds the creator/member hats.
- [reference/org-deploy-config.md](../reference/org-deploy-config.md) — enabling the hub and setting `educationCreatorRoles` / `educationMemberRoles`.
