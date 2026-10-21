import fs from 'fs';
import type { Argv } from 'yargs';
import { ethers } from 'ethers';
import { planRoleCreation, planExistingRoleConfiguration, type RoleConfigurationRequest } from '@poa-box/core/governance/role-planning';
import { normalizeSubjectId } from '@poa-box/core/authority/ids';
import { buildGovernanceProposal } from '@poa-box/core/tx/governance';
import { readRoleContinuation, readRoleConfigurationOutcome } from '@poa-box/core/governance/role-continuation';
import { readRoleEvidence, rolePlanningContext } from './evidence';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { executeTx } from '../../lib/tx';
import * as output from '../../lib/output';

function requestFromFile(path: string, kind: 'Role' | 'Group'): RoleConfigurationRequest {
  const request = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.kind !== kind) throw new Error(`Request must be a ${kind} configuration object`);
  // Evidence can only come from the host collectors below, never from this file.
  for (const key of ['scope', 'context', 'source', 'allocations', 'proposals', 'subjectId', 'fingerprint']) if (key in request) throw new Error(`Configuration must not contain evidence field ${key}`);
  return request;
}

export function rolePlanHandler(kind: 'Role' | 'Group', submit = false) {
  return {
    builder: (y: Argv) => {
      y = y.option('file', { type: 'string', demandOption: true, describe: `${kind}ConfigurationRequest JSON; desired values only, never source evidence` })
        .option('subject', { type: 'string', describe: 'Existing verified subject ID; omit to plan creation alone' });
      if (submit) y = y.option('expected-fingerprint', { type: 'string', demandOption: true, describe: 'Fingerprint from a reviewed plan; current evidence is collected again' })
        .option('duration', { type: 'number', default: 60, describe: 'Governance vote duration in minutes' });
      return y.epilogue('Creation and configuration are separate votes. After creation executes, use continuation with the exact creation transaction and calldata. No subject ID is predicted.');
    },
    handler: async (argv: any) => {
      const request = requestFromFile(argv.file, kind);
      const subjectId = argv.subject === undefined ? undefined : normalizeSubjectId(argv.subject);
      const evidence = await readRoleEvidence(argv);
      const context = await rolePlanningContext(evidence, request, subjectId);
      const input = { scope: evidence.scope, freshness: evidence.freshness, context, request };
      const plan = subjectId === undefined ? planRoleCreation(input) : planExistingRoleConfiguration({ ...input, subjectId });
      if (!submit || plan.status !== 'ready') {
        if (output.isJsonMode()) output.json({ orgId: evidence.scope.orgId, phase: subjectId === undefined ? 'creation' : 'configuration', plan,
          indexedSource: evidence.snapshot.source, liveSource: evidence.rpcSource });
        else output.keyValueBlock(`${kind} plan`, { status: plan.status,
          ...(plan.status === 'ready' ? { fingerprint: plan.data.fingerprint, calls: plan.data.batch.length } : { codes: plan.codes.join(', ') }) });
        if (submit && plan.status !== 'ready') throw new Error(`ROLE_PLAN_BLOCKED:${plan.codes.join(',')}`);
        return;
      }
      if (plan.data.fingerprint !== argv.expectedFingerprint) throw new Error('STALE_ROLE_PLAN');
      const ctx = await getWriteContext(argv);
      if (ctx.orgId.toLowerCase() !== evidence.scope.orgId.toLowerCase() || ctx.chainId !== evidence.scope.chainId) throw new Error('ROLE_SUBMISSION_SCOPE_MISMATCH');
      const intent = buildGovernanceProposal({ votingAddress: evidence.scope.contracts.hybridVoting, votingAbiName: 'HybridVotingNew',
        title: `${subjectId ? 'Configure' : 'Create'} ${kind.toLowerCase()}: ${request.name}`, descriptionHash: ethers.constants.HashZero,
        durationMinutes: argv.duration, numOptions: 2, batches: [plan.data.batch, []], subjectIds: [], orgId: ctx.orgId });
      await confirmWrite(argv, { kind, phase: subjectId ? 'configuration' : 'creation', subject: subjectId,
        fingerprint: plan.data.fingerprint, calls: JSON.stringify(plan.data.batch), consequences: JSON.stringify(plan.consequences) },
      { destructive: true, actionLabel: 'Propose reviewed authority changes' });
      // Interactive review can outlive freshness; rebuild from newly observed state.
      const current = await readRoleEvidence(argv);
      const currentRequest = requestFromFile(argv.file, kind);
      const refreshed = await rolePlanningContext(current, currentRequest, subjectId);
      const next = subjectId === undefined ? planRoleCreation({ scope: current.scope, freshness: current.freshness, context: refreshed, request: currentRequest })
        : planExistingRoleConfiguration({ scope: current.scope, freshness: current.freshness, context: refreshed, request: currentRequest, subjectId });
      if (next.status !== 'ready' || next.data.fingerprint !== plan.data.fingerprint) throw new Error('STALE_ROLE_PLAN');
      const result = await executeTx(new ethers.Contract(intent.to, intent.abi, ctx.signer), intent.method, intent.args, { dryRun: argv.dryRun });
      finishWrite(result, { successMsg: `${kind} ${subjectId ? 'configuration' : 'creation'} proposal created`, fields: {
        orgId: ctx.orgId, subjectId, phase: subjectId ? 'configuration' : 'creation', fingerprint: plan.data.fingerprint,
        proposalId: result.logs?.find(row => row.name === 'NewProposal')?.args.id?.toString(), account: ctx.address,
        ...(subjectId ? { configurationBatch: plan.data.batch } : { creationCall: plan.data.batch[0] }),
      } });
    },
  };
}

/** Exact transaction and calldata are lookup constraints. Core independently checks
 * caller, canonical chain receipts, event associations and fresh indexed subject. */
export const roleContinuationHandler = {
  builder: (y: Argv) => y.option('creation-tx', { type: 'string', demandOption: true, describe: 'Exact transaction that submitted the creation/configuration proposal' })
    .option('account', { type: 'string', demandOption: true, describe: 'Original proposal caller address' })
    .option('creation-calldata', { type: 'string', describe: 'Exact MembershipAuthority createRole/createGroup calldata (creation continuation)' })
    .option('batch-file', { type: 'string', describe: 'Exact configuration ExecutionCall[] JSON (configuration outcome)' })
    .conflicts('creation-calldata', 'batch-file')
    .option('proposal', { type: 'string', describe: 'Optional exact proposal ID constraint' })
    .option('creation-operation', { type: 'string', describe: 'Optional ERC-4337 exact operation identity JSON' })
    .option('execution-operation', { type: 'string', describe: 'Optional independent execution operation identity JSON' }),
  handler: async (argv: any) => {
    if (!ethers.utils.isAddress(argv.account) || argv.account === ethers.constants.AddressZero) throw new Error('Original --account must be a nonzero address');
    if (!argv.creationCalldata && !argv.batchFile) throw new Error('Specify --creation-calldata or --batch-file');
    const evidence = await readRoleEvidence(argv);
    const scope = { ...evidence.scope, account: argv.account };
    const args = { scope, source: { ...evidence.indexed.source, account: argv.account }, rpcSource: { ...evidence.rpcSource, account: argv.account },
      query: evidence.indexed.protocolQuery, provider: evidence.provider, creationTransactionHash: argv.creationTx, proposalId: argv.proposal,
      ...(argv.creationOperation ? { creationOperation: JSON.parse(argv.creationOperation) } : {}),
      ...(argv.executionOperation ? { executionOperation: JSON.parse(argv.executionOperation) } : {}), freshness: evidence.freshness };
    const outcome = argv.batchFile ? await readRoleConfigurationOutcome({ ...args, batch: JSON.parse(fs.readFileSync(argv.batchFile, 'utf8')) })
      : await readRoleContinuation({ ...args, creationCall: { target: scope.contract, value: '0', calldata: argv.creationCalldata },
        subjects: { ...evidence.snapshot, data: evidence.snapshot.data.subjects } });
    await evidence.assertCanonical();
    if (output.isJsonMode()) output.json({ orgId: scope.orgId, outcome, source: evidence.indexed.source });
    else output.keyValueBlock('Role continuation', { ...outcome });
  },
};
