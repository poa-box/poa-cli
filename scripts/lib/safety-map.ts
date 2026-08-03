/**
 * The curated safety classification for every @poa-box/cli command — the source
 * the machine-readable manifest (and `pop mcp`) derives readOnly/destructive
 * from.
 *
 * WHY CURATED: the read/write split is not recoverable from names — `vote
 * announce-all` reads like inspection but broadcasts, and several files
 * register a read AND a write subcommand. Every integrator was re-deriving
 * this by grepping for executeTx, and getting it wrong in the direction that
 * costs money. It is curated HERE, once, and drift-checked by
 * test/docs/manifest-safety.test.ts, which independently derives broadcast
 * capability from the source (executeTx / createWriteContract /
 * sendSponsored usage per command file) and fails the build on any mismatch.
 *
 * Commands absent from WRITE_COMMANDS and SIDE_EFFECT_READS are read-only
 * with no external side effects — that is the default the drift test also
 * verifies.
 */

export interface CommandSafety {
  /** Signs and broadcasts transactions (direct EOA or sponsored 4337). */
  broadcasts: boolean;
  /**
   * Hard-to-reverse even by write standards; requires an explicit --yes in
   * every non-interactive context (see confirmWrite).
   */
  destructive?: boolean;
  /**
   * External or local effects beyond the chain:
   *   'ipfs-pin'        — always publishes to IPFS (public, irreversible)
   *   'ipfs-pin(--pin)' — publishes only when --pin is passed
   *   'local-file'      — writes files on the invoking machine
   */
  sideEffects?: string[];
  /** Source file when it does not follow src/commands/<domain>/<action>.ts. */
  file?: string;
}

/** Every command that can broadcast a transaction. */
export const WRITE_COMMANDS: Record<string, CommandSafety> = {
  // ── task ──
  'task create': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'task create-batch': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'task claim': { broadcasts: true },
  // Destructive is the CONSERVATIVE reading of a two-route command: a
  // self-release is harmless and reversible, but force-releasing another
  // member's expired claim takes their task away. The manifest is per-command
  // and cannot express "sometimes", so it takes the stronger classification.
  // The handler only passes `destructive: true` to confirmWrite on the
  // third-party route, so a self-release stays frictionless under --json.
  'task unclaim': { broadcasts: true, destructive: true },
  'task submit': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'task review': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'task cancel': { broadcasts: true, destructive: true },
  'task assign': { broadcasts: true },
  'task apply': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'task approve-app': { broadcasts: true, file: 'src/commands/task/approve-application.ts' },
  'task update': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'task edit-meta': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'task perms set': { broadcasts: true, sideEffects: ['ipfs-pin'], file: 'src/commands/task/perms.ts' },
  'task perms propose-global': { broadcasts: true, file: 'src/commands/task/perms.ts' },
  'task folders set': { broadcasts: true, file: 'src/commands/task/folders.ts' },
  // ── project ──
  'project create': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'project propose': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'project delete': { broadcasts: true, destructive: true },
  // ── org ──
  'org update-metadata': { broadcasts: true, destructive: true, sideEffects: ['ipfs-pin'] },
  'org set-metadata-admin': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'org deploy': { broadcasts: true, destructive: true, sideEffects: ['ipfs-pin'] },
  // ── vote ──
  'vote create': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'vote cast': { broadcasts: true },
  'vote announce': { broadcasts: true, destructive: true },
  'vote execute': { broadcasts: true, destructive: true },
  'vote announce-all': { broadcasts: true }, // READS LIKE INSPECTION. IT BROADCASTS.
  'vote propose-quorum': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'vote propose-config': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'vote classes propose': { broadcasts: true, sideEffects: ['ipfs-pin'], file: 'src/commands/vote/classes.ts' },
  // ── user ──
  'user register': { broadcasts: true },
  'user join': { broadcasts: true },
  'user claim-hats': { broadcasts: true },
  'user update-profile': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  // ── education ──
  'education create': { broadcasts: true, sideEffects: ['ipfs-pin'], file: 'src/commands/education/create-module.ts' },
  'education update': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'education remove': { broadcasts: true, destructive: true },
  'education complete': { broadcasts: true },
  // ── vouch ──
  'vouch for': { broadcasts: true },
  'vouch revoke': { broadcasts: true },
  'vouch claim': { broadcasts: true },
  'vouch config set': { broadcasts: true, file: 'src/commands/vouch/config.ts' },
  'vouch reset': { broadcasts: true, destructive: true },
  // ── token ──
  'token request': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'token approve': { broadcasts: true, destructive: true },
  'token cancel': { broadcasts: true },
  // ── treasury ──
  'treasury deposit': { broadcasts: true, destructive: true },
  'treasury propose-swap': { broadcasts: true, destructive: true, sideEffects: ['ipfs-pin'] },
  'treasury claim': { broadcasts: true },
  'treasury opt-out': { broadcasts: true },
  'treasury opt-in': { broadcasts: true, file: 'src/commands/treasury/opt-out.ts' },
  'treasury propose-distribution': { broadcasts: true, destructive: true, sideEffects: ['ipfs-pin'] },
  'treasury claim-mine': { broadcasts: true },
  'treasury send': { broadcasts: true, destructive: true, sideEffects: ['ipfs-pin'] },
  'treasury propose-sdai': { broadcasts: true, destructive: true, sideEffects: ['ipfs-pin'] },
  'treasury propose-finalize': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  // ── paymaster ──
  'paymaster deposit': { broadcasts: true },
  'paymaster register': { broadcasts: true },
  // ── role ──
  'role apply': { broadcasts: true, sideEffects: ['ipfs-pin'] },
  'role withdraw-application': { broadcasts: true },
  'role create': { broadcasts: true },
  'role eligibility set': { broadcasts: true, file: 'src/commands/role/eligibility.ts' },
  'role eligibility clear': { broadcasts: true, file: 'src/commands/role/eligibility.ts' },
  'role eligibility set-default': { broadcasts: true, file: 'src/commands/role/eligibility.ts' },
  'role admin transfer': { broadcasts: true, destructive: true, file: 'src/commands/role/admin.ts' },
  'role admin mint': { broadcasts: true, file: 'src/commands/role/admin.ts' },
  'role admin pause': { broadcasts: true, file: 'src/commands/role/admin.ts' },
  'role admin unpause': { broadcasts: true, file: 'src/commands/role/admin.ts' },
  'role admin set-join-time': { broadcasts: true, file: 'src/commands/role/admin.ts' },
  // ── zkemail ──
  'zkemail propose-allowlist': { broadcasts: true, destructive: true, sideEffects: ['ipfs-pin'] },
};

/**
 * Read-only commands with external or local side effects — the surprising
 * ones. `--pin` makes an otherwise read-only command publish publicly and
 * irreversibly to IPFS; a manifest consumer treating readOnly as "no effects
 * whatsoever" must check sideEffects too.
 */
export const SIDE_EFFECT_READS: Record<string, CommandSafety> = {
  'org publish': { broadcasts: false, sideEffects: ['ipfs-pin'] }, // publishing IS the command
  'org audit-external': { broadcasts: false, sideEffects: ['ipfs-pin(--pin)'] },
  'org audit-all': { broadcasts: false, sideEffects: ['ipfs-pin(--pin)'] },
  'org audit-snapshot': { broadcasts: false, sideEffects: ['ipfs-pin(--pin)'] },
  'org audit-safe': { broadcasts: false, sideEffects: ['ipfs-pin(--pin)'] },
  'org audit-full': { broadcasts: false, sideEffects: ['ipfs-pin(--pin)'] },
  'org audit-governor': { broadcasts: false, sideEffects: ['ipfs-pin(--pin)'] },
  'org audit-request': { broadcasts: false, sideEffects: ['ipfs-pin(--pin)'] },
  'org leaderboard': { broadcasts: false, sideEffects: ['ipfs-pin(--pin)'] },
  'org portfolio': { broadcasts: false, sideEffects: ['ipfs-pin(--pin)'] },
  'zkemail build-allowlist': { broadcasts: false, sideEffects: ['ipfs-pin(--pin)'] },
  'org deploy-config': { broadcasts: false, destructive: true, sideEffects: ['local-file'] },
  'treasury compute-merkle': { broadcasts: false, sideEffects: ['local-file'] },
  'init': { broadcasts: false, sideEffects: ['local-file'] },
  // Runs CLI commands as child processes; with --allow-writes those children
  // can broadcast. The server itself never signs.
  'mcp serve': { broadcasts: false, sideEffects: ['spawns-cli-subprocesses'], file: 'src/commands/mcp/serve.ts' },
};

/** Merged lookup. */
export function safetyFor(fullName: string): CommandSafety | undefined {
  return WRITE_COMMANDS[fullName] ?? SIDE_EFFECT_READS[fullName];
}
