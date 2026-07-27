#!/usr/bin/env node
/**
 * Extract bare ABI arrays from forge build artifacts into src/abi/.
 *
 * Usage: node scripts/extract-abis.mjs <forge-out-dir>
 *
 * The mapping preserves the CLI's historical file names (the "New" suffix
 * predates this script). Files not listed here (ERC20.json, external/) are
 * hand-maintained and left untouched.
 *
 * Prints a signature-level diff (added/removed functions, events, errors)
 * per file so ABI-sync PRs are reviewable at a glance.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/extract-abis.mjs <forge-out-dir>');
  process.exit(1);
}

const abiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'abi');

/** forge contract name -> src/abi file base name */
const MAPPING = {
  TaskManager: 'TaskManagerNew',
  QuickJoin: 'QuickJoinNew',
  EligibilityModule: 'EligibilityModuleNew',
  HybridVoting: 'HybridVotingNew',
  DirectDemocracyVoting: 'DirectDemocracyVotingNew',
  EducationHub: 'EducationHubNew',
  OrgDeployer: 'OrgDeployerNew',
  Executor: 'Executor',
  OrgRegistry: 'OrgRegistry',
  ParticipationToken: 'ParticipationToken',
  PaymasterHub: 'PaymasterHub',
  PaymentManager: 'PaymentManager',
  PoaManager: 'PoaManager',
  UniversalAccountRegistry: 'UniversalAccountRegistry',
  ImplementationRegistry: 'ImplementationRegistry',
  ToggleModule: 'ToggleModule',
  PasskeyAccount: 'PasskeyAccount',
  PasskeyAccountFactory: 'PasskeyAccountFactory',
};

/**
 * Events/errors declared in library contracts don't appear in the consuming
 * contract's forge artifact, but ARE emitted from its address at runtime.
 * The CLI parses receipt logs (e.g. HybridVoting's NewProposal/Winner) and
 * decodes custom errors through these ABIs, so merge the companion library
 * definitions in. Deduped by signature; functions are never merged.
 */
const MERGE_COMPANIONS = {
  HybridVoting: ['HybridVotingCore', 'HybridVotingProposals', 'HybridVotingConfig', 'VotingErrors', 'VotingMath'],
  DirectDemocracyVoting: ['VotingErrors', 'VotingMath'],
  TaskManager: ['TaskPerm', 'BudgetLib', 'ValidationLib', 'HatManager'],
  PaymasterHub: ['PaymasterHubErrors', 'PaymasterGraceLib', 'PaymasterPostOpLib', 'PaymasterCalldataLib'],
  EligibilityModule: ['ValidationLib', 'HatManager'],
  EducationHub: ['ValidationLib', 'HatManager'],
  ParticipationToken: ['ValidationLib', 'HatManager'],
  QuickJoin: ['ValidationLib'],
  Executor: ['ValidationLib', 'HatManager'],
  OrgDeployer: ['ModuleDeploymentLib', 'BeaconDeploymentLib', 'ModuleTypes', 'RoleResolver'],
};

function itemSignature(item) {
  const inputs = (item.inputs || []).map((i) => i.type).join(',');
  return `${item.type} ${item.name}(${inputs})`;
}

function mergeCompanionAbi(abi, contract, outDirPath) {
  const companions = MERGE_COMPANIONS[contract] || [];
  if (!companions.length) return abi;
  const seen = new Set(abi.filter((i) => i.type && i.name).map(itemSignature));
  const merged = [...abi];
  for (const lib of companions) {
    const libArtifact = join(outDirPath, `${lib}.sol`, `${lib}.json`);
    if (!existsSync(libArtifact)) continue;
    const libAbi = JSON.parse(readFileSync(libArtifact, 'utf-8')).abi || [];
    for (const item of libAbi) {
      if (item.type !== 'event' && item.type !== 'error') continue;
      const sig = itemSignature(item);
      if (seen.has(sig)) continue;
      seen.add(sig);
      merged.push(item);
    }
  }
  return merged;
}

function signatures(abi) {
  const sigs = new Set();
  for (const item of abi) {
    if (!item.type || !item.name) continue;
    const inputs = (item.inputs || []).map((i) => i.type).join(',');
    sigs.add(`${item.type} ${item.name}(${inputs})`);
  }
  return sigs;
}

let changed = 0;
let failed = 0;

for (const [contract, fileBase] of Object.entries(MAPPING)) {
  const artifactPath = join(outDir, `${contract}.sol`, `${contract}.json`);
  if (!existsSync(artifactPath)) {
    console.error(`MISSING artifact: ${artifactPath}`);
    failed++;
    continue;
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));
  if (!Array.isArray(artifact.abi)) {
    console.error(`no .abi array in ${artifactPath}`);
    failed++;
    continue;
  }
  const abi = mergeCompanionAbi(artifact.abi, contract, outDir);

  const target = join(abiDir, `${fileBase}.json`);
  const next = JSON.stringify(abi, null, 2) + '\n';

  if (existsSync(target)) {
    const prevAbi = JSON.parse(readFileSync(target, 'utf-8'));
    const prevSigs = signatures(prevAbi);
    const nextSigs = signatures(abi);
    const added = [...nextSigs].filter((s) => !prevSigs.has(s));
    const removed = [...prevSigs].filter((s) => !nextSigs.has(s));
    if (added.length || removed.length) {
      console.log(`\n${fileBase}.json`);
      for (const s of added.sort()) console.log(`  + ${s}`);
      for (const s of removed.sort()) console.log(`  - ${s}`);
      changed++;
    } else if (readFileSync(target, 'utf-8') !== next) {
      console.log(`\n${fileBase}.json (formatting/metadata only)`);
      changed++;
    }
  } else {
    console.log(`\n${fileBase}.json (new file)`);
    changed++;
  }

  writeFileSync(target, next);
}

console.log(`\n${Object.keys(MAPPING).length} ABIs processed, ${changed} changed, ${failed} missing.`);
if (failed > 0) process.exit(1);
