/**
 * pop org set-metadata-admin — propose changing the org's metadata-admin hat.
 *
 * Gate — VERIFIED against contracts origin/main src/OrgRegistry.sol:
 * setOrgMetadataAdminHat(bytes32 orgId, uint256 hatId) is callable by the
 * registry owner ONLY during bootstrap (OwnerOnlyDuringBootstrap), and by
 * the org's executor afterwards (revert NotOrgExecutor). A live org can
 * therefore only change it through governance, so this command ships as a
 * HybridVoting proposal whose option-0 execution batch calls the OrgRegistry
 * via the executor (same propose-config pattern as task perms propose-global).
 *
 * hatId 0 is meaningful: it clears the override so updateOrgMetaAsAdmin
 * falls back to the org topHat (verified in updateOrgMetaAsAdmin).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract, createReadContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32, formatAddress } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { query } from '../../lib/subgraph';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../queries/infrastructure';
import type { InfrastructureAddresses } from '../../queries/infrastructure';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface SetMetadataAdminArgs {
  org: string;
  hat: string;
  duration: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

/** Parse a --hat argument (decimal or 0x hex) into a BigNumber hat ID. */
function parseHatId(input: string): ethers.BigNumber {
  try {
    return ethers.BigNumber.from(String(input).trim());
  } catch {
    throw new CliError(`Invalid --hat "${input}".`, EXIT.USAGE, 'Pass the hat ID as a decimal or 0x-hex integer (see pop org roles), or 0 to fall back to the topHat.');
  }
}

export const setMetadataAdminHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID that may edit org metadata directly (0 = clear; topHat fallback applies)' })
    .option('duration', { type: 'number', default: 60, describe: 'Vote duration in minutes' })
    .example('pop org set-metadata-admin --hat 123', 'Propose letting hat 123 edit org metadata (1h vote)')
    .example('pop org set-metadata-admin --hat 0 --duration 1440', 'Propose clearing the override (topHat fallback), 24h vote'),

  handler: async (argv: ArgumentsCamelCase<SetMetadataAdminArgs>) => {
    const spin = output.spinner('Building governance proposal...');
    spin.start();

    try {
      const hatId = parseHatId(argv.hat);

      const ctx = await getWriteContext(argv);
      const hybridVotingAddress = ctx.modules.hybridVotingAddress;
      if (!hybridVotingAddress) {
        throw new CliError('HybridVoting not deployed for this org — cannot create a governance proposal.', EXIT.PRECONDITION);
      }

      // OrgRegistry is global infrastructure (not an org module).
      const infra = await query<InfrastructureAddresses>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, argv.chain);
      const orgRegistryAddr = infra.poaManagerContracts?.[0]?.orgRegistryProxy;
      if (!orgRegistryAddr) {
        throw new CliError('Could not resolve OrgRegistry address from subgraph', EXIT.INFRA);
      }

      // Best-effort current-hat read for the confirm summary (never blocks).
      let currentHat: string | undefined;
      try {
        const registry = createReadContract(orgRegistryAddr, 'OrgRegistry', ctx.provider);
        const current = await registry.getOrgMetadataAdminHat(ctx.orgId);
        currentHat = current.toString();
      } catch { /* summary-only */ }

      // setOrgMetadataAdminHat is executor-only after bootstrap, so wrap it
      // in a proposal whose option-0 execution batch calls the OrgRegistry.
      const registryIface = new ethers.utils.Interface(['function setOrgMetadataAdminHat(bytes32 orgId, uint256 hatId)']);
      const setHatCall = registryIface.encodeFunctionData('setOrgMetadataAdminHat', [ctx.orgId, hatId]);
      const batches = [
        [[orgRegistryAddr, ethers.BigNumber.from(0), setHatCall]], // option 0: apply
        [], // option 1: keep current
      ];

      const hatLabel = hatId.isZero() ? '0 (clear — topHat fallback)' : hatId.toString();
      const title = `Set org metadata-admin hat to ${hatId.toString()}`;
      const metadata = {
        description: `Set the org's metadata-admin hat to ${hatLabel} via OrgRegistry.setOrgMetadataAdminHat. Wearers of this hat can update the org name/metadata directly (pop org update-metadata) without a vote.${hatId.isZero() ? ' A value of 0 clears the override so the org topHat is required instead.' : ''}`,
        optionNames: [title, 'Keep current metadata admin'],
        createdAt: Date.now(),
      };

      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        metadataAdminHat: currentHat !== undefined && currentHat !== hatId.toString()
          ? `${currentHat === '0' ? '0 (topHat fallback)' : currentHat} → ${hatLabel}`
          : hatLabel,
        target: `OrgRegistry ${formatAddress(orgRegistryAddr)}`,
        via: `HybridVoting proposal (${argv.duration} min vote)`,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'Propose metadata-admin change' });

      const txSpin = output.spinner('Pinning metadata + creating proposal...');
      txSpin.start();
      const cid = await pinJson(JSON.stringify(metadata));
      const descriptionHash = ipfsCidToBytes32(cid);
      const titleBytes = stringToBytes(title);

      const voting = createWriteContract(hybridVotingAddress, 'HybridVotingNew', ctx.signer);
      const result = await executeTx(
        voting,
        'createProposal',
        [titleBytes, descriptionHash, argv.duration, 2, batches, []],
        { dryRun: argv.dryRun }
      );
      txSpin.stop();

      const proposalEvent = result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal');
      const proposalId = proposalEvent?.args?.id?.toString();

      finishWrite(result, {
        successMsg: proposalId !== undefined
          ? `Proposal #${proposalId} created — needs a vote to take effect`
          : 'Proposal created — needs a vote to take effect',
        fields: {
          proposalId,
          hatId: hatId.toString(),
          currentHatId: currentHat,
          orgRegistry: orgRegistryAddr,
          duration: `${argv.duration} minutes`,
          ipfsCid: cid,
          nextStep: `pop vote cast --proposal ${proposalId ?? '<id>'} --choice 0`,
        },
      });
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err?.message || String(err));
      process.exit(EXIT.USAGE);
    }
  },
};
