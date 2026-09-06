import { ethers } from 'ethers';
import { AUTHORITY_KEYS, permissionWord } from '@poa-box/core/tx/authority';
import type { Argv } from 'yargs';
import { authorityHandler, subjectOption, userOption, metadataOptions } from './authority';

export function registerRoleCommands(y: Argv) {
  const register = (name: string, description: string, spec: Parameters<typeof authorityHandler>[0]) => {
    const handler = authorityHandler(spec);
    y = y.command(name, description, handler.builder, handler.handler);
  };
  register('create', 'Propose creation of an authority role', { method: 'createRole', governance: true,
    options: { ...metadataOptions, 'max-members': { type: 'number', default: 0, describe: 'Member cap (0 = unlimited)' } },
    args: a => [a.name, a.metadataHash, a.image, a.maxMembers] });
  for (const verb of ['claim', 'renounce'] as const) register(verb, `${verb} your role membership`, {
    method: verb, destructive: verb === 'renounce', options: subjectOption, args: a => [a.subject],
  });
  for (const verb of ['grant', 'offer'] as const) register(verb, `Propose a role ${verb}`, {
    method: verb, governance: true, options: { ...subjectOption, ...userOption, delegable: { type: 'boolean', default: false, describe: 'Allow delegated managers to clear this governance grant' } },
    args: a => [a.subject, a.user, a.delegable],
  });
  register('remove', 'Propose member removal', { method: 'remove', governance: true, destructive: true,
    options: { ...subjectOption, ...userOption, ban: { type: 'boolean', default: false, describe: 'Ban membership instead of attempting soft removal' } }, args: a => [a.subject, a.user, a.ban] });
  for (const [verb, method] of [['unremove', 'unremove'], ['withdraw-offer', 'withdrawOffer'], ['clear-rule', 'clearRule']] as const) register(verb, `Propose ${verb}`, {
    method, governance: true, options: { ...subjectOption, ...userOption }, args: a => [a.subject, a.user],
  });
  register('set-rule', 'Propose an explicit grant or ban rule', { method: 'setRule', governance: true,
    options: { ...subjectOption, ...userOption, kind: { choices: ['none', 'grant', 'ban'], demandOption: true }, delegable: { type: 'boolean', default: false } },
    args: a => [a.subject, a.user, ['none', 'grant', 'ban'].indexOf(a.kind), a.delegable] });
  register('set-default', 'Propose default role eligibility', { method: 'setSubjectDefault', governance: true,
    options: { ...subjectOption, allow: { type: 'boolean', demandOption: true }, force: { type: 'boolean', default: false, describe: 'Permit closing a role with accepted members' } }, args: a => [a.subject, a.allow, a.force] });
  register('rename', 'Rename an authority subject using SUBJECT_RENAME permission', { method: 'renameSubject',
    options: { ...subjectOption, ...metadataOptions }, args: a => [a.subject, a.name, a.metadataHash, a.image] });
  register('set-max-members', 'Propose the role membership cap', { method: 'setMaxMembers', governance: true,
    options: { ...subjectOption, 'max-members': { type: 'number', demandOption: true } }, args: a => [a.subject, a.maxMembers] });
  register('set-manager', 'Propose manager delegation for a subject', { method: 'setManagerConfig', governance: true,
    options: { ...subjectOption, manager: { type: 'string', demandOption: true, describe: 'Manager subject ID (0 clears delegation)' }, caps: { type: 'number', demandOption: true, describe: 'Capability mask: 1 grant/offer, 2 remove' }, delay: { type: 'number', default: 0, describe: 'Review delay in seconds' } },
    args: a => [a.subject, a.manager, a.caps, a.delay] });
  for (const [verb, method] of [['delegate-grant', 'delegatedGrant'], ['delegate-offer', 'delegatedOffer'], ['delegate-unremove', 'delegatedUnremove']] as const) register(verb, `${verb} through configured manager authority`, {
    method, options: { ...subjectOption, ...userOption }, args: a => [a.subject, a.user],
  });
  register('delegate-remove', 'Queue delegated member removal', { method: 'delegatedRemove', destructive: true,
    options: { ...subjectOption, ...userOption, ban: { type: 'boolean', default: false } }, args: a => [a.subject, a.user, a.ban] });
  for (const method of ['finalize', 'cancel'] as const) register(method, `${method} a pending delegated action`, {
    method, options: { pending: { type: 'string', demandOption: true, describe: 'Authority pending action ID' } }, args: a => [a.pending],
  });
  register('reconcile', 'Repair a lapsed membership', { method: 'reconcile(uint256,address)', options: { ...subjectOption, ...userOption }, args: a => [a.subject, a.user] });
  register('set-perm', 'Propose an authority permission row', { method: 'setPerm', governance: true,
    options: { ...subjectOption, key: { type: 'string', demandOption: true, describe: 'Semantic key name (DD_VOTE, PT_MEMBER, etc.) or bytes32 key' },
      context: { type: 'string', default: ethers.constants.HashZero, describe: 'bytes32 context (global is zero; task project context is projectId + 1)' },
      value: { type: 'string', demandOption: true, describe: 'Permission value without flag bits' }, 'inherit-global': { type: 'boolean', default: false } },
    args: a => [a.subject, AUTHORITY_KEYS[a.key as keyof typeof AUTHORITY_KEYS] ?? a.key, a.context, permissionWord(a.value, a.inheritGlobal)] });
  register('clear-perm', 'Propose clearing an authority permission row', { method: 'clearPerm', governance: true,
    options: { ...subjectOption, key: { type: 'string', demandOption: true }, context: { type: 'string', default: ethers.constants.HashZero } },
    args: a => [a.subject, AUTHORITY_KEYS[a.key as keyof typeof AUTHORITY_KEYS] ?? a.key, a.context] });
  register('set-paused', 'Propose pausing or unpausing non-governance authority writes', { method: 'setPaused', governance: true,
    options: { paused: { type: 'boolean', demandOption: true } }, args: a => [a.paused] });
  return y.demandCommand(1, 'Please specify a role action').epilogue('Role applications and EligibilityModule administration were removed. Use authority offers, claims and manager delegation.');
}
