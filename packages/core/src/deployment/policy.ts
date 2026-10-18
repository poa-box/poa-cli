/** Explicit host policies. None establish currently deployed capability or lifecycle readiness. */
import { ethers } from 'ethers';
import { CliError } from '../errors';
import { EXIT } from '../exit-codes';

export interface DeployerSemVer { major: string; minor: string; patch: string; prerelease?: string; build?: string }

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseDeployerSemVer(version: unknown): DeployerSemVer | null {
  const match = typeof version === 'string' ? SEMVER.exec(version) : null;
  return match ? { major: match[1], minor: match[2], patch: match[3], prerelease: match[4], build: match[5] } : null;
}

/** Strict by default for hosts; strict:false deliberately selects the legacy CLI prefix policy. */
export function requireSupportedDeployerVersion(version: unknown, options: { strict?: boolean } = {}): void {
  const supported = options.strict === false ? typeof version === 'string' && /^2\./.test(version)
    : parseDeployerSemVer(version)?.major === '2';
  if (!supported) throw new CliError('Unsupported OrgDeployer version; authority version 2 is required', EXIT.PRECONDITION);
}

export function selectDeploymentEntrypoint(zkEmailEnabled: boolean = false): 'deployFullOrg' | 'deployFullOrgWithZkEmail' {
  if (typeof zkEmailEnabled !== 'boolean') throw new Error('zkEmailEnabled must be boolean');
  return zkEmailEnabled ? 'deployFullOrgWithZkEmail' : 'deployFullOrg';
}

/** Optional launch UI policy matching later setters; initialize itself has no 64/16-byte limits. */
export function validateParticipationTokenText(input: { name?: string; symbol?: string; policy: 'setter-compatible' }): void {
  if (input.policy !== 'setter-compatible') throw new Error('Unknown participation-token text policy');
  for (const [field, max] of [['name', 64], ['symbol', 16]] as const) {
    const value = input[field];
    if (value === undefined || value === '') continue; // OrgDeployer supplies its documented defaults.
    if (typeof value !== 'string' || ethers.utils.toUtf8Bytes(value).length > max) throw new Error(field + ' exceeds ' + max + ' UTF-8 bytes');
  }
}

/** Host passes decoded receipt/simulation fields; zero/missing is never a ready optional module. */
export function requireDeploymentModuleAddresses(modules: Readonly<Record<string, unknown>>, required: readonly string[]): void {
  for (const name of required) {
    const value = modules[name];
    if (typeof value !== 'string' || !ethers.utils.isAddress(value) || value.toLowerCase() === ethers.constants.AddressZero) {
      throw new CliError('Deployment module unavailable: ' + name, EXIT.PRECONDITION);
    }
  }
}
