import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { knownFact, unknownFact } from '../../../src/data/facts';
import { getAbi } from '../../../src/contracts';
import { registrationChallenge } from '../../../src/accounts/codecs';
import { createEnrollmentWorkflow } from '../../../src/workflows';
import type { EnrollmentEvidence, EnrollmentRequest, EnrollmentSigningPorts } from '../../../src/workflows';
import { addr, assertReady, fixture, hash, scope } from './fixture';
import { withSponsored } from './sponsored-fixture';

function enrollmentFixture(mode: 'eoa' | 'passkey' = 'eoa') {
  const f = fixture();
  // Ephemeral synthetic test identity. It never reaches an external provider.
  const signer = ethers.Wallet.createRandom();
  f.host.scope.account = signer.address; f.control.account = signer.address; f.control.simulateAccount = signer.address;
  const passkey = { credentialId: hash('a'), publicKeyX: hash('b'), publicKeyY: hash('c'), salt: '2' };
  const request: EnrollmentRequest = mode === 'eoa' ? { mode, username: 'synthetic_user', deadline: '1100' }
    : { mode, username: 'synthetic_user', deadline: '1100', accountAddress: addr('d'), passkey };
  const user = mode === 'eoa' ? signer.address : addr('d');
  const evidence = (): EnrollmentEvidence => {
    const registry = f.snapshot({ user, username: request.username, nonce: knownFact('7'), usernameAvailable: knownFact(true), registered: knownFact(false) }, scope.contracts.accountRegistry, false, true);
    registry.source.account = user;
    const passkeyPrediction = f.snapshot({ passkey: { ...passkey, salt: String(passkey.salt) }, accountAddress: knownFact(user) }, scope.contracts.passkeyFactory, false, true); passkeyPrediction.source.account = user;
    return { quickJoin: f.snapshot({ accountRegistry: knownFact(scope.contracts.accountRegistry), passkeyFactory: knownFact(scope.contracts.passkeyFactory), executor: knownFact(scope.contracts.executor) }, scope.contracts.quickJoin), registry,
      ...(mode === 'passkey' ? { passkeyPrediction } : {}) };
  };
  let signs = 0, lastChallenge = '';
  const signing: EnrollmentSigningPorts = {
    async signEoa({ domain, types, message, challenge }) { signs++; lastChallenge = challenge; return signer._signTypedData(domain, types, message); },
    async signPasskey({ challenge }) {
      signs++; lastChallenge = challenge;
      const clientDataJSON = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(ethers.utils.arrayify(challenge)).toString('base64url'), origin: 'https://synthetic.invalid' })));
      return { authenticatorData: '0x' + '00'.repeat(37), clientDataJSON, challengeIndex: '23', typeIndex: '1', r: hash('1'), s: hash('2') };
    },
  };
  return { ...f, request, evidence, signing, signer, get signs() { return signs; }, get challenge() { return lastChallenge; },
    create: (e = evidence(), ports = signing) => createEnrollmentWorkflow(f.host, { read: async () => e }, ports) };
}
describe('atomic enrollment', () => {
  for (const mode of ['eoa', 'passkey'] as const) it(`reviews, explicitly signs and encodes exact ${mode} enrollment with no signed journal bytes`, async () => {
    const f = enrollmentFixture(mode), w = f.create(), review = assertReady(await w.review(f.request));
    expect(f.signs).toBe(0); expect(f.control.approvals).toEqual([]);
    const prepared = assertReady(await w.prepare({ review }));
    expect(f.control.approvals).toEqual(['sign-registration']); expect(f.signs).toBe(1);
    const expected = registrationChallenge({ user: mode === 'eoa' ? f.signer.address : addr('d'), username: f.request.username, nonce: '7', deadline: '1100', chainId: 100, registryAddress: scope.contracts.accountRegistry }, mode);
    expect(f.challenge).toBe(expected);
    const iface = new ethers.utils.Interface(getAbi('QuickJoinNew')), decoded = iface.parseTransaction({ data: prepared.call.data });
    expect(decoded.name).toBe(mode === 'eoa' ? 'registerAndQuickJoin' : 'registerAndQuickJoinWithPasskey');
    const json = JSON.stringify(f.control.database).toLowerCase(); expect(json).not.toContain(prepared.call.data.toLowerCase());
    expect(json).not.toContain('authenticatordata'); expect(json).not.toContain('clientdatajson'); expect(json).not.toContain('credentialid');
    expect((await w.submit({ prepared })).status).toBe('pending'); expect(f.control.approvals).toEqual(['sign-registration', 'send']);
    const event = mode === 'eoa' ? iface.encodeEventLog(iface.getEvent('RegisterAndQuickJoined'), [f.signer.address, f.request.username, []])
      : iface.encodeEventLog(iface.getEvent('RegisterAndQuickJoinedWithPasskey'), [addr('d'), hash('a'), f.request.username, []]);
    f.control.logs = [{ address: scope.contracts.quickJoin, ...event }]; f.control.mined = true;
    expect((await w.recover()).status).toBe('confirmed');
  });
  it('declined registration consent causes zero signing', async () => {
    const f = enrollmentFixture(), w = f.create(), review = assertReady(await w.review(f.request)); f.control.approve = false;
    expect((await w.prepare({ review })).codes).toEqual(['APPROVAL_DECLINED']); expect(f.signs).toBe(0);
  });
  for (const variant of ['unknown-nonce', 'taken', 'registered', 'expired', 'foreign-registry', 'foreign-user'] as const) it(`refuses ${variant} before signing`, async () => {
    const f = enrollmentFixture(), e = f.evidence(), request = { ...f.request };
    if (variant === 'unknown-nonce') e.registry.data.nonce = unknownFact('NONCE_UNAVAILABLE');
    if (variant === 'taken') e.registry.data.usernameAvailable = knownFact(false);
    if (variant === 'registered') e.registry.data.registered = knownFact(true);
    if (variant === 'expired') request.deadline = '999';
    if (variant === 'foreign-registry') e.quickJoin.data.accountRegistry = knownFact(addr('f'));
    if (variant === 'foreign-user') e.registry.data.user = addr('e');
    expect((await f.create(e).review(request)).status).not.toBe('ready'); expect(f.signs).toBe(0); expect(f.control.sends).toBe(0);
  });
  it('refuses an EOA signature for another typed domain', async () => {
    const f = enrollmentFixture(), w = f.create(f.evidence(), { signEoa: async ({ domain, types, message }) => f.signer._signTypedData({ ...domain, chainId: 1 }, types, message) });
    const review = assertReady(await w.review(f.request)); expect((await w.prepare({ review })).codes).toEqual(['REGISTRATION_SIGNATURE_MISMATCH']); expect(f.control.sends).toBe(0);
  });
  it('revalidates nonce after asynchronous registration signing', async () => {
    const f = enrollmentFixture(), e = f.evidence();
    const w = f.create(e, { signEoa: async input => { const signature = await f.signing.signEoa!(input, {}); e.registry.data.nonce = knownFact('8'); return signature; } });
    const review = assertReady(await w.review(f.request)); expect((await w.prepare({ review })).codes).toEqual(['REVIEW_NO_LONGER_CURRENT']); expect(f.control.sends).toBe(0);
  });
  it('verifies passkey target prediction and exact assertion challenge', async () => {
    const f = enrollmentFixture('passkey'), e = f.evidence(); e.passkeyPrediction!.data.accountAddress = knownFact(addr('f'));
    expect((await f.create(e).review(f.request)).status).toBe('unknown');
    const w = f.create(f.evidence(), { signPasskey: async input => {
      const auth = await f.signing.signPasskey!({ ...input, challenge: hash('f') }, {}); return auth;
    } });
    const review = assertReady(await w.review(f.request)); expect((await w.prepare({ review })).codes).toEqual(['PASSKEY_REGISTRATION_CHALLENGE_MISMATCH']);
  });
  it.each(['expiry', 'nonce', 'identity', 'lock'] as const)('revalidates delayed registration consent before signing after %s change', async change => {
    const f = enrollmentFixture(), e = f.evidence();
    f.host.confirm = async () => {
      if (change === 'expiry') f.control.now = 1200;
      if (change === 'nonce') e.registry.data.nonce = knownFact('8');
      if (change === 'identity') f.control.account = addr('f');
      if (change === 'lock') f.control.lockRevoked = true;
      return true;
    };
    const w = f.create(e), review = assertReady(await w.review(f.request));
    expect((await w.prepare({ review })).status).not.toBe('ready'); expect(f.signs).toBe(0); expect(f.control.sends).toBe(0);
  });
  it('accepts the exact bigint salt produced by a passkey credential creator', async () => {
    const f = enrollmentFixture('passkey'), request = f.request as Extract<EnrollmentRequest, { mode: 'passkey' }>;
    request.passkey.salt = (1n << 255n) + 9007199254740993n;
    const read = async (current: Readonly<EnrollmentRequest>) => {
      const e = f.evidence(); e.passkeyPrediction!.data.passkey = { ...(current as Extract<EnrollmentRequest, { mode: 'passkey' }>).passkey,
        salt: String((current as Extract<EnrollmentRequest, { mode: 'passkey' }>).passkey.salt) }; return e;
    };
    const w = createEnrollmentWorkflow(f.host, { read }, f.signing), review = assertReady(await w.review(request));
    const prepared = assertReady(await w.prepare({ review })), decoded = new ethers.utils.Interface(getAbi('QuickJoinNew')).parseTransaction({ data: prepared.call.data });
    expect(decoded.args[0][3].toString()).toBe(request.passkey.salt.toString());
  });
  it('executes atomic passkey enrollment through the shared native sponsored lifecycle', async () => {
    const e = enrollmentFixture('passkey'), f = withSponsored(e);
    const create = () => createEnrollmentWorkflow(f.host, { read: async () => e.evidence() }, e.signing), w = create();
    const prepared = assertReady(await w.prepare({ review: assertReady(await w.review(e.request)) }));
    const pending = await w.submit({ prepared }); expect(pending.status).toBe('pending'); expect((pending.data as any).txHash).toBeUndefined();
    const iface = new ethers.utils.Interface(getAbi('QuickJoinNew')), event = iface.encodeEventLog(iface.getEvent('RegisterAndQuickJoinedWithPasskey'), [addr('d'), hash('a'), e.request.username, []]);
    f.control.logs = [{ address: scope.contracts.quickJoin, ...event }]; f.control.mined = true;
    expect((await create().recover()).status).toBe('confirmed'); expect(f.control.sends).toBe(1);
  });
});
