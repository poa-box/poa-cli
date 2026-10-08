/** Native authority deployment. Dry runs prepare unsigned calldata without pinning or signing. */
import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import fs from 'fs';
import { createWriteContract, createReadContract, getAbi } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { ipfsCidToBytes32 } from '../../lib/encoding';
import { query } from '../../lib/subgraph';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { getNetworkByChainId } from '../../config/networks';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../queries/infrastructure';
import type { InfrastructureAddresses } from '../../queries/infrastructure';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { buildDeploymentParams, deriveOrgId, signRegisterAccount, validateOrgDeployConfig, requireAuthorityDeployerVersion, DEPLOY_FULL_ORG_GAS_LIMIT } from '@poa-box/core/tx/org';
import type { OrgDeployConfig } from '@poa-box/core/tx/org';
import { buildOrgDeployMetadata, serializeOrgMetadata } from '@poa-box/core/metadata/org';

interface DeployArgs {
  config: string;
  deployer?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

export const deployHandler = {
  builder: (yargs: Argv) => yargs
    .option('config', { type: 'string', demandOption: true, describe: 'Path to native authority org deploy config JSON file' })
    .option('deployer', { type: 'string', describe: 'Public deployer address for an unsigned dry run (no private key needed)' })
    .example('pop org deploy --config org-deploy-config.json', 'Deploy a native authority organization')
    .example('pop org deploy --config org.json --dry-run --deployer 0xYourAddress', 'Validate and preview unsigned calldata without publishing or signing'),

  handler: async (argv: ArgumentsCamelCase<DeployArgs>) => {
    const spin = output.spinner('Preparing organization deployment...');
    spin.start();
    try {
      if (!fs.existsSync(argv.config)) throw new CliError(`Config file not found: ${argv.config}`, EXIT.USAGE, 'Generate one with: pop org deploy-config --name "My Org" --username me');
      let config: OrgDeployConfig;
      try { config = JSON.parse(fs.readFileSync(argv.config, 'utf-8')); }
      catch (err: any) { throw new CliError(`Config file is not valid JSON: ${err?.message}`, EXIT.USAGE); }
      validateOrgDeployConfig(config);
      const { orgId, normalizedName } = deriveOrgId(config.orgName);
      const deployerUsername = config.deployerUsername || normalizedName;
      const metadata = buildOrgDeployMetadata(config);
      // Encode once with placeholders before any network work to reject malformed ABI inputs.
      const placeholders = {
        orgId, metadataHash: ethers.constants.HashZero, registryAddr: ethers.constants.AddressZero,
        deployerAddress: ethers.constants.AddressZero, deployerUsername: '', regDeadline: 0, regNonce: 0, regSignature: '0x',
      };
      const iface = new ethers.utils.Interface(getAbi('OrgDeployerNew'));
      iface.encodeFunctionData('deployFullOrg', [buildDeploymentParams(config, placeholders)]);
      const txValue = config.paymaster?.funding ? ethers.utils.parseEther(config.paymaster.funding) : undefined;
      if (txValue?.lt(0)) throw new CliError('Paymaster funding must not be negative', EXIT.USAGE);
      if (argv.deployer && !argv.dryRun) throw new CliError('--deployer is only for unsigned dry runs; real deployments use the signer address', EXIT.USAGE);
      if (argv.deployer && !ethers.utils.isAddress(argv.deployer)) throw new CliError('Invalid --deployer address', EXIT.USAGE);
      const ctx = argv.dryRun && argv.deployer ? null : await getWriteContext(argv, { needsOrg: false });
      const address = argv.deployer || ctx!.address;
      if (address === ethers.constants.AddressZero) throw new CliError('Deployer address must be nonzero', EXIT.USAGE);
      const chainId = ctx?.chainId ?? argv.chain ?? 100;
      const infra = await query<InfrastructureAddresses>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, chainId);
      const orgDeployerAddr = infra.poaManagerContracts?.[0]?.orgDeployerProxy;
      const registryAddr = infra.poaManagerContracts?.[0]?.globalAccountRegistryProxy;
      if (!orgDeployerAddr) throw new CliError('Could not resolve OrgDeployer address', EXIT.INFRA);
      if (!registryAddr) throw new CliError('Could not resolve UniversalAccountRegistry address', EXIT.INFRA);
      if (argv.dryRun) {
        const params = buildDeploymentParams(config, { ...placeholders, registryAddr, deployerAddress: address });
        spin.stop();
        output.success('DRY RUN — unsigned deployment preview', {
          method: 'deployFullOrg', to: orgDeployerAddr, orgId, orgName: config.orgName,
          metadataCid: null, gasUsed: null, gasEstimate: null, dryRun: true,
          calldata: iface.encodeFunctionData('deployFullOrg', [params]), value: txValue?.toString() ?? '0',
          metadata, deployerUsername, requiresRegistrationSignature: true,
          deployerCompatibility: 'unverified unsigned preview',
          note: 'Preview uses zero metadata hash and skips registration. Execution pins metadata and signs registration before gas estimation.',
        });
        return;
      }
      requireAuthorityDeployerVersion(await createReadContract(orgDeployerAddr, 'OrgDeployerNew', ctx!.provider).VERSION());
      spin.stop();
      await confirmWrite(argv, {
        org: config.orgName, orgId, chain: ctx!.networkName, deployer: `${address} (@${deployerUsername})`,
        roles: `${config.roles.length} (${config.roles.map(r => r.name).join(', ')})`,
        groups: (config.groups || []).length,
        votingClasses: config.hybridVoting.classes.map(c => `${c.strategy} ${c.slicePct}%`).join(' + '),
        paymasterFunding: config.paymaster?.funding ? `${config.paymaster.funding} ${getNetworkByChainId(chainId)?.nativeCurrency.symbol ?? 'ETH'}` : undefined,
        autoUpgrade: String(config.autoUpgrade ?? true),
      }, { destructive: true, actionLabel: 'About to DEPLOY a new organization' });
      // Only an actual, confirmed execution publishes metadata and signs account registration.
      const metaCid = await pinJson(serializeOrgMetadata(metadata));
      const registry = createReadContract(registryAddr, 'UniversalAccountRegistry', ctx!.provider);
      const regNonce = await registry.nonces(address);
      const regDeadline = Math.floor(Date.now() / 1000) + 900;
      const regSignature = await signRegisterAccount(ctx!.signer, { registryAddress: registryAddr, chainId, user: address, username: deployerUsername, nonce: regNonce, deadline: regDeadline });
      const params = buildDeploymentParams(config, { orgId, metadataHash: ipfsCidToBytes32(metaCid), registryAddr, deployerAddress: address, deployerUsername, regDeadline, regNonce, regSignature });
      const contract = createWriteContract(orgDeployerAddr, 'OrgDeployerNew', ctx!.signer);
      await runPreflight(ctx!.provider, [checkGasBalance(address, txValue ? txValue.add(ethers.utils.parseEther('0.0001')) : undefined)], { skip: !argv.preflight });
      const result = await executeTx(contract, 'deployFullOrg', [params], { dryRun: false, gasLimit: DEPLOY_FULL_ORG_GAS_LIMIT, value: txValue });
      finishWrite(result, {
        successMsg: 'Organization deployed',
        fields: { orgId, orgName: config.orgName, metadataCid: metaCid, gasUsed: result.gasUsed, nextStep: `pop org status --org ${orgId}` },
      });
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) { output.error(err.message, { suggestion: err.suggestion }); process.exit(err.code); }
      output.error(err?.message || String(err));
      process.exit(EXIT.USAGE);
    }
  },
};
