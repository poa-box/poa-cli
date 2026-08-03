/**
 * Exit Codes
 * Single source of truth for process exit codes across the CLI.
 */

export const EXIT = {
  /** Success */
  OK: 0,
  /** Bad or missing input, unknown entity, generic usage error */
  USAGE: 1,
  /** Transaction reverted or gas estimation revealed a revert (existing convention) */
  TX_FAILED: 2,
  /** Infrastructure unavailable: RPC, subgraph, or IPFS (matches NetworkError/SubgraphError/IpfsError code 3) */
  INFRA: 3,
  /** Pre-flight check failed: wrong status, not a member, duplicate suspected */
  PRECONDITION: 4,
  /** User declined confirmation, or non-TTY destructive write without --yes */
  ABORTED: 5,
} as const;
