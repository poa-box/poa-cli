/**
 * Calldata parity — intent builders vs the CLI's historical encoding recipe.
 *
 * Each case hand-builds calldata exactly the way the CLI command did before
 * the extraction (same ABI fragment, same arg construction) and asserts the
 * intent builder produces byte-identical calldata. A mismatch here means a
 * consumer following the README would broadcast different bytes than the CLI
 * — the one bug class this package must never ship.
 */

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { encodeIntent } from '../src/tx/intent';
import { getAbi } from '../src/contracts';
import { stringToBytes, ipfsCidToBytes32 } from '../src/encoding';
import { buildCreateTask, buildClaimTask, buildSubmitTask } from '../src/tx/task';
import { buildVote, buildAnnounceWinner } from '../src/tx/vote';
import { buildGovernanceProposal, encodeExecutorCall } from '../src/tx/governance';
import { buildRequestTokens } from '../src/tx/token';
import { buildAuthorityAction } from '../src/tx/authority';
import { buildClaimDistribution } from '../src/tx/treasury';

const TM = '0x00000000000000000000000000000000000000a1';
const VOTING = '0x00000000000000000000000000000000000000b2';
const PT = '0x00000000000000000000000000000000000000c3';
const ELIG = '0x00000000000000000000000000000000000000d4';
const PM = '0x00000000000000000000000000000000000000e5';
const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

describe('calldata parity with the CLI recipes', () => {
  it('task create — v6 9-arg createTask', () => {
    const payoutWei = ethers.utils.parseUnits('25', 18);
    const title = stringToBytes('Write docs');
    const metadataHash = ipfsCidToBytes32(CID);
    const pid = ethers.utils.hexZeroPad('0x01', 32);

    const intent = buildCreateTask({
      taskManagerAddress: TM,
      features: { deadlines: true },
      payout: 25,
      title: 'Write docs',
      metadataHash: CID,
      projectId: pid,
      requiresApplication: false,
      absoluteDeadline: 0,
      completionWindow: 0,
    });

    const iface = new ethers.utils.Interface(getAbi('TaskManagerNew'));
    const expected = iface.encodeFunctionData('createTask', [
      payoutWei, title, metadataHash, pid,
      ethers.constants.AddressZero, 0, false, 0, 0,
    ]);
    expect(encodeIntent(intent).data).toBe(expected);
    expect(intent.to).toBe(TM);
  });

  it('rejects the removed seven-argument task signature', () => {
    expect(() => buildCreateTask({ taskManagerAddress: TM, features: { deadlines: false },
      payout: 10, title: 'Unsupported', metadataHash: CID, projectId: ethers.constants.HashZero })).toThrow('Unsupported TaskManager');
  });

  it('task claim / submit', () => {
    const iface = new ethers.utils.Interface(getAbi('TaskManagerNew'));
    const submissionHash = ipfsCidToBytes32(CID);

    expect(encodeIntent(buildClaimTask({ taskManagerAddress: TM, taskId: 7 })).data)
      .toBe(iface.encodeFunctionData('claimTask', [7]));
    expect(encodeIntent(buildSubmitTask({ taskManagerAddress: TM, taskId: 7, submissionHash })).data)
      .toBe(iface.encodeFunctionData('submitTask', [7, submissionHash]));
  });

  it('vote cast — hybrid two-class weights', () => {
    const iface = new ethers.utils.Interface(getAbi('HybridVotingNew'));
    const intent = buildVote({
      votingAddress: VOTING,
      votingAbiName: 'HybridVotingNew',
      proposalId: 3,
      optionIndices: [0],
      weights: [100],
    });
    expect(encodeIntent(intent).data)
      .toBe(iface.encodeFunctionData('vote', [3, [0], [100]]));
  });

  it('vote announce', () => {
    const iface = new ethers.utils.Interface(getAbi('HybridVotingNew'));
    const intent = buildAnnounceWinner({ votingAddress: VOTING, votingAbiName: 'HybridVotingNew', proposalId: 5 });
    expect(encodeIntent(intent).data).toBe(iface.encodeFunctionData('announceWinner', [5]));
  });

  it('governance wrap — createProposal with an executor setConfig batch', () => {
    // The CLI encoded the inner call with an inline `setConfig(uint8,bytes)`
    // fragment; encodeExecutorCall uses the full ABI — must be byte-identical.
    const quorumBytes = ethers.utils.defaultAbiCoder.encode(['uint8'], [60]);
    const call = encodeExecutorCall('HybridVotingNew', VOTING, 'setConfig', [4, quorumBytes]);

    const inline = new ethers.utils.Interface(['function setConfig(uint8 key, bytes value)']);
    expect(call.calldata).toBe(inline.encodeFunctionData('setConfig', [4, quorumBytes]));

    const intent = buildGovernanceProposal({
      votingAddress: VOTING,
      votingAbiName: 'HybridVotingNew',
      title: 'Set quorum to 60%',
      descriptionHash: ipfsCidToBytes32(CID),
      durationMinutes: 1440,
      numOptions: 2,
      batches: [[call], []],
    });

    const iface = new ethers.utils.Interface(getAbi('HybridVotingNew'));
    const expected = iface.encodeFunctionData('createProposal', [
      stringToBytes('Set quorum to 60%'),
      ipfsCidToBytes32(CID),
      1440,
      2,
      [[[call.target, ethers.BigNumber.from(0), call.calldata]], []],
      [],
    ]);
    expect(encodeIntent(intent).data).toBe(expected);
  });

  it('token request', () => {
    // requestTokens(uint96, string ipfsHash) takes the RAW CID string — the
    // CLI pins {reason, submittedAt} and passes pinJson's Qm… straight
    // through, with no bytes32 conversion (unlike task/role metadata hashes).
    const iface = new ethers.utils.Interface(getAbi('ParticipationToken'));
    const amount = ethers.utils.parseUnits('5', 18);
    const intent = buildRequestTokens({
      participationTokenAddress: PT,
      amountWei: amount,
      ipfsHash: CID,
    });
    expect(encodeIntent(intent).data)
      .toBe(iface.encodeFunctionData('requestTokens', [amount, CID]));
  });

  it('vouch for', () => {
    const iface = new ethers.utils.Interface(getAbi('MembershipAuthority'));
    const wearer = '0x00000000000000000000000000000000000000f6';
    const intent = buildAuthorityAction({ authorityAddress: ELIG, method: 'vouch', args: [1n, wearer] });
    expect(encodeIntent(intent).data)
      .toBe(iface.encodeFunctionData('vouch', [1n, wearer]));
  });

  it('treasury claim distribution', () => {
    const iface = new ethers.utils.Interface(getAbi('PaymentManager'));
    const proof = [ethers.utils.hexZeroPad('0xaa', 32)];
    const amount = ethers.utils.parseUnits('12', 18);
    const intent = buildClaimDistribution({
      paymentManagerAddress: PM,
      distributionId: 2,
      amountWei: amount,
      proof,
    });
    expect(encodeIntent(intent).data)
      .toBe(iface.encodeFunctionData('claimDistribution', [2, amount, proof]));
  });
});
