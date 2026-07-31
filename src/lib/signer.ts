/**
 * Signer / Wallet Management
 * Resolves a wallet from CLI flags or environment variables.
 */

import { ethers } from 'ethers';
import { resolveNetworkConfig } from '../config/networks';

export interface SignerContext {
  signer: ethers.Wallet;
  provider: ethers.providers.JsonRpcProvider;
  address: string;
  chainId: number;
}

/**
 * Create a connected signer for the target chain.
 * Priority: --private-key flag > POP_PRIVATE_KEY env > error
 */
export function createSigner(opts: {
  privateKey?: string;
  chainId?: number;
  rpcUrl?: string;
}): SignerContext {
  // POP_READONLY=1 makes "this process cannot sign" STRUCTURAL: even with a
  // key in the environment, nothing downstream of here can broadcast. This is
  // the property an integrator sandboxing the CLI actually needs — withholding
  // the key alone also breaks identity-scoped reads (see resolveIdentityAddress).
  if (process.env.POP_READONLY === '1') {
    throw new Error(
      'POP_READONLY=1 — this process is read-only and cannot sign or broadcast. '
      + 'Unset POP_READONLY to enable write commands.'
    );
  }
  const key = opts.privateKey || process.env.POP_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      'No private key provided. Set POP_PRIVATE_KEY in .env or pass --private-key flag.'
    );
  }

  const config = resolveNetworkConfig(opts.chainId);
  const rpcUrl = opts.rpcUrl || config.resolvedRpc;
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, config.chainId);
  const signer = new ethers.Wallet(key, provider);

  return {
    signer,
    provider,
    address: signer.address,
    chainId: config.chainId,
  };
}

/**
 * Create a read-only provider (no signer needed).
 */
export function createProvider(opts: {
  chainId?: number;
  rpcUrl?: string;
}): ethers.providers.JsonRpcProvider {
  const config = resolveNetworkConfig(opts.chainId);
  const rpcUrl = opts.rpcUrl || config.resolvedRpc;
  return new ethers.providers.JsonRpcProvider(rpcUrl, config.chainId);
}


/**
 * The address this invocation OBSERVES AS, for identity-scoped reads
 * (vote list --unvoted, task list --mine, user profile, vouch status, …).
 *
 * Precedence: --address > POP_ADDRESS > derived from the private key.
 *
 * Identity-scoped reads must never REQUIRE a signing key: "show me what I
 * haven't voted on" is the most useful integrator query, and gating it on
 * POP_PRIVATE_KEY is what pushes integrations into handing a signing key to a
 * process that only needs to read. Key derivation is the fallback so existing
 * signer-configured setups keep working unchanged.
 */
export function resolveIdentityAddress(
  argv: { address?: string; privateKey?: string; 'private-key'?: string } | any,
  opts?: { required?: boolean; purpose?: string }
): string | null {
  const explicit = (argv?.address as string) || process.env.POP_ADDRESS;
  if (explicit) {
    try {
      return ethers.utils.getAddress(String(explicit).trim());
    } catch {
      throw new Error(`Invalid address "${explicit}" (from --address/POP_ADDRESS).`);
    }
  }
  const key = (argv?.privateKey as string) || (argv?.['private-key'] as string) || process.env.POP_PRIVATE_KEY;
  if (key) {
    try {
      return new ethers.Wallet(key).address;
    } catch {
      throw new Error('POP_PRIVATE_KEY is set but is not a valid private key.');
    }
  }
  if (opts?.required) {
    throw new Error(
      `${opts?.purpose ?? 'This command'} needs to know which address you are. `
      + 'Pass --address 0x…, set POP_ADDRESS, or configure POP_PRIVATE_KEY.'
    );
  }
  return null;
}
