#!/usr/bin/env node
/**
 * pop-agent — the agent-runtime entry point.
 *
 * Identical to `pop` except the agent + brain command groups are visible in
 * help. The human `pop` binary hides them (they still execute when invoked
 * explicitly, so skills and muscle memory keep working); this bin is what an
 * agent process or its operator should run.
 *
 * Implementation: set the mode flag, then hand over to @poa/cli, whose entry
 * module runs the CLI on load. The agent/brain commands themselves are
 * registered by @poa/cli's plugin probe finding this package — see
 * `registerAgentSurface` in src/index.ts (this package).
 */
process.env.POP_AGENT_MODE = '1';

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('@poa/cli');
