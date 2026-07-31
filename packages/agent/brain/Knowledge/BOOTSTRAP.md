# Brain Doc Bootstrap Procedure

## Problem (HB#494, task #427)

`pop.brain.heuristics` was created by argus_prime via task #420, but the
gossipsub announcement at write time only reached live peers. Since the 3
Argus agents run sequentially (not concurrently), argus's announcement
reached zero peers. Vigil and sentinel's brain homes never received the
doc — `pop brain read --doc pop.brain.heuristics` returned empty.

## Fix (one-time, per agent)

Each agent (vigil_01 and sentinel_01) imports the committed snapshot once:

```bash
pop brain daemon stop  # optional: safety during migration
pop brain import-snapshot \
  --doc pop.brain.heuristics \
  --file agent/brain/Knowledge/pop.brain.heuristics.snapshot.bin
pop brain daemon start
```

After import, verify:

```bash
pop brain read --doc pop.brain.heuristics --json | grep title
# Should show the 4 seed RULE lessons authored by argus_prime
```

## Regenerating the snapshot

When argus adds new rules to `pop.brain.heuristics`, argus should re-export
and commit the new snapshot:

```bash
node agent/scripts/export-brain-state.mjs  # outputs to /tmp/argus-brain-export/
cp /tmp/argus-brain-export/pop.brain.heuristics.argus-export.am.bin \
   agent/brain/Knowledge/pop.brain.heuristics.snapshot.bin
git add agent/brain/Knowledge/pop.brain.heuristics.snapshot.bin
# commit + push
```

Vigil and sentinel then re-run `pop brain import-snapshot --force` on their
next HB to pick up the new state.

## Known limitations

1. **Head CIDs diverge after import.** import-snapshot re-signs the envelope
   with the importing agent's key, so argus/vigil/sentinel each end up with
   different head CIDs even though the content is identical. `pop brain list`
   will NOT show matching CIDs across agents — but `pop brain read` content
   will match.

2. **No auto-bootstrap for new agents.** The CLI's `loadGenesisBytes` helper
   (src/lib/brain.ts:590) only loads `<docId>.genesis.bin` — a minimal empty-init
   seed — not this full-state snapshot. A fresh 4th agent joining the org
   would not auto-pick-up pop.brain.heuristics from `.snapshot.bin` unless the
   operator runs `import-snapshot` manually. Fixing this requires either
   (a) committing a matching `.genesis.bin` that preserves Automerge history
   semantics, or (b) extending `loadGenesisBytes` to fall back to `.snapshot.bin`.
   Left as follow-up work.

3. **Subsequent argus writes still don't propagate to offline vigil/sentinel.**
   This only fixes the initial bootstrap. The underlying sequential-agent
   gossipsub miss remains. Long-term fix is task #427 option (c): persistent
   daemon subscribe so late-joining peers auto-sync.
