import { ethers } from 'ethers';
import { getAbi } from '@poa-box/core/contracts';
import { knownFact } from '@poa-box/core/data/facts';
import { passkeyRegistrationArgs } from '@poa-box/core/tx/enrollment';
import type { EnrollmentEvidence, EnrollmentRequest } from '../workflows/enrollment';
import type { EvidenceReader } from '../workflows/types';
import { address, fail, ObservationRuntime, uint } from './common';

export function enrollmentReader(runtime: ObservationRuntime): EvidenceReader<EnrollmentRequest, EnrollmentEvidence> {
  return { read: (request, options) => runtime.run(options.scope, options.signal, async signal => {
    if (!['eoa', 'passkey'].includes(request.mode)) fail('UNSUPPORTED_ENROLLMENT_MODE');
    const block = await runtime.open('quickJoin', signal), quickJoin = runtime.scope.contracts.quickJoin, registry = runtime.scope.contracts.accountRegistry;
    const user = request.mode === 'eoa' ? runtime.scope.account : address(request.accountAddress);
    const [boundRegistry, factory, executor, authority, nonce, username, owner] = await Promise.all([
      ...['accountRegistry', 'universalFactory', 'executor', 'membershipAuthority'].map(method => runtime.rpc(quickJoin, getAbi('QuickJoinNew'), method, [], block, signal)),
      runtime.rpc(registry, getAbi('UniversalAccountRegistry'), 'nonces', [user], block, signal),
      runtime.rpc(registry, getAbi('UniversalAccountRegistry'), 'getUsername', [user], block, signal),
      runtime.rpc(registry, getAbi('UniversalAccountRegistry'), 'getAddressOfUsername', [request.username], block, signal),
    ]);
    if (address(boundRegistry) !== registry || address(executor) !== runtime.scope.contracts.executor || address(authority) !== runtime.scope.contracts.membershipAuthority) fail('ENROLLMENT_MODULE_BINDING_MISMATCH');
    if (typeof username !== 'string' || typeof owner !== 'string' || !ethers.utils.isAddress(owner)) fail('REGISTRATION_STATE_UNAVAILABLE');
    const qsource = runtime.source(quickJoin, false, block, 'workflow-enrollment-bindings'), rsource = runtime.source(registry, false, block, 'workflow-registry-state', user);
    // A zero factory is a real binding for EOA-only deployments; passkey mode
    // additionally requires the explicit nonzero configured factory below.
    if (typeof factory !== 'string' || !ethers.utils.isAddress(factory)) fail('PASSKEY_FACTORY_BINDING_UNAVAILABLE');
    const base: EnrollmentEvidence = {
      quickJoin: runtime.snapshot({ accountRegistry: knownFact(address(boundRegistry), qsource), passkeyFactory: knownFact(factory.toLowerCase(), qsource), executor: knownFact(address(executor), qsource) }, qsource),
      registry: runtime.snapshot({ user, username: request.username, nonce: knownFact(uint(nonce), rsource),
        usernameAvailable: knownFact(owner.toLowerCase() === ethers.constants.AddressZero, rsource), registered: knownFact(username.length > 0, rsource) }, rsource),
    };
    if (request.mode === 'passkey') {
      if (address(factory) !== runtime.scope.contracts.passkeyFactory) fail('PASSKEY_FACTORY_BINDING_MISMATCH');
      // Reuse the public core argument validator before the concrete factory call.
      const args = passkeyRegistrationArgs({ passkey: request.passkey, username: request.username, deadline: request.deadline,
        nonce: uint(nonce), auth: { authenticatorData: '0x', clientDataJSON: '0x', challengeIndex: '0', typeIndex: '0', r: ethers.constants.HashZero, s: ethers.constants.HashZero } });
      const passkey = args[0] as readonly unknown[];
      const predicted = await runtime.rpc(factory, getAbi('PasskeyAccountFactory'), 'getAddress', passkey, block, signal);
      const source = runtime.source(factory, false, block, 'workflow-passkey-prediction', user);
      base.passkeyPrediction = runtime.snapshot({ passkey: request.passkey, accountAddress: knownFact(address(predicted), source) }, source);
    }
    await runtime.canonical(block, signal);
    return base;
  }) };
}
