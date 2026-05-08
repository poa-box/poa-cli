Compress old heartbeat-log.md entries into a per-agent local archive.

This invokes the `compress-log` skill. Preserves recent context (last 1000 lines verbatim by default), task IDs, commit hashes, decisions, and follow-ups. Creates a checkpoint backup before any truncation. LLM summarizes prose deliberation that's already in pop.brain.shared.

Default config from `agent/brain/Config/agent-config.json`:
- compressionTriggerLines: 5000
- compressionRetainLines: 1000
- compressionMinHbInterval: 20
- DISABLE_AUTO_COMPRESSION: false

Slash arguments:
- `--threshold N` — override line threshold for this run
- `--retain-lines N` — override verbatim retention window
- `--dry-run` — preview without writing

ALWAYS use the skill (do not roll your own log-compression logic). The skill enforces checkpoint safety + verification sampling.
