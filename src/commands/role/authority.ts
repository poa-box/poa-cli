import type { Argv } from 'yargs';
import { ethers } from 'ethers';
import { buildAuthorityAction, AuthorityMethod } from '@poa-box/core/tx/authority';
import { buildGovernanceProposal } from '@poa-box/core/tx/governance';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { requireModule } from '../../lib/resolve';
import { executeTx } from '../../lib/tx';

export interface AuthorityActionSpec {
  method: AuthorityMethod;
  args: (a: any) => unknown[];
  governance?: boolean;
  destructive?: boolean;
  options: Record<string, any>;
}

/** All governance-only verbs are executable proposals; delegates have distinct explicit verbs. */
export function authorityHandler(spec: AuthorityActionSpec) {
  return {
    builder: (y: Argv) => {
      let builder = y.options(spec.options);
      if (spec.governance) builder = builder.option('duration', { type: 'number', default: 60, describe: 'Governance vote duration in minutes' });
      return builder;
    },
    handler: async (argv: any) => {
      const ctx = await getWriteContext(argv);
      const address = requireModule(ctx.modules, 'membershipAuthorityAddress');
      const action = buildAuthorityAction({ authorityAddress: address, method: spec.method, args: spec.args(argv), orgId: ctx.orgId });
      const actionArgs = spec.args(argv).map(arg => ethers.BigNumber.isBigNumber(arg) ? arg.toString() : arg);
      const details = JSON.stringify(actionArgs);
      let proposalTitle = `MembershipAuthority: ${spec.method} ${argv.subject ?? argv.name ?? ''}`.trim();
      while (ethers.utils.toUtf8Bytes(proposalTitle).length > 256) proposalTitle = Array.from(proposalTitle).slice(0, -1).join('');
      let intent = action;
      if (spec.governance) {
        const votingAddress = requireModule(ctx.modules, 'hybridVotingAddress');
        intent = buildGovernanceProposal({
          votingAddress, votingAbiName: 'HybridVotingNew', orgId: ctx.orgId,
          title: proposalTitle, descriptionHash: ethers.constants.HashZero,
          durationMinutes: argv.duration, numOptions: 2, hatIds: [],
          batches: [[{ target: address, value: 0, calldata: new ethers.utils.Interface(action.abi).encodeFunctionData(action.method, action.args) }], []],
          domain: 'role', action: spec.method, summary: { authority: address, args: actionArgs },
        });
      }
      await confirmWrite(argv, { authority: address, action: spec.method, args: details, via: spec.governance ? 'governance proposal' : 'direct authority transaction' },
        { destructive: spec.destructive, actionLabel: spec.method });
      const contract = new ethers.Contract(intent.to, intent.abi, ctx.signer);
      const result = await executeTx(contract, intent.method, intent.args, { dryRun: argv.dryRun });
      finishWrite(result, { successMsg: spec.governance ? 'Authority governance proposal created' : `Authority ${spec.method} completed`,
        fields: { authority: address, subjectId: argv.subject, hatId: argv.subject, method: spec.method,
          proposalId: result.logs?.find(l => l.name === 'NewProposal')?.args?.id?.toString() } });
    },
  };
}
export const subjectOption = { subject: { type: 'string', demandOption: true, describe: 'Authority subject ID (adopted role IDs keep their historical value)' } };
export const userOption = { user: { type: 'string', demandOption: true, describe: 'Member wallet address' } };
export const metadataOptions = {
  name: { type: 'string', demandOption: true, describe: 'Subject name' },
  'metadata-hash': { type: 'string', default: ethers.constants.HashZero, describe: 'IPFS SHA-256 digest (bytes32)' },
  image: { type: 'string', default: '', describe: 'Image URI' },
};
