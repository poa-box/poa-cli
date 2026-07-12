# Membership, Roles, and Vouching

How a person becomes a member of a POP org, what a "role" actually is, how roles
grant task permissions, and how the vouching system lets existing members admit
new ones without a full governance vote.

This guide is human-first. Every command below is real — see the per-command
reference for exhaustive flag lists:
[user](../reference/cli/user.md) · [role](../reference/cli/role.md) ·
[vouch](../reference/cli/vouch.md) · [task](../reference/cli/task.md).

## The mental model

- **A username** is your identity across every org. It lives on one **home
  chain** (the account registry), independent of any single org.
- **A role is a "hat"** — an on-chain NFT-style badge from the Hats protocol.
  Wearing a hat is what makes you a member and what grants you abilities.
- **Task permissions** are a separate, finer-grained layer: each hat carries a
  **bitmask** saying which task actions its wearers may perform (create, claim,
  review, …), configurable per project.
- **Vouching** is one of two ways to get a hat: existing members "vouch" for you
  until you reach a **quorum**, then you **claim** the hat yourself.

Prerequisites for anything here: Node 18+, the CLI built (`yarn build`), a
funded wallet, and `POP_DEFAULT_ORG` / `POP_DEFAULT_CHAIN` set (see
[configuration](../getting-started/configuration.md)). Most member actions are
gas-sponsored — see [gas sponsorship](./gas-sponsorship.md).

---

## 1. Register a username (once, on your home chain)

Your username is registered on the account registry's home chain, not per-org.
You only do this once, ever.

```bash
pop user register --username my_handle
```

Usernames are 3–32 characters, alphanumeric plus underscores. If the name is
taken, the command fails fast and tells you.

> Already have a username? Skip this — `pop user join` registers one for you on
> the fly if you don't.

Check your identity at any time:

```bash
pop user whoami
```

Expected output: your address, resolved username, gas balance, and standing in
the default org.

---

## 2. Join an organization

Joining runs through the org's **QuickJoin** module. It mints you the org's
base membership hat and links your username in a single transaction.

```bash
pop user join --org MyOrg
```

If you haven't registered a username yet, pass it inline and `join` will
register first, then join (two transactions):

```bash
pop user join --org MyOrg --username my_handle
```

> **Passkey/WebAuthn join variants were removed from the protocol.** There is
> one join path now — `quickJoinWithUser` via `pop user join`. Older docs or
> tutorials that mention a passkey join are out of date.

Joins are **idempotent**: run the same join twice within the cache TTL and you
get the same result back instead of a second submission. Force a fresh submit
with `--no-idempotency` if you ever need to.

---

## 3. Roles are hats — see what your org has

List every role in the org, with its **hat ID**, current wearers, and vouch
requirements:

```bash
pop org roles
```

You'll refer to these hat IDs constantly — for vouching, applications, and
permissions. Hat IDs can be given as decimals or `0x`-hex anywhere a `--hat`
flag is expected.

### Claiming extra hats

Joining grants the base membership hat. If you've been made eligible for
additional hats (for example, after being vouched for a role — see §6), claim
them:

```bash
pop user claim-hats --hats 0x0000000100020000000000000000000000000000000000000000000000000000
```

Pass several at once as a comma-separated list. Claiming a hat you're not yet
eligible for reverts — the CLI decodes that into a plain-language message.

---

## 4. Task permissions: the TaskPerm bitmask in plain language

Wearing a hat makes you a member. What that hat lets you **do with tasks** is
governed by a separate 8-bit permission mask on the TaskManager. Each ability is
one bit; a hat's mask is the sum of the bits it has been granted.

| Bit value | Permission | What it lets the wearer do |
| ---: | --- | --- |
| `1` | CREATE | Create tasks |
| `2` | CLAIM | Claim tasks (and take over expired claims) |
| `4` | REVIEW | Approve or reject others' submissions |
| `8` | ASSIGN | Assign a task directly to someone |
| `16` | SELF_REVIEW | Review your **own** submission (normally forbidden) |
| `32` | BUDGET | Edit a project's PT budget |
| `64` | EDIT_META | Edit a task's title/description after it's claimed |
| `128` | EDIT_FULL | Edit **all** task fields (payout, deadlines, bounty, …) post-claim |

Because it's a bitmask, permissions **add up**. To grant a role both REVIEW and
ASSIGN, you give it `4 + 8 = 12`.

> **Worked example — a "Reviewer" role.** A reviewer needs to approve/reject
> submissions (REVIEW = 4) and hand work to specific people (ASSIGN = 8). Its
> mask is `4 + 8 = 12`. It deliberately does **not** include CLAIM or CREATE, so
> reviewers review rather than grab work for themselves.

### Setting permissions

The CLI takes permission **names**, not raw numbers, so you never have to add
bits by hand. Names: `create, claim, review, assign, self-review, budget,
edit-meta, edit-full` (or `none` to clear an override).

Inspect the current masks (global defaults plus per-project overrides):

```bash
pop task perms show --project 0
```

Set a hat's mask **on one project** (a direct transaction; requires the
creator/organizer hat or the executor):

```bash
pop task perms set --project 0 --hat <reviewer-hat-id> --perms review,assign
```

Change a hat's **org-wide** (global) mask — this is a policy change, so it goes
through a governance vote:

```bash
pop task perms propose-global --hat <reviewer-hat-id> --perms review,assign --duration 60
```

Per-project overrides win over the global default for that project. See the
[tasks guide](./tasks.md) for how these permissions gate the task lifecycle
(including expired-claim takeover, which needs CLAIM).

---

## 5. Role applications (opt-in, no special permission needed)

Applications are a lightweight "I'd like this role" signal that an org admin can
review. They don't grant anything on their own.

```bash
# Apply for a role
pop role apply --hat <role-hat-id> --experience "3 years reviewing PRs" --notes "Happy to start part-time"

# See applications (add --mine for just yours, --hat to filter)
pop role applications --mine

# Change your mind before it's actioned
pop role withdraw-application --hat <role-hat-id>
```

Whoever administers the role then grants it — typically by making you eligible
and letting you `pop user claim-hats`, or via `pop role admin mint` (§7).

---

## 6. Vouching: peer-driven onboarding (EligibilityModule v4)

Vouching lets **existing members admit new ones** by accumulating endorsements
instead of running a full vote. This is the default membership path in most POP
orgs.

### How it works, end to end

1. An admin configures a hat for vouching: a **quorum** (how many vouches are
   needed) and a **membership hat** (whose wearers are allowed to vouch).
2. Eligible members call `pop vouch for` on the newcomer. Vouches **accumulate**
   toward the quorum.
3. Once the tally reaches quorum, the newcomer becomes *eligible* — but the hat
   is **NOT minted automatically**.
4. The newcomer **claims** the hat themselves with `pop vouch claim`
   (`claimVouchedHat` on-chain).

That last point is the one people trip on: **reaching quorum does not give you
the hat — you must claim it.**

### Rate limits and the new-member grace period

To stop a single member from rubber-stamping an army of accounts, vouching is
rate-limited:

- **Daily cap.** Each voucher can cast a limited number of vouches per UTC day
  (**3 per day by default**; an org can configure a different cap). Hit the cap
  and further vouches revert until the next UTC day.
- **New-member grace period.** A freshly joined account **cannot vouch** for
  roughly its first **2 days**. This blocks the "join and immediately vouch for
  yourself from a second wallet" attack.

Because the exact numbers are per-org, always check the **live** values rather
than trusting a hardcoded figure — see below.

### Casting and checking vouches

```bash
# Vouch for someone, by hat ID …
pop vouch for --address 0xNEWCOMER --hat <role-hat-id>

# … or by role name, which resolves to the hat
pop vouch for --address 0xNEWCOMER --role MEMBER

# Check progress toward quorum for a wearer + role, plus YOUR remaining daily quota
pop vouch status --address 0xNEWCOMER --hat <role-hat-id>

# See all active vouches in the org (optionally filter by hat)
pop vouch list --hat <role-hat-id>

# Made a mistake? Pull your vouch back
pop vouch revoke --address 0xNEWCOMER --hat <role-hat-id>
```

`pop vouch status` is the authoritative read: it reports the quorum, how many
vouches the wearer has, and your own `used/max` quota for today — so you never
have to guess the current rate limit or grace state.

### The newcomer claims the hat

Once `pop vouch status` shows quorum reached:

```bash
pop vouch claim --hat <role-hat-id>
```

### Configuring vouching (admin, superAdmin-gated)

Vouching config lives on the org's **EligibilityModule**, and every write there
is restricted to the module **superAdmin**.

```bash
# Inspect a hat's vouching config: quorum, membership hat, rate limit
pop vouch config show --hat <role-hat-id>

# Turn vouching on for a hat: require 3 vouches from wearers of the membership hat
pop vouch config set --hat <role-hat-id> --membership-hat <member-hat-id> --quorum 3

# Set --quorum 0 to DISABLE vouching for that hat
pop vouch config set --hat <role-hat-id> --membership-hat <member-hat-id> --quorum 0
```

Add `--combine-hierarchy` to also honor Hats-protocol hierarchy eligibility and
let hat admins vouch.

Destructive reset (also superAdmin-only) — clear a whole hat's vouch state, or
surgically clear just one wearer's vouches while keeping the config:

```bash
# Clear ALL accumulated vouches for a hat
pop vouch reset --hat <role-hat-id>

# Clear only one wearer's vouches (keeps the hat's config)
pop vouch reset --hat <role-hat-id> --wearer 0xSOMEONE
```

---

## 7. Role administration (superAdmin-gated)

Creating hats, minting them directly, and managing eligibility are all
**superAdmin** operations on the EligibilityModule. Regular members use
applications (§5) and vouching (§6) instead.

### Create a new role hat

```bash
pop role create --name "Reviewer" --parent-hat <parent-hat-id> --max-supply 50 --mutable
```

The new hat hangs under a parent in the org's hat tree. `--mutable` lets you
change its properties later; `--mint-to` mints it to addresses immediately.

### Manage eligibility

Eligibility controls **who is allowed to wear a hat** (distinct from the task
permissions in §4). You can set it per wearer, clear a wearer-specific rule so
the hat's default applies again, or set the hat-wide default.

```bash
# Make a specific wearer eligible + in good standing for a hat
pop role eligibility set --hat <role-hat-id> --wearer 0xSOMEONE

# Remove that wearer-specific rule (hat defaults apply again)
pop role eligibility clear --hat <role-hat-id> --wearer 0xSOMEONE

# Set the hat-wide default for everyone
pop role eligibility set-default --hat <role-hat-id> --eligible --standing
```

For bulk updates, `pop role eligibility set --file rules.json` takes a JSON
array of `{ "wearer", "eligible", "standing" }` rows.

### Direct mint and module admin

```bash
# Mint a hat straight to one or more wearers (bypasses vouching)
pop role admin mint --hat <role-hat-id> --wearer 0xA,0xB

# Pause / unpause the eligibility module
pop role admin pause
pop role admin unpause

# Seed a user's join time so the vouching grace period is computed correctly
pop role admin set-join-time --user 0xSOMEONE
```

`pop role admin transfer --to 0xNEW_ADMIN` hands over the entire module — it is
**destructive** and irreversible, so the CLI confirms before sending (bypass
with `--yes` only when you're certain).

---

## Putting it together: onboarding one new member

```bash
# 1. Newcomer registers a username (home chain) and joins the org
pop user register --username newbie
pop user join --org MyOrg

# 2. An existing member (past the grace period, with quota left) vouches
pop vouch for --address 0xNEWCOMER --role MEMBER

# 3. Track progress until quorum is reached
pop vouch status --address 0xNEWCOMER --hat <member-hat-id>

# 4. Once at quorum, the newcomer claims the role hat
pop vouch claim --hat <member-hat-id>

# 5. Confirm they now wear the hat
pop org roles
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `pop vouch for` reverts with a rate-limit message | You've hit today's daily vouch cap | Wait for the next UTC day; check `pop vouch status` for your quota |
| `pop vouch for` says the account is too new | You're inside the new-member grace period (~2 days) | Wait it out, or have an admin set your join time (`pop role admin set-join-time`) |
| `pop vouch claim` reverts | Quorum not reached yet | Check `pop vouch status`; you need more vouches |
| `pop user claim-hats` reverts | You're not eligible for that hat yet | Get vouched/minted first; confirm eligibility with `pop org roles` |
| A task action is denied by permissions | Your hat's mask lacks that bit | Have an admin `pop task perms set` the needed permission (§4) |

## Related

- [Tasks](./tasks.md) — how permissions gate the create → claim → review lifecycle
- [Voting](./voting.md) — global permission changes and role decisions go through votes
- [Treasury & tokens](./treasury-and-tokens.md) — earning participation tokens as a member
- [Gas sponsorship](./gas-sponsorship.md) — why most of these actions cost you nothing
- Reference: [user](../reference/cli/user.md) · [role](../reference/cli/role.md) · [vouch](../reference/cli/vouch.md) · [task](../reference/cli/task.md)
- [Errors & exit codes](../reference/errors-and-exit-codes.md)
