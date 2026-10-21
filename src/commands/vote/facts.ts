import type { Argv } from 'yargs';
import { ethers } from 'ethers';
import { GOVERNANCE_LIMITS, CONFIG_CAPABILITIES } from '@poa-box/core/governance/capabilities';
import { deriveDirectDemocracyAuthorization } from '@poa-box/core/governance/dd-authorization';
import { knownFact, assertSourceBlock } from '@poa-box/core/data/facts';
import { requireRawUint } from '@poa-box/core/amounts';
import { readProposalBallotFacts } from '@poa-box/core/reads/vote';
import { authorityAccountActivationMemberships } from '@poa-box/core/reads/authority';
import { createIndexedSource } from '../../lib/indexed-source';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import { getAbi } from '../../lib/contracts';
import { tryAggregate } from '../../lib/multicall';
import { readRoleEvidence, completeCoverage } from '../role/evidence';
import * as output from '../../lib/output';

export const capabilitiesHandler = {
  builder: (y: Argv) => y,
  handler: async () => {
    const result = { limits: GOVERNANCE_LIMITS, configKeys: CONFIG_CAPABILITIES, bindingLane: 'hybrid',
      evidence: 'protocol-policy', deployedCapabilityVerified: false };
    if (output.isJsonMode()) output.json(result);
    else output.keyValueBlock('Governance policy', { bindingLane: 'hybrid', maxOptions: GOVERNANCE_LIMITS.maxOptions,
      maxCallsPerBatch: GOVERNANCE_LIMITS.maxCallsPerBatch, maxClasses: GOVERNANCE_LIMITS.maxClasses });
  },
};

export const ballotsHandler = {
  builder: (y: Argv) => y.option('type', { choices: ['hybrid', 'dd'], default: 'hybrid' })
    .option('proposal', { type: 'string', demandOption: true, describe: 'Exact decimal proposal ID' })
    .option('page-size', { type: 'number', default: 1000 }).option('max-pages', { type: 'number', default: 100 }),
  handler: async (argv: any) => {
    const modules = await resolveOrgModules(argv.org, argv.chain);
    const source = await createIndexedSource({ chainId: resolveNetworkConfig(argv.chain).chainId, orgId: modules.orgId,
      contract: requireModule(modules, argv.type === 'dd' ? 'ddVotingAddress' : 'hybridVotingAddress') });
    const snapshot = await readProposalBallotFacts({ source: source.source, query: source.protocolQuery, lane: argv.type,
      proposalId: requireRawUint(argv.proposal), pageSize: argv.pageSize, maxPages: argv.maxPages });
    if (output.isJsonMode()) output.json({ orgId: modules.orgId, type: argv.type, proposalId: argv.proposal, snapshot });
    else {
      output.keyValueBlock('Indexed proposal ballots', { coverage: snapshot.coverage.status, block: snapshot.source.block?.number, ballots: snapshot.data.length,
        issues: snapshot.coverage.issues.map(issue => issue.code).join(', ') });
      output.table(['ID', 'Voter', 'Options', 'Weights'], snapshot.data.map(row => [String(row.id), String(row.voter), String(row.optionIndexes), String(row.optionWeights)]));
    }
  },
};

/** Read-only DD permission + activation policy, deliberately separate from
 * existence/time/pause/already-voted/weight/execution gates. */
export const authorizationHandler = {
  builder: (y: Argv) => y.option('proposal', { type: 'string', demandOption: true, describe: 'Exact DD proposal ID' })
    .option('account', { type: 'string', demandOption: true, describe: 'Observed account; no signing key required' }),
  handler: async (argv: any) => {
    const account = ethers.utils.getAddress(argv.account), proposalId = requireRawUint(argv.proposal);
    const evidence = await readRoleEvidence(argv);
    const contract = requireModule(evidence.modules, 'ddVotingAddress');
    const scope = { ...evidence.scope, contract, account };
    const source = { ...evidence.rpcSource, contract };
    const iface = new ethers.utils.Interface(getAbi('DirectDemocracyVotingNew'));
    const subjects = evidence.snapshot.data.subjects;
    const calls = [{ method: 'membershipAuthority', args: [] }, { method: 'executor', args: [] },
      { method: 'proposalCreatedAt', args: [proposalId] }, { method: 'pollRestricted', args: [proposalId] },
      ...subjects.map(row => ({ method: 'pollHatAllowed', args: [proposalId, row.subjectId] }))];
    const results = await tryAggregate(evidence.provider, calls.map(call => ({ to: contract, data: iface.encodeFunctionData(call.method, call.args) })),
      { blockTag: Number(evidence.freshness.block.number) });
    const values = results.map((row, i) => {
      if (!row.success) throw new Error('DD_AUTHORIZATION_READ_UNAVAILABLE');
      return iface.decodeFunctionResult(calls[i].method, row.returnData)[0];
    });
    const binding = await evidence.indexed.protocolQuery(`query DDBinding($orgId: ID!, $block: Block_height) {
      _meta(block: $block) { block { number hash } }
      organization(id: $orgId, block: $block) { id directDemocracyVoting { id } }
    }`, { orgId: scope.orgId, block: { hash: source.block!.hash } }, evidence.indexed.source) as any;
    assertSourceBlock(binding?._meta?.block && { number: String(binding._meta.block.number), hash: binding._meta.block.hash }, source.block!);
    if (binding.organization?.id?.toLowerCase() !== scope.orgId.toLowerCase()
      || binding.organization?.directDemocracyVoting?.id?.toLowerCase() !== contract.toLowerCase()) throw new Error('DD_MODULE_BINDING_MISMATCH');
    const authorization = deriveDirectDemocracyAuthorization({ scope, proposalId,
      proposal: { source, coverage: completeCoverage, data: { proposalId, membershipAuthority: knownFact(String(values[0]), source),
        executor: knownFact(String(values[1]), source), createdAt: knownFact(values[2].toString(), source), restricted: knownFact(values[3], source),
        restrictedSubjectIds: knownFact(subjects.filter((_, i) => values[4 + i]).map(row => row.subjectId), source) } },
      authority: evidence.snapshot, memberships: authorityAccountActivationMemberships(evidence.snapshot, account) });
    await evidence.assertCanonical();
    const result = { orgId: scope.orgId, proposalId, account, authorization, source,
      checked: ['dd-permission', 'membership-activation', 'restricted-electorate'],
      unchecked: ['proposal-existence', 'voting-time', 'pause', 'already-voted', 'weights', 'execution'] };
    if (output.isJsonMode()) output.json(result);
    else output.keyValueBlock('DD authorization policy', { proposalId, account,
      authorization: authorization.state === 'known' ? String(authorization.value) : `unknown: ${authorization.code}` });
  },
};
