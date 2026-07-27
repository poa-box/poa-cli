/**
 * Typed Error Classes
 * User-friendly errors with actionable messages.
 */

export class CliError extends Error {
  constructor(
    message: string,
    public code: number = 1,
    public suggestion?: string
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class TxRevertError extends CliError {
  constructor(reason: string) {
    super(`Transaction reverted: ${reason}`, 2, 'Check that you have the required permissions and the task/project is in the expected state.');
    this.name = 'TxRevertError';
  }
}

export class NetworkError extends CliError {
  constructor(message: string) {
    super(`Network error: ${message}`, 3, 'Check your RPC URL and network connection.');
    this.name = 'NetworkError';
  }
}

export class SubgraphError extends CliError {
  constructor(message: string) {
    super(`Subgraph error: ${message}`, 3, 'Check your subgraph URL. The subgraph may be syncing or unavailable.');
    this.name = 'SubgraphError';
  }
}

export class IpfsError extends CliError {
  constructor(message: string) {
    super(`IPFS error: ${message}`, 3, 'IPFS endpoint may be temporarily unavailable. Try again in a moment.');
    this.name = 'IpfsError';
  }
}

export class PreconditionError extends CliError {
  constructor(message: string, suggestion?: string) {
    super(message, 4, suggestion);
    this.name = 'PreconditionError';
  }
}

export class AbortedError extends CliError {
  constructor(message: string = 'Aborted by user') {
    super(message, 5);
    this.name = 'AbortedError';
  }
}
