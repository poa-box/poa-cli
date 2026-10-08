import type { Argv } from 'yargs';
import {
  readAuthorityMemberships, FETCH_AUTHORITY_PENDING, FETCH_AUTHORITY_PERMS,
  FETCH_AUTHORITY_SUBJECTS, readAuthorityRows,
} from '@poa-box/core/reads/authority';
import { resolveOrgId } from '../../lib/resolve';
import { subgraphModuleClient } from '../../lib/subgraph-module-client';
import * as output from '../../lib/output';

export function subjectListHandler(kind: 'Role' | 'Group') {
  return {
    builder: (y: Argv) => y,
    handler: async (argv: any) => {
      const orgId = await resolveOrgId(argv.org, argv.chain);
      const subjects = (await readAuthorityRows(subgraphModuleClient(), orgId,
        FETCH_AUTHORITY_SUBJECTS, 'subjects', argv.chain)).filter(subject => subject.kind === kind);
      if (output.isJsonMode()) output.json({ orgId, subjects, source: 'membership-authority' });
      else output.table(['Subject', 'Name', 'Default allow', 'Manager'], subjects.map(subject => [
        subject.subjectId, subject.name ?? '', String(subject.defaultAllow), subject.managerConfig?.managerSubjectId ?? '',
      ]));
    },
  };
}

export function subjectStatusHandler(kind: 'Role' | 'Group') {
  const option = kind === 'Group' ? 'group' : 'subject';
  return {
    builder: (y: Argv) => y.option(option, { type: 'string', demandOption: true, describe: 'Authority subject ID' })
      .option('user', { type: 'string', describe: 'Filter memberships by wallet address' }),
    handler: async (argv: any) => {
      const orgId = await resolveOrgId(argv.org, argv.chain);
      const client = subgraphModuleClient();
      const [subjects, memberships, perms, pending] = await Promise.all([
        readAuthorityRows(client, orgId, FETCH_AUTHORITY_SUBJECTS, 'subjects', argv.chain),
        readAuthorityMemberships(client, orgId, argv.chain),
        readAuthorityRows(client, orgId, FETCH_AUTHORITY_PERMS, 'permRows', argv.chain),
        readAuthorityRows(client, orgId, FETCH_AUTHORITY_PENDING, 'pendingActions', argv.chain),
      ]);
      const subject = subjects.find(row => row.kind === kind && (row.subjectId === argv[option] || row.id === argv[option]));
      if (!subject) throw new Error(`${kind} ${argv[option]} not found in this organization`);
      const memberRoles = new Set(kind === 'Group' ? (subject.memberRoles ?? []).map((row: any) => row.role.id) : [subject.id]);
      const selected = memberships.filter(row => memberRoles.has(row.subject.id)
        && (!argv.user || row.user.toLowerCase() === argv.user.toLowerCase()));
      const result = {
        orgId, subject, memberships: selected,
        members: [...new Set(selected.filter(row => row.isMember).map(row => row.user.toLowerCase()))],
        permissions: perms.filter(row => row.subject.id === subject.id && row.exists),
        pendingActions: pending.filter(row => row.subject.id === subject.id && row.status === 'Pending'
          && (!argv.user || row.user.toLowerCase() === argv.user.toLowerCase())),
        source: 'membership-authority',
      };
      if (output.isJsonMode()) output.json(result);
      else {
        output.keyValueBlock(`${kind}: ${subject.name ?? subject.subjectId}`, {
          subject: subject.subjectId, members: result.members.length,
          'permission rows': result.permissions.length, 'pending actions': result.pendingActions.length,
        });
        output.table(['Wallet', 'Role', 'Accepted', 'Eligible', 'Member', 'Eligibility source'], selected.map(row => [
          row.user, row.subject.name ?? row.subject.subjectId, String(row.accepted), String(row.eligible),
          String(row.isMember), row.eligibilitySource ?? '',
        ]));
      }
    },
  };
}

export const pendingHandler = {
  builder: (y: Argv) => y
    .option('subject', { type: 'string', describe: 'Filter by authority subject ID' })
    .option('user', { type: 'string', describe: 'Filter by target wallet address' })
    .option('all', { type: 'boolean', default: false, describe: 'Include finalized, cancelled and voided actions' })
    .epilogue('Offers are accepted by the target with role claim after their review delay. Grants and removals use role finalize.'),
  handler: async (argv: any) => {
    const orgId = await resolveOrgId(argv.org, argv.chain);
    const actions = (await readAuthorityRows(subgraphModuleClient(), orgId,
      FETCH_AUTHORITY_PENDING, 'pendingActions', argv.chain)).filter(row =>
      (argv.all || row.status === 'Pending')
      && (!argv.subject || row.subject.subjectId === argv.subject || row.subject.id === argv.subject)
      && (!argv.user || row.user.toLowerCase() === argv.user.toLowerCase()));
    if (output.isJsonMode()) output.json({ orgId, pendingActions: actions, source: 'membership-authority' });
    else output.table(['Pending ID', 'Action', 'Subject', 'Target', 'Activates at', 'Status'], actions.map(row => [
      row.pendingId, row.action, row.subject.subjectId, row.user, row.activatesAt, row.status,
    ]));
  },
};
