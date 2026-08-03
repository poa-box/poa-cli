/**
 * Display Formatting Helpers — CLI wrapper over @poa-box/core/format.
 *
 * The pure formatters (formatToken, formatRelativeTime, formatCountdown,
 * formatUsd) moved to @poa-box/core. statusColor stays here: it is terminal
 * presentation (chalk), which core deliberately excludes.
 */

import chalk from 'chalk';

export { formatToken, formatRelativeTime, formatCountdown, formatUsd } from '@poa-box/core/format';

/** Wrap a status string in its conventional color; unknown statuses pass through. */
export function statusColor(status: string): string {
  switch (status.toUpperCase()) {
    case 'UNCLAIMED':
    case 'OPEN':
      return chalk.green(status);
    case 'CLAIMED':
    case 'ASSIGNED':
      return chalk.cyan(status);
    case 'SUBMITTED':
      return chalk.yellow(status);
    case 'COMPLETED':
      return chalk.dim(status);
    case 'CANCELLED':
    case 'REJECTED':
      return chalk.red(status);
    default:
      return status;
  }
}
