import { ethers } from 'ethers';
import { AUTHORITY_KEYS } from '@poa-box/core/tx/authority';

const publicUrl = value => {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('PUBLIC_HTTP_ENDPOINT_REQUIRED');
  return url.href;
};
const number = raw => {
  const value = Number(BigInt(raw));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('RPC_INTEGER_OUT_OF_RANGE');
  return value;
};
// Preserve only bounded, structured revert bytes. Transport messages, endpoint
// details and arbitrary response bodies are not protocol authorization evidence.
const rpcFailure = error => {
  const failure = new Error('READ_ONLY_RPC_FAILED');
  for (let depth = 0; depth < 3 && error && typeof error === 'object'; depth++, error = error.error) {
    if (typeof error.data === 'string' && /^0x(?:[\da-f]{2})*$/i.test(error.data)) {
      failure.data = error.data;
      break;
    }
  }
  return failure;
};
/** Explicit public input only. No env, signer, publisher, arbitrary RPC method,
 * account factory, wallet transport or hidden provider construction. */
export function createReadOnlyAdapter(input, { fetch: fetcher, now, signal } = {}) {
  if (typeof fetcher !== 'function' || typeof now !== 'function') throw new Error('EXPLICIT_TRANSPORT_AND_CLOCK_REQUIRED');
  for (const key of Object.keys(input)) if (!['scope', 'indexedEndpoint', 'rpcEndpoint', 'request'].includes(key)) throw new Error('UNSUPPORTED_PUBLIC_INPUT:' + key);
  const indexedEndpoint = publicUrl(input.indexedEndpoint), rpcEndpoint = publicUrl(input.rpcEndpoint);
  const post = async (url, body) => {
    const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) throw new Error('READ_ONLY_HTTP_FAILED');
    return response.json();
  };
  let nextId = 1;
  const rpc = async (method, params) => {
    const id = nextId++, result = await post(rpcEndpoint, { jsonrpc: '2.0', id, method, params });
    if (!result || typeof result !== 'object' || result.id !== id) throw rpcFailure();
    if (result.error) throw rpcFailure(result.error);
    if (!('result' in result)) throw rpcFailure();
    return result.result;
  };
  const block = raw => raw && ({ number: number(raw.number), hash: raw.hash, timestamp: number(raw.timestamp) });
  const tag = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value) ? value : ethers.utils.hexValue(value);
  const provider = {
    async getNetwork() { return { chainId: number(await rpc('eth_chainId', [])) }; },
    async getBlock(value) { const selector = tag(value); return block(await rpc(selector.length === 66 ? 'eth_getBlockByHash' : 'eth_getBlockByNumber', [selector, false])); },
    async getTransaction(value) {
      const row = await rpc('eth_getTransactionByHash', [value]);
      return row && { ...row, data: row.input, nonce: number(row.nonce), chainId: row.chainId == null ? undefined : number(row.chainId),
        blockNumber: row.blockNumber == null ? null : number(row.blockNumber), value: ethers.BigNumber.from(row.value) };
    },
    async getTransactionReceipt(value) {
      const row = await rpc('eth_getTransactionReceipt', [value]);
      return row && { ...row, status: row.status == null ? undefined : number(row.status), blockNumber: row.blockNumber == null ? null : number(row.blockNumber),
        logs: row.logs.map(log => ({ ...log, blockNumber: number(log.blockNumber), logIndex: number(log.logIndex), transactionIndex: number(log.transactionIndex) })) };
    },
    async call(transaction, value) {
      const call = { to: transaction.to, data: transaction.data, ...(transaction.from ? { from: transaction.from } : {}) };
      return rpc('eth_call', [call, tag(value)]);
    },
  };
  const query = async (source, document, variables) => {
    if (source.endpoint !== indexedEndpoint || source.chainId !== input.scope.chainId || source.orgId !== input.scope.orgId) throw new Error('INDEXED_SOURCE_MISMATCH');
    const result = await post(indexedEndpoint, { query: document, variables });
    return { source, ...(result.data == null ? {} : { data: result.data }), issues: [
      ...(result.errors ?? []).map(() => ({ code: 'GRAPHQL_ERROR' })), ...(result.data == null ? [{ code: 'MISSING_DATA' }] : []),
    ] };
  };
  return { scope: input.scope, request: input.request, permissionKey: AUTHORITY_KEYS.TM_PERMS, zero: ethers.constants.HashZero,
    sources: { indexed: { endpoint: indexedEndpoint, query }, rpc: { endpoint: rpcEndpoint, provider }, now },
    client: { async query(document, variables, chainId) {
      if (chainId !== input.scope.chainId) throw new Error('ORG_CHAIN_MISMATCH');
      const result = await post(indexedEndpoint, { query: document, variables });
      if (result.errors?.length || !result.data) throw new Error('ORGANIZATION_READ_UNAVAILABLE');
      return result.data;
    } } };
}
