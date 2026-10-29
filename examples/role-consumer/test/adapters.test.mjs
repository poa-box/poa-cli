import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { getAbi } from '@poa-box/core/contracts';
import { readRoleOperationEvidence, reviewRoleOperation } from '@poa-box/core/governance/role-operations';
import { readAuthoritySnapshot, authorityAccountMembershipFacts } from '@poa-box/core/reads/authority';
import { projectUserPermissions, resolvePermissionContext } from '@poa-box/core/authority/permissions';
import { knownFact, unknownFact } from '@poa-box/core/data/facts';
import { permissionWord } from '@poa-box/core/tx/authority';
import { createFixture } from '../src/adapters/fixture.mjs';
import { createReadOnlyAdapter } from '../src/adapters/read-only.mjs';

const config = () => JSON.parse(readFileSync(new URL('../fixtures/role-workflow.v1.json', import.meta.url)));
const sourceOf = f => ({ ...f.scope, account: undefined, endpoint: f.config.indexedEndpoint, method: 'fixture-authority', indexed: true,
  snapshot: 'pinned', block: { number: String(f.config.block.number), hash: f.config.block.hash }, observedAt: f.state.now });

test('offline indexed transport executes real paged authority reader and group permission projection', async () => {
  const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('REAL_NETWORK_FORBIDDEN'); };
  try {
    const f = createFixture(config());
    const snapshot = await readAuthoritySnapshot({ source: sourceOf(f), query: f.query, pageSize: 2, maxPages: 3 });
    assert.equal(snapshot.coverage.status, 'complete');
    assert.equal(snapshot.data.subjects.length, 3);
    const memberships = authorityAccountMembershipFacts(snapshot, f.scope.account);
    const permission = projectUserPermissions({ snapshot, memberships, scope: f.scope, permKey: f.permissionKey, ctx: f.zero });
    assert.deepEqual(permission.enabled.value, true);
    assert.equal(permission.value.value, '8');
    assert.equal(permission.contributions.find(row => row.kind === 'Group').membership.value, true);
    const absent = authorityAccountMembershipFacts(snapshot, '0x' + 'ab'.repeat(20));
    assert.equal(absent.data[0].isMember.state, 'unknown');
    assert(f.trace.queries.every(row => row.variables.block.hash === f.config.block.hash));
    assert(f.trace.queries.filter(row => row.document.includes('AuthoritySubjectsPage')).length === 2);
    assert.equal(f.trace.sends.length, 0); assert.equal(f.trace.publications.length, 0);
  } finally { globalThis.fetch = original; }
});
test('explicit project zero overrides global and inheritGlobal retains the global value', () => {
  const permKey = createFixture(config()).permissionKey;
  assert.equal(resolvePermissionContext({ permKey, global: knownFact(permissionWord('8').toString()), project: knownFact(permissionWord('0').toString()) }).value.value, '0');
  assert.equal(resolvePermissionContext({ permKey, global: knownFact(permissionWord('8').toString()), project: knownFact(permissionWord('0', true).toString()) }).value.value, '8');
  assert.equal(resolvePermissionContext({ permKey, global: unknownFact('MISSING') }).state, 'unknown');
  assert.equal(resolvePermissionContext({ permKey, global: knownFact(null) }).value.value, '0');
});
test('fixture refuses noncanonical document, wrong endpoint, unpinned page and foreign ABI target', async () => {
  const f = createFixture(config()), source = sourceOf(f);
  await assert.rejects(f.query(source, 'query Fabricated { subjects { id } }', { orgId: f.scope.orgId, block: { hash: f.config.block.hash } }), /UNEXPECTED_DOCUMENT/);
  await assert.rejects(f.query({ ...source, endpoint: 'https://wrong.invalid' }, '', {}), /INDEX_SCOPE/);
  await assert.rejects(f.query(source, '', { orgId: f.scope.orgId, block: { number: 100 } }), /HASH_PIN_REQUIRED/);
  await assert.rejects(f.sources.rpc.provider.call({ to: f.scope.contracts.executor, data: '0x' }, 100), /CALL_SCOPE/);
});
test('public read adapter exposes only allowlisted reads and preserves exact JSON-RPC responses', async () => {
  const f = createFixture(config()), captured = [];
  const adapter = createReadOnlyAdapter({ scope: f.scope, indexedEndpoint: f.config.indexedEndpoint, rpcEndpoint: f.config.rpcEndpoint, request: f.request }, {
    now: () => 1001,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); captured.push({ url, body });
      const results = { eth_chainId: '0x64', eth_getBlockByNumber: { number: '0x64', hash: f.config.block.hash, timestamp: '0x3e8' }, eth_call: '0x' };
      assert(body.method in results);
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: results[body.method] }) };
    },
  });
  assert.deepEqual(Object.keys(adapter.sources.rpc.provider).sort(), ['call', 'getBlock', 'getNetwork', 'getTransaction', 'getTransactionReceipt']);
  assert.equal(adapter.publishDocument, undefined); assert.equal(adapter.send, undefined);
  assert.deepEqual(await adapter.sources.rpc.provider.getNetwork(), { chainId: 100 });
  assert.equal((await adapter.sources.rpc.provider.getBlock(100)).timestamp, 1000);
  await adapter.sources.rpc.provider.call({ to: f.scope.contract, data: '0x', value: '1' }, 100);
  assert.deepEqual(captured[2].body.params, [{ to: f.scope.contract, data: '0x' }, '0x64']);
  assert(captured.every(row => !row.body.method.includes('send') && !row.body.method.includes('sign')));
  assert.throws(() => createReadOnlyAdapter({ privateKey: 'forbidden' }, { fetch() {}, now: () => 1 }), /UNSUPPORTED_PUBLIC_INPUT/);
});
test('publisher receives and checks exact reviewed UTF-8 bytes/digest without claiming a CID preimage proof', async () => {
  const f = createFixture(config()), json = '{"description":"synthetic"}';
  const doc = { key: 'role-metadata', json, digest: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(json)) };
  assert.equal((await f.publishDocument(doc)).cid, f.config.cid);
  await assert.rejects(f.publishDocument({ ...doc, json: json + ' ' }), /EXACT_REVIEWED_BYTES/);
  assert.equal(f.trace.publications.length, 1);
});

for (const [abiName, denial] of [['OrgRegistry', 'NotOrgExecutor'], ['PaymasterHub', 'NotOperator']]) {
  for (const depth of [0, 1, 2]) test(`public RPC preserves canonical ${denial} bytes at nesting ${depth} without response bodies`, async () => {
    const f = createFixture(config()), encoded = new ethers.utils.Interface(getAbi(abiName)).encodeErrorResult(denial, []);
    let rpcError = { data: encoded, message: 'untrusted endpoint response', privateDetail: 'not evidence' };
    for (let i = 0; i < depth; i++) rpcError = { error: rpcError };
    const adapter = createReadOnlyAdapter({ scope: f.scope, indexedEndpoint: f.config.indexedEndpoint, rpcEndpoint: f.config.rpcEndpoint, request: f.request }, {
      now: () => f.state.now, fetch: async (_url, options) => ({ ok: true, json: async () => ({ id: JSON.parse(options.body).id, error: rpcError }) }),
    });
    await assert.rejects(adapter.sources.rpc.provider.call({ to: f.scope.contract, data: '0x' }, 100), error => {
      assert.equal(error.message, 'READ_ONLY_RPC_FAILED'); assert.equal(error.data, encoded);
      assert.deepEqual(Object.keys(error), ['data']); return true;
    });
  });
}

for (const variant of ['denied', 'unrelated', 'malformed', 'transport']) test(`actual observer through public HTTP adapter preserves ${variant} authorization evidence`, async () => {
  const f = createFixture(config()), registry = '0x' + '66'.repeat(20), paymaster = '0x' + '77'.repeat(20);
  const scope = { ...f.scope, contracts: { ...f.scope.contracts, registry, paymaster } };
  const request = { mode: 'existing', subjectId: f.ids.initial, role: { kind: 'Role', name: 'Members', editOrgDetails: true,
    sponsorship: { capRaw: '1', epochSeconds: '3600', supportPasskeys: false } } };
  const interfaces = { registry: new ethers.utils.Interface(getAbi('OrgRegistry')), paymaster: new ethers.utils.Interface(getAbi('PaymasterHub')) };
  const adapter = createReadOnlyAdapter({ scope, indexedEndpoint: f.config.indexedEndpoint, rpcEndpoint: f.config.rpcEndpoint, request }, {
    now: () => f.state.now,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); let response;
      if (url === f.config.indexedEndpoint) {
        if (body.query.includes('RolePlanningModuleBindings')) response = { data: { _meta: { block: f.config.block },
          organization: { id: scope.orgId, membershipAuthority: { id: scope.contract }, executorContract: { id: scope.contracts.executor }, hybridVoting: { id: scope.contracts.hybridVoting } },
          poaManagerContracts: [{ orgRegistryProxy: registry, paymasterHubProxy: paymaster }] } };
        else response = { data: (await f.query({ ...sourceOf(f), snapshot: body.variables.block ? 'pinned' : 'latest' }, body.query, body.variables)).data };
      } else {
        let result;
        if (body.method === 'eth_chainId') result = '0x64';
        else if (body.method === 'eth_getBlockByNumber') result = { number: '0x64', hash: f.config.block.hash, timestamp: '0x3e8' };
        else if (body.method === 'eth_call') {
          const [tx, tag] = body.params, key = tx.to === registry ? 'registry' : tx.to === paymaster ? 'paymaster' : null;
          if (!key) result = await f.sources.rpc.provider.call(tx, tag);
          else {
            const iface = interfaces[key], parsed = iface.parseTransaction(tx);
            if (parsed.name === 'getOrgMetadataAdminHat') result = iface.encodeFunctionResult(parsed.name, [f.ids.initial]);
            else {
              if (variant === 'transport') throw new Error('synthetic transport unavailable');
              const data = variant === 'denied' ? iface.encodeErrorResult(key === 'registry' ? 'NotOrgExecutor' : 'NotOperator', [])
                : variant === 'unrelated' ? '0x12345678' : 'not hexadecimal';
              response = { id: body.id, error: key === 'registry' ? { data } : { error: { error: { data } } } };
            }
          }
        } else assert.fail('Unexpected public RPC method: ' + body.method);
        response ??= { id: body.id, result };
      }
      return { ok: true, json: async () => response };
    },
  });
  const observed = await readRoleOperationEvidence({ scope, request, sources: adapter.sources });
  const planning = observed.status === 'ready' ? observed.data.context : observed.observations.planning;
  for (const [module, field] of [['registry', 'executorAuthorized'], ['sponsorship', 'operatorAuthorized']]) {
    assert.equal(planning.data[module][field].state, variant === 'denied' ? 'known' : 'unknown');
    if (variant === 'denied') assert.equal(planning.data[module][field].value, false);
  }
  assert.equal(planning.source.indexed, false); assert.equal(planning.source.endpoint, f.config.rpcEndpoint);
  assert.equal(observed.status, variant === 'denied' ? 'ready' : 'unknown');
  const reviewed = await reviewRoleOperation({ scope, request, sources: adapter.sources });
  assert.equal(reviewed.status, variant === 'denied' ? 'blocked' : 'unknown');
  assert.equal(reviewed.data, undefined); assert.equal(f.trace.sends.length, 0); assert.equal(f.trace.publications.length, 0);
});

test('mismatched RPC response cannot attach foreign revert evidence', async () => {
  const f = createFixture(config()), encoded = new ethers.utils.Interface(getAbi('PaymasterHub')).encodeErrorResult('NotOperator', []);
  const adapter = createReadOnlyAdapter({ scope: f.scope, indexedEndpoint: f.config.indexedEndpoint, rpcEndpoint: f.config.rpcEndpoint, request: f.request }, {
    now: () => f.state.now, fetch: async () => ({ ok: true, json: async () => ({ id: 'foreign', error: { data: encoded } }) }),
  });
  await assert.rejects(adapter.sources.rpc.provider.getNetwork(), error => error.message === 'READ_ONLY_RPC_FAILED' && error.data === undefined);
});
