import { ethers } from 'ethers';
import type { Fact, SourceSnapshot } from '@poa-box/core/data/facts';
import { requireRawUint } from '@poa-box/core/amounts';
import { requireValidUsername } from '@poa-box/core/validation';
import { buildRegisterAndQuickJoin, buildRegisterAndQuickJoinWithPasskey } from '@poa-box/core/tx/user';
import type { PasskeyEnrollment } from '@poa-box/core/tx/enrollment';
import { passkeyRegistrationArgs } from '@poa-box/core/tx/enrollment';
import { getAbi } from '@poa-box/core/contracts';
import { REGISTER_ACCOUNT_TYPES, registrationChallenge, registrationDomain, WebAuthnAuth } from '@poa-box/core/accounts/codecs';
import { createOperationWorkflow } from './operation';
import { copy, freeze, known, moduleScope, nonzero, refuse, snapshot } from './shared';
import type { EvidenceReader, WorkflowHost } from './types';

export type EnrollmentRequest = { mode: 'eoa'; username: string; deadline: string }
  | { mode: 'passkey'; username: string; deadline: string; accountAddress: string; passkey: PasskeyEnrollment };
export interface EnrollmentEvidence {
  quickJoin: SourceSnapshot<{ accountRegistry: Fact<string>; passkeyFactory: Fact<string>; executor: Fact<string> }>;
  registry: SourceSnapshot<{ user: string; username: string; nonce: Fact<string>; usernameAvailable: Fact<boolean>; registered: Fact<boolean> }>;
  /** Required for passkey: factory-derived address for exactly the public key,
   * credential digest and salt in the reviewed request. */
  passkeyPrediction?: SourceSnapshot<{ passkey: PasskeyEnrollment; accountAddress: Fact<string> }>;
}
export interface EnrollmentSigningPorts {
  signEoa?(input: { domain: ReturnType<typeof registrationDomain>; types: typeof REGISTER_ACCOUNT_TYPES;
    message: { user: string; username: string; nonce: string; deadline: string }; challenge: string }, options: { signal?: AbortSignal; isCurrent: () => boolean }): Promise<string>;
  /** Inject a registration signer configured with an explicit credential,
   * origin/RP policy and user-verification policy. No private key API exists. */
  signPasskey?(input: { challenge: string; accountAddress: string; passkey: Readonly<PasskeyEnrollment> }, options: { signal?: AbortSignal; isCurrent: () => boolean }): Promise<WebAuthnAuth>;
}
export interface EnrollmentSummary { mode: 'eoa' | 'passkey'; username: string; accountAddress: string; deadline: string; nonce: string; registry: string }
/** Atomic registration + QuickJoin. This intentionally excludes legacy
 * multitransaction registration and email proving. Passkey cryptography is
 * delegated to the injected signer and verified by the exact RPC simulation. */
export function createEnrollmentWorkflow(inputHost: WorkflowHost, reader: EvidenceReader<EnrollmentRequest, EnrollmentEvidence>, signing: EnrollmentSigningPorts) {
  const host = { ...inputHost, scope: freeze(copy(inputHost.scope)), sources: { ...inputHost.sources } };
  const quickJoin = nonzero(host.scope.contracts.quickJoin), registry = nonzero(host.scope.contracts.accountRegistry);
  const target = (request: Readonly<EnrollmentRequest>) => request.mode === 'eoa' ? nonzero(host.scope.account) : nonzero(request.accountAddress);
  const registryData = (request: Readonly<EnrollmentRequest>, evidence: EnrollmentEvidence) => {
    const scope = { ...moduleScope(host.scope, registry, true), account: target(request) };
    const data = snapshot(evidence.registry, scope, host.sources, false, evidence.quickJoin);
    if (data.user.toLowerCase() !== target(request).toLowerCase() || data.username !== request.username) refuse('REGISTRATION_SCOPE_MISMATCH', 'unknown');
    return { data, scope };
  };
  return createOperationWorkflow<EnrollmentRequest, EnrollmentEvidence, EnrollmentSummary>(host, reader, {
    name: 'enrollment',
    evaluate(request, evidence) {
      if (!['eoa', 'passkey'].includes(request.mode)) refuse('UNSUPPORTED_ENROLLMENT_MODE');
      requireValidUsername(request.username);
      const deadline = requireRawUint(request.deadline);
      const qscope = moduleScope(host.scope, quickJoin), qj = snapshot(evidence.quickJoin, qscope, host.sources, false);
      if (known(qj.accountRegistry, evidence.quickJoin, qscope).toLowerCase() !== registry.toLowerCase()
        || known(qj.executor, evidence.quickJoin, qscope).toLowerCase() !== nonzero(host.scope.contracts.executor).toLowerCase()) refuse('ENROLLMENT_MODULE_BINDINGS_CHANGED', 'unknown');
      const { data, scope } = registryData(request, evidence), nonce = requireRawUint(known(data.nonce, evidence.registry, scope));
      if (known(data.registered, evidence.registry, scope) !== false) refuse('ACCOUNT_ALREADY_REGISTERED');
      if (known(data.usernameAvailable, evidence.registry, scope) !== true) refuse('USERNAME_UNAVAILABLE');
      if (BigInt(deadline) <= BigInt(host.sources.now()) || BigInt(deadline) <= BigInt(evidence.quickJoin.source.block!.timestamp!)) refuse('REGISTRATION_EXPIRED');
      if (request.mode === 'passkey') {
        if (!signing.signPasskey || !evidence.passkeyPrediction) refuse('PASSKEY_SIGNER_AND_PREDICTION_REQUIRED', 'unknown');
        const factory = nonzero(host.scope.contracts.passkeyFactory);
        if (known(qj.passkeyFactory, evidence.quickJoin, qscope).toLowerCase() !== factory.toLowerCase()) refuse('PASSKEY_FACTORY_BINDING_CHANGED', 'unknown');
        const pscope = { ...moduleScope(host.scope, factory, true), account: target(request) };
        const prediction = snapshot(evidence.passkeyPrediction, pscope, host.sources, false, evidence.quickJoin);
        const publicKey = (value: PasskeyEnrollment) => {
          if (![value.credentialId, value.publicKeyX, value.publicKeyY].every(field => ethers.utils.isHexString(field, 32))) refuse('PASSKEY_PUBLIC_INPUT_INVALID');
          return [value.credentialId.toLowerCase(), value.publicKeyX.toLowerCase(), value.publicKeyY.toLowerCase(), requireRawUint(value.salt)];
        };
        if (JSON.stringify(publicKey(prediction.passkey)) !== JSON.stringify(publicKey(request.passkey))
          || known(prediction.accountAddress, evidence.passkeyPrediction, pscope).toLowerCase() !== target(request).toLowerCase()) refuse('PASSKEY_ACCOUNT_PREDICTION_MISMATCH', 'unknown');
      } else if (!signing.signEoa) refuse('REGISTRATION_SIGNER_REQUIRED');
      const summary = { mode: request.mode, username: request.username, accountAddress: target(request), deadline, nonce, registry };
      return { binding: summary, summary };
    },
    async build(request, evidence, _documents, approveSigning, signal, isCurrent) {
      const { data, scope } = registryData(request, evidence), nonce = requireRawUint(known(data.nonce, evidence.registry, scope));
      const message = { user: target(request), username: request.username, nonce, deadline: requireRawUint(request.deadline) };
      const input = { ...message, chainId: host.scope.chainId, registryAddress: registry };
      const challenge = registrationChallenge(input, request.mode);
      await approveSigning();
      if (isCurrent?.() !== true) refuse('REGISTRATION_SCOPE_CHANGED');
      if (request.mode === 'eoa') {
        const domain = registrationDomain(host.scope.chainId, registry);
        const signature = await signing.signEoa!({ domain, types: REGISTER_ACCOUNT_TYPES, message, challenge }, { signal, isCurrent });
        // A signer cannot substitute a chain, nonce, identity or username.
        if (ethers.utils.verifyTypedData(domain, REGISTER_ACCOUNT_TYPES, message, signature).toLowerCase() !== target(request).toLowerCase()) refuse('REGISTRATION_SIGNATURE_MISMATCH');
        return buildRegisterAndQuickJoin({ quickJoinAddress: quickJoin, user: target(request), username: request.username,
          nonce, deadline: request.deadline, signature, orgId: host.scope.orgId });
      }
      const auth = await signing.signPasskey!({ challenge, accountAddress: target(request), passkey: request.passkey }, { signal, isCurrent });
      const args = { passkey: request.passkey, username: request.username, deadline: request.deadline, nonce, auth };
      passkeyRegistrationArgs(args);
      // The injected signer owns RP/origin/UV checks; bind its assertion to the
      // exact core-generated challenge before the contract verifies the P-256 proof.
      let client: { challenge?: string; type?: string };
      try { client = JSON.parse(auth.clientDataJSON.startsWith('0x') ? ethers.utils.toUtf8String(auth.clientDataJSON) : auth.clientDataJSON); }
      catch { refuse('PASSKEY_CLIENT_DATA_INVALID'); }
      const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const bytes = ethers.utils.arrayify(challenge); let encoded = '', bits = 0, accumulator = 0;
      for (const byte of bytes) { accumulator = (accumulator << 8) | byte; bits += 8; while (bits >= 6) { bits -= 6; encoded += base64[(accumulator >>> bits) & 63]; } }
      if (bits) encoded += base64[(accumulator << (6 - bits)) & 63];
      if (client.type !== 'webauthn.get' || client.challenge !== encoded) refuse('PASSKEY_REGISTRATION_CHALLENGE_MISMATCH');
      return buildRegisterAndQuickJoinWithPasskey({ ...args, quickJoinAddress: quickJoin, orgId: host.scope.orgId });
    },
    journalRequest(request) { return { mode: request.mode, username: request.username, deadline: request.deadline, accountAddress: target(request) }; },
    outcome(request, receipt) {
      const iface = new ethers.utils.Interface(getAbi('QuickJoinNew'));
      const expected = request.mode === 'eoa' ? 'RegisterAndQuickJoined' : 'RegisterAndQuickJoinedWithPasskey';
      const events = (receipt.logs ?? []).filter(log => log.address.toLowerCase() === quickJoin.toLowerCase()).flatMap(log => {
        try { const event = iface.parseLog({ topics: [...log.topics], data: log.data }); return event.name === expected ? [event] : []; } catch { return []; }
      });
      if (events.length !== 1) return { status: 'unknown', codes: ['ATOMIC_ENROLLMENT_EVIDENCE_REQUIRED'] };
      const args = events[0].args, accountAddress = target(request);
      if ((args.user ?? args.account)?.toLowerCase() !== accountAddress.toLowerCase() || args.username !== request.username)
        return { status: 'unknown', codes: ['ATOMIC_ENROLLMENT_IDENTITY_MISMATCH'] };
      return { status: 'confirmed', data: { username: request.username, accountAddress, transactionHash: receipt.transactionHash } };
    },
  });
}
