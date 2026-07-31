#!/usr/bin/env node
/**
 * Task #391 (HB#386) — retroactive name() identity sweep across the
 * Argus governance audit corpus.
 *
 * After HB#384 discovered that the HB#362 "Gitcoin Governor Bravo" audit
 * was actually probing Uniswap Governor Bravo, and HB#385 shipped the
 * pre-probe name() identity check in pop org probe-access, this script
 * runs the equivalent check retroactively across every existing
 * agent/scripts/probe-*.json artifact to catch any other mislabels.
 *
 * For each artifact:
 *   1. Load the JSON, read the `address` and `chainId` fields
 *   2. Connect to a public RPC for that chain
 *   3. Call name() via a direct eth_call (no library dependency beyond ethers)
 *   4. Compare the filename-derived "labeled" name against the actual name()
 *   5. Print a row: filename | address | labeled | actual | match?
 *
 * Exit code: 0 if all matches are clean, 1 if any mismatch is found.
 *
 * RPC map — uses publicnode for every chain per HB#378 "llamarpc flaky"
 * finding. Fall through to null if chain is unknown.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { ethers } from 'ethers';

const CHAIN_RPC = {
  1: 'https://ethereum.publicnode.com',
  10: 'https://mainnet.optimism.io',
  42161: 'https://arb1.arbitrum.io/rpc',
  137: 'https://polygon.publicnode.com',
  100: 'https://gnosis.publicnode.com',
  8453: 'https://base.publicnode.com',
};

const NAME_IFACE = new ethers.utils.Interface([
  'function name() view returns (string)',
]);

/**
 * Derive the human-readable labeled name from a filename.
 * probe-aave-gov-v2-mainnet.json → "aave gov v2"
 * probe-curve-votingescrow-mainnet.json → "curve votingescrow"
 */
function labeledFromFilename(filename) {
  return basename(filename, '.json')
    .replace(/^probe-/, '')
    .replace(/-mainnet$/, '')
    .replace(/-ozabi$/, '')
    .replace(/-fresh$/, '')
    .replace(/-corrected$/, '')
    .replace(/-/g, ' ')
    .trim();
}

/**
 * Label aliases — some contracts identify on-chain with a token symbol
 * (GTC for Gitcoin) or a descriptive technical term (Vote-escrowed CRV
 * for Curve's veCRV) that doesn't literally contain the project's name.
 * This map says "if the filename says X, consider these on-chain names
 * to be an acceptable match." Populated from the HB#386 first-run false
 * positives. Additions should be justified with a comment.
 *
 * Canonical source of truth: src/lib/label-aliases.ts (task #395, HB#387).
 * Keep this copy in sync — the sweep is a .mjs Node script that cannot
 * import TypeScript source directly. If you add a new alias, add it in
 * BOTH places, or the probe-access --expected-name check and this sweep
 * will disagree.
 */
const LABEL_ALIASES = {
  // Gitcoin's token is GTC; Gitcoin's GovernorAlpha contract identifies
  // as "GTC Governor Alpha" on-chain. HB#386 sweep surfaced this.
  gitcoin: ['gtc'],
  // Curve's VotingEscrow contract identifies as "Vote-escrowed CRV" on-chain.
  // The label "curve votingescrow" → actual "Vote-escrowed CRV" is correct
  // but requires the CRV alias (Curve's token). HB#386 sweep.
  curve: ['crv', 'vote-escrowed'],
  // Balancer veBAL → "Vote Escrowed Balancer BPT" (HB#290 task #396).
  balancer: ['bal', 'bpt', 'vote escrowed balancer'],
  // Frax veFXS → "Vote-Escrowed FXS" (HB#290 task #396).
  frax: ['fxs', 'vote-escrowed fxs'],
  // Velodrome / Aerodrome Solidly-style veNFT (HB#290 task #396).
  velodrome: ['velo', 'venft'],
  aerodrome: ['aero', 'venft'],
};

/**
 * Best-effort match: does the actual contract name contain any word from
 * the labeled name (excluding generic words like "gov", "governor", "dao")
 * OR any aliased name from LABEL_ALIASES?
 */
function fuzzyMatch(labeled, actual) {
  if (!actual) return false;
  const actualLower = actual.toLowerCase();
  const SKIP_WORDS = new Set([
    'gov', 'governor', 'governance', 'dao', 'v1', 'v2', 'v3',
    'bravo', 'alpha', 'mainnet', 'logic', 'delegate',
    'gaugecontroller', 'votingescrow', 'chief',
  ]);
  const meaningfulWords = labeled
    .split(/\s+/)
    .filter((w) => w.length > 0 && !SKIP_WORDS.has(w.toLowerCase()));

  // Try each meaningful word + its aliases
  const candidates = [];
  for (const word of meaningfulWords) {
    candidates.push(word);
    const aliases = LABEL_ALIASES[word.toLowerCase()];
    if (aliases) candidates.push(...aliases);
  }

  if (candidates.length === 0) {
    // Fall back to the first filename word if all words were skipped
    const first = labeled.split(/\s+/)[0];
    return first ? actualLower.includes(first.toLowerCase()) : false;
  }

  return candidates.some((w) => actualLower.includes(w.toLowerCase()));
}

async function fetchContractName(rpcUrl, address) {
  try {
    const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl);
    const data = NAME_IFACE.encodeFunctionData('name', []);
    const raw = await provider.call({ to: address, data });
    if (raw && raw !== '0x') {
      const decoded = NAME_IFACE.decodeFunctionResult('name', raw);
      const result = decoded[0];
      if (typeof result === 'string' && result.trim() !== '') {
        return result;
      }
    }
  } catch {
    // name() revert or RPC failure
  }
  return null;
}

/**
 * HB#387 task #392 — index-validation mode.
 *
 * Reads agent/brain/Knowledge/audit-corpus-index.json and checks every
 * entry against live on-chain data via name(). Strict exact-match:
 * the entry's canonicalName must equal the live result, OR both must
 * be null (for contracts that don't expose name()).
 *
 * This is strictly better than the filename-fuzzy mode: no alias map
 * needed because the index file IS the source of truth.
 *
 * Mode selection (from main()):
 *   default     → index mode only (requires audit-corpus-index.json)
 *   --filename  → filename-fuzzy mode only (pre-HB#387 behavior)
 *   --both      → run both sequentially
 */
async function runIndexValidation() {
  const REPO_ROOT = new URL('../..', import.meta.url).pathname;
  const INDEX_PATH = join(REPO_ROOT, 'agent/brain/Knowledge/audit-corpus-index.json');
  let index;
  try {
    index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  } catch (err) {
    console.error(`Failed to read index at ${INDEX_PATH}: ${err.message}`);
    process.exit(2);
  }

  const entries = index.entries || [];
  console.log(`\nArgus corpus index validation — ${entries.length} entries from ${INDEX_PATH}\n`);
  console.log('─'.repeat(120));
  console.log(
    `${'LABEL'.padEnd(40)} ${'CHAIN'.padEnd(6)} ${'EXPECTED'.padEnd(30)} ${'ACTUAL'.padEnd(30)} MATCH`,
  );
  console.log('─'.repeat(120));

  let mismatchCount = 0;
  let nullOkCount = 0;
  let matchedCount = 0;

  for (const entry of entries) {
    const { address, chainId, filenameLabel, canonicalName } = entry;
    const rpc = CHAIN_RPC[chainId];
    if (!rpc) {
      console.log(`${filenameLabel.padEnd(40)} chain=${chainId} (no RPC configured)`);
      continue;
    }
    const actual = await fetchContractName(rpc, address);

    let status;
    if (canonicalName === null) {
      if (actual === null) {
        status = '✓ null-ok';
        nullOkCount++;
      } else {
        status = `✗ unexpected name: ${actual}`;
        mismatchCount++;
      }
    } else {
      if (actual === canonicalName) {
        status = '✓';
        matchedCount++;
      } else {
        status = `✗ MISMATCH`;
        mismatchCount++;
      }
    }

    const expectedDisplay = (canonicalName ?? '(null — manual verify)').slice(0, 28);
    const actualDisplay = (actual ?? '(null)').slice(0, 28);
    console.log(
      `${filenameLabel.padEnd(40)} ${String(chainId).padEnd(6)} ${expectedDisplay.padEnd(30)} ${actualDisplay.padEnd(30)} ${status}`,
    );
  }

  console.log('─'.repeat(120));
  console.log(
    `\nSummary: ${entries.length} entries | ${matchedCount} matched | ${nullOkCount} null-ok | ${mismatchCount} mismatches\n`,
  );

  if (mismatchCount > 0) {
    console.log('MISMATCHES — investigate and update the index.\n');
    return false;
  }

  console.log('CLEAN INDEX — every entry matches its live on-chain name() result.\n');
  return true;
}

async function main() {
  // HB#387: dispatch between index mode (default) and filename mode (--filename fallback).
  const args = process.argv.slice(2);
  const mode = args.includes('--filename')
    ? 'filename'
    : args.includes('--both')
      ? 'both'
      : 'index';

  if (mode === 'index') {
    const ok = await runIndexValidation();
    if (!ok) process.exit(1);
    return;
  }
  if (mode === 'both') {
    const ok = await runIndexValidation();
    if (!ok) process.exit(1);
    // Fall through to filename sweep
  }

  // Filename-fuzzy mode (pre-HB#387 behavior, fallback for when index is missing)
  const SCRIPTS_DIR = new URL('.', import.meta.url).pathname;
  const files = readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith('probe-') && f.endsWith('.json'))
    .sort();

  console.log(`\nArgus corpus identity sweep (filename mode) — ${files.length} probe artifacts\n`);
  console.log('─'.repeat(120));
  console.log(
    `${'FILE'.padEnd(48)} ${'CHAIN'.padEnd(6)} ${'ACTUAL NAME'.padEnd(35)} MATCH`,
  );
  console.log('─'.repeat(120));

  const rows = [];
  let mismatchCount = 0;
  let noNameCount = 0;

  for (const file of files) {
    const path = join(SCRIPTS_DIR, file);
    let artifact;
    try {
      artifact = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      console.log(`${file.padEnd(48)} (failed to parse JSON: ${err.message})`);
      continue;
    }
    const { address, chainId } = artifact;
    if (!address || chainId === undefined) {
      console.log(`${file.padEnd(48)} (missing address or chainId)`);
      continue;
    }
    const rpc = CHAIN_RPC[chainId];
    if (!rpc) {
      console.log(`${file.padEnd(48)} chain=${chainId} (no RPC configured)`);
      continue;
    }
    const labeled = labeledFromFilename(file);
    const actual = await fetchContractName(rpc, address);
    const match = fuzzyMatch(labeled, actual);

    let statusSymbol;
    if (actual === null) {
      statusSymbol = '— no name() —';
      noNameCount++;
    } else if (match) {
      statusSymbol = '✓';
    } else {
      statusSymbol = '✗ MISMATCH';
      mismatchCount++;
    }

    const actualDisplay = (actual ?? '(null)').slice(0, 33);
    console.log(
      `${file.padEnd(48)} ${String(chainId).padEnd(6)} ${actualDisplay.padEnd(35)} ${statusSymbol}`,
    );

    rows.push({ file, address, chainId, labeled, actual, match });
  }

  console.log('─'.repeat(120));
  console.log(
    `\nSummary: ${files.length} artifacts | ${rows.length - mismatchCount - noNameCount} matched | ` +
      `${mismatchCount} mismatches | ${noNameCount} no name() accessor\n`,
  );

  if (mismatchCount > 0) {
    console.log('MISMATCHES TO INVESTIGATE:');
    for (const r of rows) {
      if (r.actual !== null && !r.match) {
        console.log(
          `  ${r.file}: labeled as "${r.labeled}" but actual name() is "${r.actual}"`,
        );
      }
    }
    console.log('');
    process.exit(1);
  }

  console.log('CLEAN SWEEP — no mislabels detected in the 15-DAO corpus.\n');
  console.log(
    'Note: artifacts with no name() accessor (Maker Chief, Curve VE, Curve GC) ' +
      "cannot be verified this way. They need manual verification via contract source\n",
  );
}

main().catch((err) => {
  console.error('sweep failed:', err);
  process.exit(2);
});
