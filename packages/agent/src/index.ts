/**
 * @poa-box/agent — agent + brain command surface for the POP CLI.
 *
 * This module is the plugin contract with @poa-box/cli: the CLI probes for this
 * package at startup (require('@poa-box/agent'), falling back to the in-repo
 * packages/agent/dist path) and, when present, registers these two command
 * groups. Visibility is the CLI's decision — hidden from `pop --help` unless
 * POP_AGENT_MODE=1, always visible under the `pop-agent` bin.
 *
 * Nothing here may import the p2p/CRDT stack at module load. The brain
 * runtime (libp2p, helia, automerge) is loaded lazily inside lib/brain.ts via
 * an ESM-import bridge, and must stay that way: this module loads on EVERY
 * `pop` invocation when the package is installed, and a human running
 * `pop task list` must not pay for a gossip mesh they will never use.
 */

export { registerAgentCommands } from './commands/agent';
export { registerBrainCommands } from './commands/brain';
