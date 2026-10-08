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
import { fileURLToPath, pathToFileURL } from 'node:url';

const abiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'abi');

/** forge contract name -> src/abi file base name */
export const MAPPING = {
  TaskManager: 'TaskManagerNew',
  QuickJoin: 'QuickJoinNew',
  MembershipAuthority: 'MembershipAuthority',
  AuthorityRouter: 'AuthorityRouter',
  CutoverVerifier: 'CutoverVerifier',
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
  PasskeyAccount: 'PasskeyAccount',
  PasskeyAccountFactory: 'PasskeyAccountFactory',
  ZkEmailInvites: 'ZkEmailInvites',
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
  DirectDemocracyVoting: ['VotingErrors', 'VotingMath', 'ValidationLib'],
  TaskManager: ['TaskPerm', 'BudgetLib', 'ValidationLib', 'SubjectSet'],
  PaymasterHub: [
    'PaymasterHubErrors', 'PaymasterGraceLib', 'PaymasterPostOpLib', 'PaymasterCalldataLib',
    'PaymasterAdminLib', 'PaymasterFinanceLib', 'PaymasterSponsorshipLib', 'PaymasterRuleLib',
  ],
  MembershipAuthority: ['MembershipAuthorityLogic', 'MembershipAuthoritySeed'],
  EducationHub: ['ValidationLib'],
  ParticipationToken: ['ValidationLib'],
  QuickJoin: ['ValidationLib', 'WebAuthnLib'],
  Executor: ['ValidationLib'],
  OrgDeployer: ['ModuleDeploymentLib', 'BeaconDeploymentLib', 'ModuleTypes', 'RoleResolver', 'OrgAccessSeedLib'],
  OrgRegistry: ['ValidationLib'],
  UniversalAccountRegistry: ['WebAuthnLib'],
  PasskeyAccount: ['WebAuthnLib', 'P256Verifier'],
  ZkEmailInvites: ['ValidationLib', 'WebAuthnLib'],
};

/** Canonical ABI tuple types include nested components and preserve array dimensions. */
export function canonicalType(input) {
  if (!input.type.startsWith('tuple')) return input.type;
  if (!Array.isArray(input.components)) throw new Error(`tuple has no components: ${input.name || input.type}`);
  return `(${input.components.map(canonicalType).join(',')})${input.type.slice('tuple'.length)}`;
}

export function itemSignature(item) {
  const inputs = (item.inputs || []).map(canonicalType).join(',');
  return `${item.type} ${item.name}(${inputs})`;
}

/**
 * Drop duplicate fragments by SIGNATURE (type + name + input types), keeping the first.
 *
 * Note this ignores `indexed`, `outputs` and `stateMutability`: two same-signature fragments
 * that differ only in indexed-ness collapse to whichever came first. mergeCompanionAbi's own
 * `seen` set has always behaved this way, so nothing regresses — but it means a companion
 * library redeclaring an event with different indexing would be silently discarded rather
 * than reported.
 *
 * forge can emit the same error twice when it is declared in two scopes that both get inlined
 * (DirectDemocracyVoting's artifact carries LengthMismatch() twice). ethers v5 logs
 * "duplicate definition - X" to STDOUT when such an ABI is loaded into an Interface, which
 * corrupts any `--json` output the command later prints. Dedupe here so no consumer has to.
 */
export function dedupeAbi(abi) {
  const seen = new Set();
  return abi.filter((item) => {
    if (!item.type || !item.name) return true; // constructor / fallback / receive
    const sig = itemSignature(item);
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

export function mergeCompanionAbi(abi, contract, outDirPath) {
  const companions = MERGE_COMPANIONS[contract] || [];
  if (!companions.length) return abi;
  const seen = new Set(abi.filter((i) => i.type && i.name).map(itemSignature));
  const merged = [...abi];
  for (const lib of companions) {
    const libArtifact = join(outDirPath, `${lib}.sol`, `${lib}.json`);
    if (!existsSync(libArtifact)) throw new Error(`MISSING companion artifact: ${libArtifact}`);
    const libAbi = JSON.parse(readFileSync(libArtifact, 'utf-8')).abi;
    if (!Array.isArray(libAbi)) throw new Error(`no .abi array in ${libArtifact}`);
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
    sigs.add(itemSignature(item));
  }
  return sigs;
}

export function extractAbis(outDir, targetDir = abiDir) {
  let changed = 0;
  // Validate the complete input before writing anything. A failed build or a
  // missing library must not leave a partially updated set of protocol ABIs.
  const prepared = [];

  for (const [contract, fileBase] of Object.entries(MAPPING)) {
    const artifactPath = join(outDir, `${contract}.sol`, `${contract}.json`);
    if (!existsSync(artifactPath)) {
      throw new Error(`MISSING artifact: ${artifactPath}`);
    }
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));
    if (!Array.isArray(artifact.abi)) {
      throw new Error(`no .abi array in ${artifactPath}`);
    }
    const abi = dedupeAbi(mergeCompanionAbi(artifact.abi, contract, outDir));

    prepared.push({ fileBase, abi });
  }

  for (const { fileBase, abi } of prepared) {
    const target = join(targetDir, `${fileBase}.json`);
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
        console.log(`\n${fileBase}.json (fragment details/formatting changed; selectors unchanged)`);
        changed++;
      }
    } else {
      console.log(`\n${fileBase}.json (new file)`);
      changed++;
    }

    writeFileSync(target, next);
  }

  console.log(`\n${Object.keys(MAPPING).length} ABIs processed, ${changed} changed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: node scripts/extract-abis.mjs <forge-out-dir>');
    process.exitCode = 1;
  } else {
    try {
      extractAbis(outDir);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
