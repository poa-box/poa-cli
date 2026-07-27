/**
 * Global --org resolution.
 *
 * Most commands fall back to POP_DEFAULT_ORG when --org is not passed. `init`
 * is deliberately excluded: it authors the config file and must act on the
 * user's explicit --org intent, never a resolved default — otherwise it would
 * silently write a stale org into a fresh .env (it offers POP_DEFAULT_ORG as an
 * editable prompt default itself when reconfiguring).
 */
export function applyDefaultOrgFallback(
  argv: { _?: Array<string | number>; org?: unknown },
  env: NodeJS.ProcessEnv = process.env
): void {
  const command = argv._?.[0];
  if (command === 'init') return;
  if (!argv.org && env.POP_DEFAULT_ORG) {
    argv.org = env.POP_DEFAULT_ORG;
  }
}
