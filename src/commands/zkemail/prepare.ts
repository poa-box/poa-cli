import type { Argv, ArgumentsCamelCase } from 'yargs';
import { buildEmailClaimCommand, buildCircuitInputHints, projectGroth16Proof } from '@poa-box/core/email/proof';
import { buildClaimRoleByDomain, buildClaimRoleByEmail, buildRegisterAndClaimByDomainWithPasskey, buildRegisterAndClaimByEmailWithPasskey } from '@poa-box/core/tx/zkemail';
import { verifyAllowlistDocument, projectVerifiedAllowlistLeaves, replaceVerifiedAllowlist } from '@poa-box/core/email/allowlist';
import { pendingEmailRestartGuidance } from '@poa-box/core/email/recovery';
import { projectInviteState } from '@poa-box/core/reads/zkemail';
import { readPreparedInput, preparedIntentOutput } from '../user/prepare';
import * as output from '../../lib/output';
import { EXIT } from '../../lib/exit-codes';

export function prepareEmailAction(action: string, input: Record<string, any>): unknown {
  if (action === 'claim-command') return { command: buildEmailClaimCommand(input.claimer) };
  if (action === 'circuit-hints') return buildCircuitInputHints(input as any);
  if (action === 'restart-guidance') return pendingEmailRestartGuidance();
  if (action === 'invite-state') {
    const document = input.document === undefined ? undefined
      : verifyAllowlistDocument(input.document, { orgId: input.scope?.orgId, root: input.currentRoot });
    return { prepared: true, broadcast: false, liveAuthorizationVerified: false,
      projection: projectInviteState({ ...input, document } as any) };
  }
  if (action === 'replace-allowlist') {
    const current = verifyAllowlistDocument(input.current, { orgId: input.orgId, root: input.currentRoot });
    const leaves = projectVerifiedAllowlistLeaves(current);
    if (!Array.isArray(input.retained)) throw new Error('retained must explicitly select the whole final retained set');
    const retained = input.retained.map((row: any) => {
      if (!row || !Number.isSafeInteger(row.index) || row.index < 0 || row.index >= leaves.length) throw new Error('Invalid retained leaf index');
      return { leaf: leaves[row.index], ...(row.hatIds !== undefined ? { hatIds: row.hatIds } : {}) };
    });
    const next = replaceVerifiedAllowlist({ orgId: input.orgId, currentRoot: input.currentRoot, current, retained, additions: input.additions });
    return { prepared: true, broadcast: false, merkleRoot: next.root, document: next.doc, serialized: next.json };
  }
  if (!['claim-domain', 'claim-email', 'register-and-claim-domain-passkey', 'register-and-claim-email-passkey'].includes(action)) {
    throw new Error(`Unsupported email preparation: ${action}`);
  }
  const version = action.includes('domain') ? 'v1' : 'v2';
  const proof = projectGroth16Proof({ version, claimer: input.claimer, proof: input.proof, publicSignals: input.publicSignals });
  const args = { ...input, proof };
  const intent = action === 'claim-domain' ? buildClaimRoleByDomain(args as any)
    : action === 'claim-email' ? buildClaimRoleByEmail(args as any)
    : action === 'register-and-claim-domain-passkey' ? buildRegisterAndClaimByDomainWithPasskey(args as any)
    : buildRegisterAndClaimByEmailWithPasskey(args as any);
  return { ...preparedIntentOutput(intent), proofCryptographicallyVerified: false };
}

export const prepareHandler = {
  builder: (yargs: Argv) => yargs
    .positional('action', { choices: ['claim-command', 'circuit-hints', 'claim-domain', 'claim-email', 'register-and-claim-domain-passkey', 'register-and-claim-email-passkey', 'replace-allowlist', 'invite-state', 'restart-guidance'] as const })
    .option('file', { type: 'string', demandOption: true, describe: 'JSON prepared proof, signed header, verified allowlist edit, or explicit invite-state fact snapshots' })
    .example('pop zkemail prepare invite-state --file invite-evidence.json --json', 'Project supplied invitation evidence; collect no live authorization')
    .epilogue('Local preparation only. Invite-state validates supplied evidence and remains liveAuthorizationVerified:false; it collects no current DKIM, authority, verifier or sponsorship facts. Proof generation/DKIM verification and credential authentication belong to the host. Retained allowlist rows select indexes from the verified current document; omitted rows are removed.'),
  handler: async (argv: ArgumentsCamelCase<{ action: string; file: string }>) => {
    try { output.json(prepareEmailAction(argv.action, readPreparedInput(argv.file))); }
    catch (err: any) { output.error(err?.message || String(err)); process.exit(EXIT.USAGE); }
  },
};
