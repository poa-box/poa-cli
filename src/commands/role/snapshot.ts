import type { Argv } from 'yargs';
import { ethers } from 'ethers';
import { readAuthoritySnapshot, authorityAccountMembershipFacts } from '@poa-box/core/reads/authority';
import { projectMembershipLifecycle, projectPendingAction } from '@poa-box/core/authority/lifecycle';
import { projectEffectiveSubjectPermissions, projectUserPermissions } from '@poa-box/core/authority/permissions';
import { assertSourceBlock, knownFact, unknownFact } from '@poa-box/core/data/facts';
import { AUTHORITY_KEYS } from '@poa-box/core/tx/authority';
import { requireRawUint } from '@poa-box/core/amounts';
import { resolveOrgId } from '../../lib/resolve';
import { createIndexedSource } from '../../lib/indexed-source';
import * as output from '../../lib/output';
import { resolveNetworkConfig } from '../../config/networks';

/** Complete raw evidence and separately labelled projections. No RPC authorization
 * is inferred from eligibility, pending maturity or a partial indexed collection. */
export const authoritySnapshotHandler = {
  builder: (y: Argv) => y
    .option('subject', { type: 'string', describe: 'Optional authority subject ID for permission projection' })
    .option('user', { type: 'string', describe: 'Optional observed account for membership and permission projections' })
    .option('key', { type: 'string', describe: 'Semantic permission key or bytes32; defaults to each indexed key' })
    .option('context', { type: 'string', default: ethers.constants.HashZero, describe: 'Permission bytes32 context' })
    .option('block', { type: 'string', describe: 'Exact indexed block number (otherwise current indexed head)' })
    .option('page-size', { type: 'number', default: 1000, describe: 'Rows per indexed page' })
    .option('max-pages', { type: 'number', default: 100, describe: 'Maximum pages per collection; reaching the cap stays incomplete' }),
  handler: async (argv: any) => {
    const orgId = await resolveOrgId(argv.org, argv.chain);
    if (argv.user && !ethers.utils.isAddress(argv.user)) throw new Error('Invalid --user address');
    const indexed = await createIndexedSource({ chainId: resolveNetworkConfig(argv.chain).chainId, orgId,
      ...(argv.block === undefined ? {} : { block: { number: requireRawUint(argv.block, 31) } }) });
    const binding = await indexed.query<any>(indexed.source, `query AuthoritySnapshotBinding($orgId: ID!, $block: Block_height) {
      _meta(block: $block) { block { number hash } }
      organization(id: $orgId, block: $block) { id membershipAuthority { id } }
    }`, { orgId, block: indexed.source.block!.hash ? { hash: indexed.source.block!.hash } : { number: Number(indexed.source.block!.number) } });
    let observed = false;
    try {
      assertSourceBlock(binding.data?._meta?.block && { number: String(binding.data._meta.block.number), hash: binding.data._meta.block.hash ?? undefined }, indexed.source.block!);
      observed = binding.issues.length === 0 && binding.data?.organization?.id?.toLowerCase() === orgId.toLowerCase();
    } catch { /* Readiness stays unknown when org/block attribution is unavailable. */ }
    const contract = observed ? binding.data?.organization?.membershipAuthority?.id : undefined;
    if (!ethers.utils.isAddress(contract ?? '') || contract.toLowerCase() === ethers.constants.AddressZero) {
      const readiness = observed && binding.data.organization.membershipAuthority === null ? knownFact(false, binding.source)
        : unknownFact<boolean>('AUTHORITY_BINDING_UNAVAILABLE', { ...binding.source, snapshot: 'unknown', block: undefined });
      const result = { orgId, source: 'membership-authority', readiness, snapshot: null,
        coverage: { status: 'unavailable', receivedKeys: [], missingIds: ['membershipAuthority'], failedIds: [], issues: [{ code: 'AUTHORITY_UNAVAILABLE' }] },
        permissions: [], lifecycle: [], pending: [] };
      if (output.isJsonMode()) output.json(result);
      else output.keyValueBlock('Authority snapshot', { orgId, readiness: readiness.state === 'known' ? String(readiness.value) : 'unknown', coverage: 'unavailable' });
      return;
    }
    const source = { ...indexed.source, contract };
    const snapshot = await readAuthoritySnapshot({ source, query: indexed.query, pageSize: argv.pageSize, maxPages: argv.maxPages });
    const scope = { chainId: indexed.source.chainId, orgId, contract, ...(argv.user ? { account: argv.user } : {}) };
    const keys = argv.key ? [AUTHORITY_KEYS[argv.key as keyof typeof AUTHORITY_KEYS] ?? argv.key]
      : [...new Set(snapshot.data.permissions.map(row => row.permKey))];
    const memberships = argv.user ? authorityAccountMembershipFacts(snapshot, argv.user) : undefined;
    const permissions = argv.subject || argv.user ? keys.map(permKey => argv.user
      ? projectUserPermissions({ snapshot, memberships: memberships!, scope, permKey, ctx: argv.context })
      : projectEffectiveSubjectPermissions({ snapshot, scope, permKey, ctx: argv.context, subjectId: argv.subject })) : [];
    const lifecycle = snapshot.data.memberships.filter(row => (!argv.user || row.user.toLowerCase() === argv.user.toLowerCase())
      && (!argv.subject || row.subject.subjectId === argv.subject)).map(row => projectMembershipLifecycle({
        snapshot: { ...snapshot, source: { ...snapshot.source, account: row.user }, data: row }, scope: { ...scope, account: row.user },
      }));
    const pending = snapshot.data.pendingActions.filter(row => (!argv.user || row.user.toLowerCase() === argv.user.toLowerCase())
      && (!argv.subject || row.subjectId === argv.subject)).map(row => ({ pendingId: row.pendingId, ...projectPendingAction({
        pending: knownFact(row), now: Math.floor(Date.now() / 1000), paused: snapshot.data.paused,
        viewerIsExecutor: unknownFact('LIVE_EXECUTOR_CHECK_REQUIRED'), viewerIsCurrentManager: unknownFact('LIVE_MANAGER_CHECK_REQUIRED'),
        actorAuthorized: unknownFact('LIVE_MANAGER_CHECK_REQUIRED'), scope,
      }) }));
    const result = { orgId, source: 'membership-authority', snapshot, readiness: snapshot.data.ready, permissions, lifecycle, pending };
    if (output.isJsonMode()) output.json(result);
    else {
      output.keyValueBlock('Authority snapshot', { orgId, block: snapshot.source.block?.number,
        coverage: snapshot.coverage.status, subjects: snapshot.data.subjects.length, memberships: snapshot.data.memberships.length,
        issues: snapshot.coverage.issues.map(issue => issue.code).join(', ') });
      output.table(['Subject', 'Kind', 'Name', 'Accepted members'], snapshot.data.subjects.map(row => [row.subjectId, row.kind, row.name ?? '', row.memberCount]));
    }
  },
};
