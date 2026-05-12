/**
 * pop org actor-footprint — quick cross-protocol on-chain footprint scan for any address.
 *
 * Codifies the methodology used across HB#1031 (ENS reverse-resolve of vlCVX/vlAURA
 * top holders) and HB#1032 (cross-token balance scan to distinguish diversified-whale
 * vs single-issue-locker profiles in the vote-escrow federation). Pattern used 3+
 * times in the cross-DAO governance research arc — third time = abstract.
 *
 * Outputs:
 *   1. ENS reverse-resolution (if any) + forward-verify
 *   2. Contract-vs-EOA classification (codeSize + nonce)
 *   3. ETH balance
 *   4. balanceOf() across a configurable list of major governance tokens
 *      (default: BAL, AURA, CRV, CVX, UNI, COMP, AAVE, ENS, LDO, MKR, stkAAVE + stables)
 *   5. Concentration verdict: which token (if any) is >80% of total USD-ish value
 *      via a simplistic equal-weight sum (rough — for narrative classification
 *      only, NOT financial accounting)
 *
 * Default targets Ethereum mainnet. Override chain via --chain. Override token
 * list via --tokens (comma-separated SYMBOL:0xaddr pairs) or --extra-tokens
 * (append to defaults).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import * as output from '../../lib/output';
import { createProvider } from '../../lib/signer';

interface ActorFootprintArgs {
  address: string;
  chain?: number;
  rpc?: string;
  json?: boolean;
  tokens?: string;
  extraTokens?: string;
  includeLocked?: boolean;
}

// Default token list for Ethereum mainnet (chainId 1). Common governance +
// liquidity tokens. Each entry: { symbol, address, decimals (auto-detected) }.
// To use a different list, pass --tokens SYM1:0x...,SYM2:0x... (replaces) or
// --extra-tokens SYM3:0x... (appends).
const DEFAULT_TOKENS_BY_CHAIN: Record<number, Array<{ symbol: string; address: string }>> = {
  1: [
    { symbol: 'BAL', address: '0xba100000625a3754423978a60c9317c58a424e3D' },
    { symbol: 'AURA', address: '0xC0c293ce456fF0ED870ADd98a0828Dd4d2903DBF' },
    { symbol: 'CRV', address: '0xD533a949740bb3306d119CC777fa900bA034cd52' },
    { symbol: 'CVX', address: '0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B' },
    { symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' },
    { symbol: 'COMP', address: '0xc00e94Cb662C3520282E6f5717214004A7f26888' },
    { symbol: 'AAVE', address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' },
    { symbol: 'ENS', address: '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72' },
    { symbol: 'LDO', address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32' },
    { symbol: 'MKR', address: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2' },
    { symbol: 'stkAAVE', address: '0x4da27a545c0c5B758a6BA100e3a049001de870f5' },
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
    { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F' },
  ],
};

// HB#1035: known locker / vote-escrow contracts. balanceOf(addr) on these
// returns the locked position. Surfacing them with --include-locked closes
// the HB#1034 limitation where c2tp.eth's 4.4M vlCVX position was invisible
// to direct balanceOf scans (locker contracts hold the actual CVX; the user's
// balanceOf on the underlying CVX shows only their unlocked position).
//
// Symbol prefix conventions:
//   vl* = vote-locked (CvxLockerV2, AuraLocker pattern — non-decaying single-period lock)
//   ve* = vote-escrowed (Curve VotingEscrow pattern — multi-year lock with linear decay)
const LOCKERS_BY_CHAIN: Record<number, Array<{ symbol: string; address: string }>> = {
  1: [
    { symbol: 'vlCVX', address: '0x72a19342e8F1838460eBFCCEf09F6585e32db86E' },
    { symbol: 'vlAURA', address: '0x3Fa73f1E5d8A792C80F426fc8F84FBF7Ce9bBCAC' },
    { symbol: 'veCRV', address: '0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2' },
    { symbol: 'veBAL', address: '0xC128a9954e6c874eA3d62ce62B468bA073093F25' },
    { symbol: 'veFXS', address: '0xc8418aF6358FFddA74e09Ca9CC3Fe03Ca6aDC5b0' },
  ],
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

function parseTokenList(raw: string): Array<{ symbol: string; address: string }> {
  return raw.split(',').map(pair => {
    const [symbol, address] = pair.trim().split(':');
    if (!symbol || !address || !ethers.utils.isAddress(address)) {
      throw new Error(`Invalid token spec: "${pair}" (expected SYMBOL:0xADDRESS)`);
    }
    return { symbol: symbol.trim(), address: address.trim() };
  });
}

export const actorFootprintHandler = {
  builder: (yargs: Argv) => yargs
    .option('address', { type: 'string', demandOption: true, describe: 'Address to probe (0x-prefixed)' })
    .option('chain', { type: 'number', default: 1, describe: 'Chain ID (default: Ethereum mainnet)' })
    .option('rpc', { type: 'string', describe: 'RPC URL override' })
    .option('tokens', { type: 'string', describe: 'Replace default token list. Comma-separated SYMBOL:0xADDRESS pairs.' })
    .option('extra-tokens', { type: 'string', describe: 'Append to default token list. Comma-separated SYMBOL:0xADDRESS pairs.' })
    .option('include-locked', { type: 'boolean', default: false, describe: 'Append known vote-locker/escrow contracts (vlCVX, vlAURA, veCRV, veBAL, veFXS on Ethereum) to surface locked positions invisible to underlying-token balanceOf.' }),

  handler: async (argv: ArgumentsCamelCase<ActorFootprintArgs>) => {
    const addr = argv.address;
    if (!ethers.utils.isAddress(addr)) {
      output.error(`Invalid address: ${addr}`);
      process.exit(1);
      return;
    }
    const normalized = ethers.utils.getAddress(addr.toLowerCase());

    const chainId = argv.chain ?? 1;
    const provider = createProvider({ chainId, rpcUrl: argv.rpc });

    let tokens: Array<{ symbol: string; address: string }>;
    if (argv.tokens) {
      tokens = parseTokenList(argv.tokens);
    } else {
      tokens = [...(DEFAULT_TOKENS_BY_CHAIN[chainId] || [])];
      if (argv.extraTokens) tokens.push(...parseTokenList(argv.extraTokens));
    }
    if (argv.includeLocked) {
      tokens.push(...(LOCKERS_BY_CHAIN[chainId] || []));
    }

    const spin = output.spinner(`Probing ${normalized.slice(0, 12)}...`);
    spin.start();

    try {
      const [code, nonce, ethBalRaw, ensName] = await Promise.all([
        provider.getCode(normalized),
        provider.getTransactionCount(normalized),
        provider.getBalance(normalized),
        provider.lookupAddress(normalized).catch(() => null),
      ]);
      const codeSize = (code.length - 2) / 2;
      const isContract = codeSize > 0;
      const ethBalance = parseFloat(ethers.utils.formatEther(ethBalRaw));

      const holdings: Array<{ symbol: string; address: string; balance: number }> = [];
      for (const t of tokens) {
        try {
          const c = new ethers.Contract(t.address, ERC20_ABI, provider);
          const [raw, dec] = await Promise.all([c.balanceOf(normalized), c.decimals()]);
          const human = parseFloat(ethers.utils.formatUnits(raw, dec));
          if (human > 0.0001) holdings.push({ symbol: t.symbol, address: t.address, balance: human });
        } catch (_e) { /* skip unreadable tokens — RPC hiccups or non-ERC20 */ }
      }

      // Rough concentration verdict: equal-weight share. NOT financial accounting.
      // Caller should not interpret as USD value. This surfaces narrative profile:
      // "all-in on token X" vs "diversified across many tokens".
      const totalNonStable = holdings
        .filter(h => !['USDC', 'USDT', 'DAI'].includes(h.symbol))
        .reduce((sum, h) => sum + h.balance, 0);
      const dominantToken = holdings
        .filter(h => !['USDC', 'USDT', 'DAI'].includes(h.symbol))
        .sort((a, b) => b.balance - a.balance)[0];
      const concentrationPct = dominantToken && totalNonStable > 0
        ? (dominantToken.balance / totalNonStable) * 100
        : 0;
      const profile = (() => {
        if (holdings.length === 0) return 'no-readable-balance';
        if (concentrationPct >= 80) return `single-token-concentrated (${dominantToken.symbol})`;
        if (holdings.filter(h => !['USDC', 'USDT', 'DAI'].includes(h.symbol)).length >= 3) return 'diversified-governance';
        return 'mixed';
      })();

      spin.stop();

      output.success(`Actor footprint for ${normalized}`, {
        address: normalized,
        chainId,
        ens: ensName,
        type: isContract ? 'CONTRACT' : 'EOA',
        codeSize,
        nonce,
        ethBalance,
        holdings,
        profile,
        concentrationPct: dominantToken ? +concentrationPct.toFixed(1) : null,
        dominantToken: dominantToken?.symbol || null,
        note: 'concentrationPct is equal-weight by token UNITS, not USD. Surfaces narrative profile only.',
      });
    } catch (err: any) {
      spin.stop();
      output.error(`Actor-footprint failed: ${err.message}`);
      process.exit(1);
    }
  },
};
