import { ethers } from 'ethers';
import { getAbi } from '../../lib/contracts';
import { createProvider } from '../../lib/signer';
import { resolveOrgModules, requireModule } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import { tryAggregate } from '../../lib/multicall';
import { createIndexedSource, publicSourceEndpoint } from '../../lib/indexed-source';
import { readAuthoritySnapshot } from '@poa-box/core/reads/authority';
import { assertSourceBlock, knownFact, requireCompleteSnapshot, SourceRef, SourceSnapshot } from '@poa-box/core/data/facts';
import type { RoleConfigurationRequest, RolePlanningContext } from '@poa-box/core/governance/role-planning';
import type { ElectionMemberStatus } from '@poa-box/core/governance/elections';
import { encodeLensCall, decodeLensResult, STORAGE_KEYS } from '@poa-box/core/task-lens';
import { paymasterSubjectKey, SUBJECT_TYPE } from '@poa-box/core/sponsorship/codec';
import { verifyAllowlistDocument } from '@poa-box/core/email/allowlist';

export const completeCoverage = { status: 'complete' as const, receivedKeys: [], missingIds: [], failedIds: [], issues: [] };
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Host-selected provider/endpoint and current canonical block. Index lag blocks
 * planning: an older index block is never labelled current live evidence. */
export async function readRoleEvidence(argv: any) {
  const network = resolveNetworkConfig(argv.chain);
  const provider = createProvider({ chainId: network.chainId, rpcUrl: argv.rpc });
  const [modules, liveNetwork, block] = await Promise.all([
    resolveOrgModules(argv.org, network.chainId), provider.getNetwork(), provider.getBlock('latest'),
  ]);
  if (liveNetwork.chainId !== network.chainId || !block?.hash) throw new Error('LIVE_BLOCK_UNAVAILABLE');
  const authority = requireModule(modules, 'membershipAuthorityAddress');
  const executor = requireModule(modules, 'executorAddress');
  const hybridVoting = requireModule(modules, 'hybridVotingAddress');
  const contracts: Record<string, string> & { membershipAuthority: string; executor: string; hybridVoting: string } = { membershipAuthority: authority, executor, hybridVoting };
  if (modules.taskManagerAddress) contracts.taskManager = modules.taskManagerAddress;
  if (modules.zkEmailInvitesAddress) contracts.email = modules.zkEmailInvitesAddress;
  const scope = { chainId: network.chainId, orgId: modules.orgId, contract: authority, contracts };
  const selectedBlock = { number: String(block.number), hash: block.hash };
  const indexed = await createIndexedSource({ ...scope, block: selectedBlock });
  const snapshot = await readAuthoritySnapshot({ source: indexed.source, query: indexed.query });
  requireCompleteSnapshot(snapshot, { scope, indexed: true, snapshot: 'pinned', block: selectedBlock });
  const vars = { orgId: modules.orgId, block: { hash: block.hash } };
  const binding = await indexed.protocolQuery(`query RoleHostBindings($orgId: ID!, $block: Block_height) {
    _meta(block: $block) { block { number hash } }
    organization(id: $orgId, block: $block) { id membershipAuthority { id } hybridVoting { id } executorContract { id } taskManager { id } zkEmailInvites { id } }
  }`, vars, indexed.source) as any;
  assertSourceBlock(binding?._meta?.block && { number: String(binding._meta.block.number), hash: binding._meta.block.hash }, selectedBlock);
  if (!same(binding.organization?.id, modules.orgId) || !same(binding.organization?.membershipAuthority?.id, authority)
    || !same(binding.organization?.hybridVoting?.id, hybridVoting) || !same(binding.organization?.executorContract?.id, executor)) throw new Error('ROLE_MODULE_BINDING_MISMATCH');
  for (const [key, field] of [['taskManager', 'taskManager'], ['email', 'zkEmailInvites']]) if (contracts[key]
    && !same(binding.organization?.[field]?.id, contracts[key])) throw new Error('ROLE_MODULE_BINDING_MISMATCH');
  const now = Math.floor(Date.now() / 1000);
  const rpcSource: SourceRef = { ...scope, endpoint: publicSourceEndpoint(argv.rpc ?? network.resolvedRpc), method: 'authority-preflight',
    indexed: false, snapshot: 'pinned', block: selectedBlock, observedAt: now };
  const iface = new ethers.utils.Interface(getAbi('MembershipAuthority'));
  const read = async (calls: { method: string; args: unknown[] }[]) => {
    const results = await tryAggregate(provider, calls.map(call => ({ to: authority, data: iface.encodeFunctionData(call.method, call.args) })), { blockTag: block.number });
    return results.map((result, i) => {
      if (!result.success) throw new Error(`LIVE_AUTHORITY_READ_UNAVAILABLE:${calls[i].method}`);
      return iface.decodeFunctionResult(calls[i].method, result.returnData);
    });
  };
  const [actualExecutor, actualOrgId, paused] = await read([{ method: 'executor', args: [] }, { method: 'orgId', args: [] }, { method: 'paused', args: [] }]);
  if (!same(actualOrgId[0], modules.orgId) || !same(actualExecutor[0], executor)) throw new Error('LIVE_AUTHORITY_BINDING_MISMATCH');
  const assertCanonical = async () => {
    const current = await provider.getBlock(block.number);
    assertSourceBlock(current && { number: String(current.number), hash: current.hash }, selectedBlock);
  };
  return { scope, modules, provider, indexed, snapshot, rpcSource, read, paused: Boolean(paused[0]),
    freshness: { now, maxAgeSeconds: 60, block: selectedBlock }, assertCanonical };
}

export type RoleEvidence = Awaited<ReturnType<typeof readRoleEvidence>>;
export function statusFromResult(row: ethers.utils.Result): Omit<ElectionMemberStatus, 'account'> {
  return { accepted: row.accepted ?? row[0], eligible: row.eligible_ ?? row[1], acceptedAt: (row.acceptedAt ?? row[2]).toString(), ruleKind: Number(row.ruleKind ?? row[3]) };
}
export async function rolePlanningContext(evidence: RoleEvidence, request: RoleConfigurationRequest, subjectId?: string): Promise<SourceSnapshot<RolePlanningContext>> {
  const { snapshot, rpcSource, read } = evidence;
  const holders = request.holders ?? [];
  const roleIds = snapshot.data.subjects.filter(row => row.kind === 'Role').map(row => row.subjectId);
  // userSubjects is the contract's accepted roster, including accepted/ineligible seats.
  const accountReads = await read(holders.flatMap(holder => [{ method: 'userSubjects', args: [holder.account] },
    ...(subjectId ? [{ method: 'getStatus', args: [subjectId, holder.account] }] : [])]));
  let cursor = 0;
  const accounts = holders.map(holder => {
    const subjects = accountReads[cursor++][0] as ethers.BigNumber[];
    if (subjects.some(id => !roleIds.includes(id.toString()))) throw new Error('ACCEPTED_SUBJECT_CONTEXT_MISMATCH');
    const source = { ...rpcSource, account: holder.account };
    return { account: holder.account, acceptedAnywhere: knownFact(subjects.length > 0, source),
      ...(subjectId ? { acceptedInSubject: knownFact(statusFromResult(accountReads[cursor++]).accepted, source), acceptedSubjectId: subjectId } : {}) };
  });
  await evidence.assertCanonical();
  const data: RolePlanningContext = {
    indexedAuthoritySource: snapshot.source,
    readiness: { membershipAuthority: snapshot.data.authority as any }, executorAuthorized: knownFact(true, rpcSource),
    subjects: snapshot.data.subjects.map(row => ({ subjectId: row.subjectId, kind: row.kind, maxMembers: row.maxMembers,
      memberCount: row.memberCount, metadataPointer: row.raw.metadataCID as string, imageURI: row.raw.imageURI as string })),
    groupEdges: snapshot.data.groupEdges, accounts,
  };
  const externalRead = async (target: string, abiName: string, calls: { method: string; args: unknown[] }[]) => {
    const iface = new ethers.utils.Interface(getAbi(abiName));
    const rows = await tryAggregate(evidence.provider, calls.map(call => ({ to: target, data: iface.encodeFunctionData(call.method, call.args) })),
      { blockTag: Number(evidence.freshness.block.number) });
    return rows.map((row, i) => { if (!row.success) throw new Error(`LIVE_MODULE_READ_UNAVAILABLE:${calls[i].method}`);
      return iface.decodeFunctionResult(calls[i].method, row.returnData); });
  };
  const externalSource = (contract: string) => ({ ...rpcSource, contract });
  if (request.taskGrants?.creator || request.taskGrants?.organizer) {
    const address = requireModule(evidence.modules, 'taskManagerAddress');
    const [row] = await tryAggregate(evidence.provider, [{ to: address, data: encodeLensCall(STORAGE_KEYS.EXECUTOR) }], { blockTag: Number(evidence.freshness.block.number) });
    if (!row.success) throw new Error('TASK_MANAGER_CONTEXT_UNAVAILABLE');
    const [executor] = ethers.utils.defaultAbiCoder.decode(['address'], decodeLensResult(row.returnData));
    data.taskManager = { address, executorAuthorized: knownFact(same(executor, evidence.scope.contracts.executor), externalSource(address)) };
  }
  if (request.bindingClassIndex !== undefined) {
    const address = evidence.scope.contracts.hybridVoting;
    const [executor, classes] = await externalRead(address, 'HybridVotingNew', [{ method: 'executor', args: [] }, { method: 'getClasses', args: [] }]);
    data.hybrid = { address, executorAuthorized: knownFact(same(executor[0], evidence.scope.contracts.executor), externalSource(address)),
      classes: classes[0].map((_: unknown, classIndex: number) => ({ classIndex })) };
  }
  if (request.editOrgDetails || request.sponsorship) {
    const infra = await evidence.indexed.protocolQuery(`query RoleInfrastructure($block: Block_height) {
      _meta(block: $block) { block { number hash } }
      poaManagerContracts(first: 1, block: $block) { id orgRegistryProxy paymasterHubProxy }
    }`, { block: { hash: rpcSource.block!.hash } }, evidence.indexed.source) as any;
    assertSourceBlock(infra?._meta?.block && { number: String(infra._meta.block.number), hash: infra._meta.block.hash }, rpcSource.block!);
    if (infra.poaManagerContracts?.length !== 1) throw new Error('ROLE_INFRASTRUCTURE_UNAVAILABLE');
    const record = infra.poaManagerContracts[0];
    if (request.editOrgDetails) {
      const address = record.orgRegistryProxy;
      if (!ethers.utils.isAddress(address) || address === ethers.constants.AddressZero) throw new Error('ORG_ADMIN_CONTEXT_UNAVAILABLE');
      evidence.scope.contracts.registry = address;
      const [currentAdmin] = await externalRead(address, 'OrgRegistry', [{ method: 'getOrgMetadataAdminHat', args: [evidence.scope.orgId] }]);
      const iface = new ethers.utils.Interface(getAbi('OrgRegistry'));
      let authorized = false;
      try { await evidence.provider.call({ to: address, from: evidence.scope.contracts.executor,
        data: iface.encodeFunctionData('setOrgMetadataAdminHat', [evidence.scope.orgId, currentAdmin[0]]) }, Number(rpcSource.block!.number)); authorized = true; } catch { /* Live preflight refusal. */ }
      data.registry = { address, executorAuthorized: knownFact(authorized, externalSource(address)), currentAdminSubject: knownFact(currentAdmin[0].toString(), externalSource(address)) };
    }
    if (request.sponsorship) {
      const address = record.paymasterHubProxy;
      if (!ethers.utils.isAddress(address) || address === ethers.constants.AddressZero) throw new Error('SPONSORSHIP_CONTEXT_UNAVAILABLE');
      evidence.scope.contracts.paymaster = address;
      const email = evidence.modules.zkEmailInvitesAddress;
      const [budget] = email ? await externalRead(address, 'PaymasterHub', [{ method: 'getBudget', args: [evidence.scope.orgId, paymasterSubjectKey(SUBJECT_TYPE.CLAIM, email)] }]) : [];
      const iface = new ethers.utils.Interface(getAbi('PaymasterHub'));
      let authorized = false;
      try { await evidence.provider.call({ to: address, from: evidence.scope.contracts.executor,
        data: iface.encodeFunctionData('setBudget', [evidence.scope.orgId, paymasterSubjectKey(SUBJECT_TYPE.HAT, subjectId ?? '0'), '0', 3600]) }, Number(rpcSource.block!.number)); authorized = true; } catch { /* Live preflight refusal. */ }
      data.sponsorship = { address, operatorAuthorized: knownFact(authorized, externalSource(address)),
        claimBudgetExists: knownFact(budget ? Number(budget[0].epochLen) > 0 : false, externalSource(address)) };
    }
  }
  if (request.email || request.sponsorship?.includeConfiguredEmailRules) {
    const address = requireModule(evidence.modules, 'zkEmailInvitesAddress'), executorAddress = evidence.scope.contracts.executor;
    const [executor, root, domain, email] = await externalRead(address, 'ZkEmailInvites', [
      { method: 'executor', args: [] }, { method: 'merkleRoot', args: [] }, { method: 'domainVerifier', args: [] }, { method: 'emailVerifier', args: [] }]);
    const [authority, minter] = await externalRead(executorAddress, 'Executor', [{ method: 'membershipAuthority', args: [] }, { method: 'isAuthorizedHatMinter', args: [address] }]);
    data.email = { address, executorAddress, enabled: knownFact(same(executor[0], executorAddress), externalSource(address)),
      authorityMatches: knownFact(same(authority[0], evidence.scope.contract), externalSource(address)),
      minterAuthorized: knownFact(Boolean(minter[0]), externalSource(executorAddress)),
      domainEnabled: knownFact(!same(domain[0], ethers.constants.AddressZero), externalSource(address)),
      emailEnabled: knownFact(!same(email[0], ethers.constants.AddressZero), externalSource(address)), currentRoot: knownFact(String(root[0]), externalSource(address)) };
    if (request.email?.current) request.email.current = verifyAllowlistDocument(request.email.current, { orgId: evidence.scope.orgId, root: String(root[0]) });
  }
  await evidence.assertCanonical();
  return { source: rpcSource, coverage: completeCoverage, data };
}
