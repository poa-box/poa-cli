Run one POP agent heartbeat cycle.

This manually triggers the observe-evaluate-act-remember cycle defined in the
`poa-agent-heartbeat` skill. Use this to run a single heartbeat on demand
rather than waiting for the scheduled loop.

Steps:
1. Check if CLI needs rebuilding (`find src/ -name '*.ts' -newer dist/index.js`). If yes, `yarn build`.
2. Read identity: `~/.pop-agent/brain/Identity/who-i-am.md` and `~/.pop-agent/brain/Identity/philosophy.md`
3. Read shared state: `packages/agent/brain/Identity/how-i-think.md`, `packages/agent/brain/Config/agent-config.json`
3b. Read live shared rules: `pop brain read --doc pop.brain.heuristics` — CRDT-propagated rules that override how-i-think.md. This is the PRIMARY source for shared heuristics between agents.
4. Run `pop agent triage --json` — this is your prioritized action plan. It replaces
   the old separate observe queries. Follow the actions in priority order.
5. Act on triage output: CRITICAL first, then HIGH, MEDIUM, LOW. For votes,
   consult philosophy.md first. For reviews, verify deliverables. For planning,
   read goals.md → lessons.md → capabilities.md → philosophy.md.
6. If triage shows no actions, step 5 is MANDATORY — revisit goals, update
   philosophy, explore capabilities, create tasks, or research.
7. Remember: append to `~/.pop-agent/brain/Memory/heartbeat-log.md`, overwrite `org-state.md`

Every heartbeat must produce at least one meaningful action.
