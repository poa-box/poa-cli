import type { Argv } from 'yargs';
import { authorityHandler, subjectOption, userOption } from '../role/authority';
import { readAuthorityRows, FETCH_AUTHORITY_SUBJECTS, FETCH_AUTHORITY_MEMBERSHIPS, FETCH_AUTHORITY_VOUCHES } from '@poa-box/core/reads/authority';
import { resolveOrgId } from '../../lib/resolve';
import { subgraphModuleClient } from '../../lib/subgraph-module-client';
import * as output from '../../lib/output';

export function registerVouchCommands(y: Argv) {
  const register = (name: string, description: string, spec: Parameters<typeof authorityHandler>[0]) => {
    const handler = authorityHandler(spec); y = y.command(name, description, handler.builder, handler.handler);
  };
  for (const [name, method] of [['for', 'vouch'], ['revoke', 'revokeVouch']] as const) register(name, `${name} a role vouch through MembershipAuthority`, {
    method, options: { ...subjectOption, ...userOption }, args: a => [a.subject, a.user],
  });
  register('claim', 'Claim a role after meeting its vouch quorum', { method: 'claim', options: subjectOption, args: a => [a.subject] });
  register('configure', 'Propose a subject vouch attestor', { method: 'configureVouchAttestor', governance: true,
    options: { ...subjectOption, quorum: { type: 'number', demandOption: true, describe: 'Required vouches (0 disables the attestor)' }, 'voucher-subject': { type: 'string', demandOption: true } }, args: a => [a.subject, a.quorum, a.voucherSubject] });
  register('reset', 'Propose invalidating every vouch in the subject epoch', { method: 'resetVouchEpoch', governance: true, destructive: true,
    options: subjectOption, args: a => [a.subject] });
  register('clear-user', 'Propose clearing the received vouches of one user', { method: 'clearUserVouches', governance: true, destructive: true,
    options: { ...subjectOption, ...userOption }, args: a => [a.subject, a.user] });
  register('set-rate-limit', 'Propose the daily vouch rate limit', { method: 'setMaxDailyVouches', governance: true,
    options: { max: { type: 'number', demandOption: true } }, args: a => [a.max] });
  for (const command of ['status', 'list'] as const) y = y.command(command, `Read authority vouch ${command}`,
    b => b.option('subject', { type: 'string' }).option('user', { type: 'string' }), async (argv: any) => {
      const orgId = await resolveOrgId(argv.org, argv.chain);
      const client = subgraphModuleClient();
      const [subjects, memberships, records] = await Promise.all([
        readAuthorityRows(client, orgId, FETCH_AUTHORITY_SUBJECTS, 'subjects', argv.chain),
        readAuthorityRows(client, orgId, FETCH_AUTHORITY_MEMBERSHIPS, 'subjectMemberships', argv.chain),
        readAuthorityRows(client, orgId, FETCH_AUTHORITY_VOUCHES, 'subjectVouchRecords', argv.chain),
      ]);
      const selected = subjects.filter(s => !argv.subject || s.subjectId === argv.subject || s.id === argv.subject);
      const ids = new Set(selected.map(s => s.id));
      const users = memberships.filter(m => ids.has(m.subject.id) && (!argv.user || m.user.toLowerCase() === argv.user.toLowerCase()));
      const vouches = records.filter(v => ids.has(v.subject.id) && (!argv.user || v.user.toLowerCase() === argv.user.toLowerCase()))
        .map(v => ({ ...v, active: v.active && v.epoch === v.config?.epoch }));
      const result = { orgId, subjects: selected, memberships: users, vouches, source: 'membership-authority' };
      if (output.isJsonMode()) output.json(result);
      else output.table(['Subject', 'Role', 'Quorum', 'Voucher subject'], selected.map(s => [s.subjectId, s.name ?? '', String(s.vouchConfig?.quorum ?? 0), s.vouchConfig?.voucherSubjectId ?? '']));
    });
  return y.demandCommand(1);
}
