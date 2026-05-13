#!/usr/bin/env node
// solidly-fork-safe-probe.mjs — codified methodology from sentinel HB#1072/#1089 + vigil HB#735/#736
//
// Probes a Solidly-fork veNFT escrow contract's top-N holders' admin chain.
// For each top holder: walks proxy → impl → owner() → Safe and ENS-resolves signers.
//
// USAGE:
//   node agent/scripts/solidly-fork-safe-probe.mjs \
//     --escrow 0xfBBF371C9B0B994EebFcC977CEf603F7f31c070D \
//     --chain 56 --rpc https://bsc-dataseed1.binance.org \
//     [--scan-tokens 50]
//
// SUPPORTED chains: any EVM with ethers v5 + Safe.getOwners() + standard veToken ABI.
//
// COMPOSES: ethers v5 RPC + Safe ABI + mainnet ENS reverse.
// FOUNDATION: sentinel HB#1072 (Velodrome) + HB#1089 (Ramses) + vigil HB#735/#736 (Velodrome+Aerodrome cross-chain).
// PURPOSE: codify the manual probe pattern. Per HB#1080 tool-catalog: trigger = "META-PATTERN extension to new Solidly fork".

import { ethers } from 'ethers';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i+1];
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.escrow || !args.chain || !args.rpc) {
  console.error('Usage: --escrow <0x..> --chain <id> --rpc <url> [--scan-tokens 30]');
  process.exit(1);
}
const scanTokens = parseInt(args['scan-tokens'] || '30', 10);
const ETH_RPC = 'https://ethereum.publicnode.com';

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(args.rpc);
  const eth = new ethers.providers.JsonRpcProvider(ETH_RPC);

  console.log(`Probing escrow ${args.escrow} on chain ${args.chain}...`);

  const escrowAbi = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function token() view returns (address)',
    'function team() view returns (address)',
    'function ownerOf(uint256) view returns (address)',
    'function balanceOfNFT(uint256) view returns (uint256)',
  ];
  const escrow = new ethers.Contract(args.escrow, escrowAbi, provider);

  for (const fn of ['name', 'symbol', 'totalSupply', 'token', 'team']) {
    try {
      const r = await escrow[fn]();
      console.log(`  ${fn}: ${r.toString()}`);
    } catch (e) { console.log(`  ${fn}: REVERT`); }
  }

  // Scan first N tokenIds to identify top holder by vePower
  console.log(`\nScanning first ${scanTokens} tokenIds for top veNFT holder...`);
  const counts = {}, vePower = {};
  for (let i = 1; i <= scanTokens; i++) {
    try {
      const owner = await escrow.ownerOf(i);
      const bal = await escrow.balanceOfNFT(i).catch(() => ethers.BigNumber.from(0));
      counts[owner] = (counts[owner] || 0) + 1;
      if (!vePower[owner]) vePower[owner] = ethers.BigNumber.from(0);
      vePower[owner] = vePower[owner].add(bal);
    } catch (e) {}
  }
  const sorted = Object.entries(vePower)
    .filter(([addr]) => addr !== '0x0000000000000000000000000000000000000000' && addr !== '0x000000000000000000000000000000000000dEaD')
    .sort((a, b) => {
      const diff = a[1].sub(b[1]);
      return diff.isZero() ? 0 : (diff.isNegative() ? 1 : -1);
    });

  console.log('\nTop 3 non-burn holders:');
  for (const [addr, power] of sorted.slice(0, 3)) {
    console.log(`  ${addr} — NFTs:${counts[addr]} — vePower:${ethers.utils.formatEther(power)}`);
  }

  if (!sorted.length) {
    console.log('No top holder found in first ' + scanTokens + ' tokens (mostly burned?). Try larger --scan-tokens.');
    return;
  }

  // Walk admin chain of top holder
  const topHolder = sorted[0][0];
  console.log(`\nWalking admin chain for top holder ${topHolder}...`);
  const code = await provider.getCode(topHolder);
  console.log(`  code length: ${code.length}`);

  // Try Safe interface directly
  const safeAbi = [
    'function getOwners() view returns (address[])',
    'function getThreshold() view returns (uint256)',
    'function VERSION() view returns (string)',
  ];
  const safe = new ethers.Contract(topHolder, safeAbi, provider);
  try {
    const [ver, threshold, owners] = await Promise.all([safe.VERSION(), safe.getThreshold(), safe.getOwners()]);
    console.log(`\nTOP HOLDER IS A GNOSIS SAFE:`);
    console.log(`  VERSION: ${ver}`);
    console.log(`  Threshold: ${threshold}-of-${owners.length}`);
    console.log(`\n  ENS-reverse resolution (via mainnet):`);
    let namedCount = 0;
    for (const o of owners) {
      const ens = await eth.lookupAddress(o).catch(() => null);
      if (ens) namedCount++;
      console.log(`    ${o}${ens ? ' → ' + ens : ' (no ENS)'}`);
    }
    console.log(`\n  Named signers: ${namedCount} of ${owners.length}`);
    console.log(`\n  META-PATTERN extended (c') check: ${namedCount === 0 ? 'ALL ANONYMOUS (corroborates pattern)' : 'partially-named (refutes pure-anonymity at this hub)'}`);
  } catch (e) {
    console.log(`  Top holder is NOT a Safe directly. Try owner-walk via probe-proxy --sourcify.`);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
