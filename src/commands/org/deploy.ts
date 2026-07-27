/**
 * pop org deploy — deploy a full organization from a config file (DESTRUCTIVE).
 *
 * The flow performs several network side-effects but EXACTLY ONE transaction:
 *   1. IPFS pin of the org metadata (not a tx)
 *   2. UniversalAccountRegistry.nonces() read + local EIP-712 signature
 *      (registration happens INSIDE deployFullOrg via that signature — it is
 *      not a separate tx; verified against contracts origin/main
 *      src/OrgDeployer.sol deployFullOrg(DeploymentParams))
 *   3. OrgDeployer.deployFullOrg(params) — the single on-chain write, which
 *      internally deploys every org module.
 *
 * --dry-run therefore fires ZERO transactions: executeTx only runs
 * estimateGas and returns the calldata. The destructive confirmation (org
 * name, chain, roles, voting classes, estimated cost when computable) is
 * shown BEFORE that single tx; non-TTY sessions must pass --yes.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract, createReadContract } from '../../lib/contracts';
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
import fs from 'fs';

interface DeployArgs {
  config: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

/**
 * Org deploy config file schema.
 * Matches the DeploymentParams struct expected by OrgDeployer.deployFullOrg()
 */
interface OrgDeployConfig {
  orgName: string;
  deployerUsername?: string;
  description?: string;
  links?: Array<{ name: string; url: string }>;
  autoUpgrade?: boolean;
  hybridVoting: {
    thresholdPct: number;
    classes: Array<{
      strategy: 'DIRECT' | 'ERC20_BAL';
      slicePct: number;
      quadratic?: boolean;
      minBalance?: string;
      asset?: string;
      hatIds?: number[];
    }>;
  };
  directDemocracy: {
    thresholdPct: number;
  };
  roles: Array<{
    name: string;
    image?: string;
    canVote: boolean;
    vouching?: {
      enabled: boolean;
      quorum: number;
      voucherRoleIndex: number;
      combineWithHierarchy?: boolean;
    };
    defaults?: {
      eligible: boolean;
      standing: boolean;
    };
    hierarchy?: {
      adminRoleIndex: number;
    };
    distribution?: {
      mintToDeployer: boolean;
      additionalWearers?: string[];
    };
    hatConfig?: {
      maxSupply: number;
      mutableHat: boolean;
    };
  }>;
  roleAssignments: {
    quickJoinRoles: number[];
    tokenMemberRoles: number[];
    tokenApproverRoles: number[];
    taskCreatorRoles: number[];
    educationCreatorRoles?: number[];
    educationMemberRoles?: number[];
    hybridProposalCreatorRoles: number[];
    ddVotingRoles: number[];
    ddCreatorRoles: number[];
  };
  metadataAdminRoleIndex?: number;
  educationHub?: { enabled: boolean };
  paymaster?: {
    operatorRoleIndex: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    defaultBudgetCapPerEpoch: string;
    defaultBudgetEpochLen: number;
    funding?: string;
  };
  /**
   * Optional org-wide TaskManager ROLE_PERM grants applied at deploy time
   * (OrgDeployer.TaskManagerPermConfig — roleIndices resolve to hat IDs,
   * masks are TaskPerm bitmasks: 1=create 2=claim 4=review 8=assign …).
   */
  taskManagerPerms?: {
    roleIndices: number[];
    masks: number[];
  };
}

function indicesToBitmap(indices: number[]): ethers.BigNumber {
  let bitmap = ethers.BigNumber.from(0);
  for (const i of indices) {
    bitmap = bitmap.or(ethers.BigNumber.from(1).shl(i));
  }
  return bitmap;
}

export const deployHandler = {
  builder: (yargs: Argv) => yargs
    .option('config', {
      type: 'string',
      demandOption: true,
      describe: 'Path to org deploy config JSON file',
    })
    .example('pop org deploy --config org-deploy-config.json', 'Deploy an org (shows a summary and asks for confirmation)')
    .example('pop org deploy --config org.json --dry-run --yes', 'Validate the config and estimate gas — no transaction is sent'),

  handler: async (argv: ArgumentsCamelCase<DeployArgs>) => {
    const spin = output.spinner('Preparing organization deployment...');
    spin.start();

    try {
      // ── Fail fast on config problems before any network work ───────────
      const configPath = argv.config;
      if (!fs.existsSync(configPath)) {
        throw new CliError(`Config file not found: ${configPath}`, EXIT.USAGE, 'Generate one with: pop org deploy-config --name "My Org" --username me');
      }
      let config: OrgDeployConfig;
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (parseErr: any) {
        throw new CliError(`Config file is not valid JSON: ${parseErr?.message}`, EXIT.USAGE);
      }

      if (!config.orgName) throw new CliError('Config missing: orgName', EXIT.USAGE);
      if (!config.roles?.length) throw new CliError('Config missing: roles', EXIT.USAGE);
      if (!config.hybridVoting) throw new CliError('Config missing: hybridVoting', EXIT.USAGE);

      // No org module resolution — the org does not exist yet.
      const ctx = await getWriteContext(argv, { needsOrg: false });
      const { signer, address } = ctx;

      // Resolve infrastructure addresses
      spin.text = 'Resolving infrastructure addresses...';
      const infra = await query<InfrastructureAddresses>(
        FETCH_INFRASTRUCTURE_ADDRESSES,
        {},
        argv.chain
      );

      const orgDeployerAddr = infra.poaManagerContracts?.[0]?.orgDeployerProxy;
      const registryAddr = infra.poaManagerContracts?.[0]?.globalAccountRegistryProxy;
      if (!orgDeployerAddr) throw new CliError('Could not resolve OrgDeployer address', EXIT.INFRA);
      if (!registryAddr) throw new CliError('Could not resolve UniversalAccountRegistry address', EXIT.INFRA);

      // Generate orgId: keccak256(orgName.toLowerCase().replace(/\s+/g, '-'))
      const normalizedName = config.orgName.toLowerCase().replace(/\s+/g, '-');
      const deployerUsername = config.deployerUsername || normalizedName;
      const orgId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(normalizedName));

      // Upload org metadata to IPFS
      spin.text = 'Pinning org metadata to IPFS...';
      const metadata = {
        description: config.description || '',
        links: (config.links || []).map((l, i) => ({ ...l, index: i })),
        template: 'default',
        logo: null,
        backgroundColor: null,
        hideTreasury: false,
      };
      const metaCid = await pinJson(JSON.stringify(metadata));
      const metadataHash = ipfsCidToBytes32(metaCid);

      // Get registration nonce for deployer
      spin.text = 'Getting registration nonce...';
      const registryContract = createReadContract(registryAddr, 'UniversalAccountRegistry', ctx.provider);
      const regNonce = await registryContract.nonces(address);
      // 15 min validity: the signature must survive the interactive
      // confirmation prompt below (it is nonce-bound, so a longer window is
      // not replayable).
      const regDeadline = Math.floor(Date.now() / 1000) + 900;

      // Sign EIP-712 registration message
      spin.text = 'Signing registration...';
      const domain = {
        name: 'UniversalAccountRegistry',
        version: '1',
        chainId: ctx.chainId,
        verifyingContract: registryAddr,
      };
      const types = {
        RegisterAccount: [
          { name: 'user', type: 'address' },
          { name: 'username', type: 'string' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      };
      const regMessage = {
        user: address,
        username: deployerUsername,
        nonce: regNonce.toString(),
        deadline: regDeadline,
      };
      const regSignature = await signer._signTypedData(domain, types, regMessage);

      // Build hybrid voting classes
      // ABI: strategy(uint8), slicePct(uint8), quadratic(bool), minBalance(uint256), asset(address), hatIds(uint256[])
      const hybridClasses = config.hybridVoting.classes.map((c) => [
        c.strategy === 'DIRECT' ? 0 : 1,       // uint8
        c.slicePct,                              // uint8 (0-100)
        c.quadratic || false,                    // bool
        c.minBalance ? ethers.utils.parseUnits(c.minBalance, 18) : 0, // uint256
        c.asset || ethers.constants.AddressZero, // address
        c.hatIds || [],                          // uint256[]
      ]);

      // Build role configs
      // ABI: name(string), image(string), metadataCID(bytes32), canVote(bool),
      //      vouching(tuple), defaults(tuple), hierarchy(tuple), distribution(tuple), hatConfig(tuple)
      const MAX_UINT32 = 4294967295; // 2^32 - 1
      const roles = config.roles.map((r) => [
        r.name,                                  // string
        r.image || '',                           // string
        ethers.constants.HashZero,               // bytes32 metadataCID
        r.canVote,                               // bool
        [ // vouching: enabled(bool), quorum(uint32), voucherRoleIndex(uint256), combineWithHierarchy(bool)
          r.vouching?.enabled || false,
          r.vouching?.quorum || 0,
          r.vouching?.voucherRoleIndex ?? ethers.constants.MaxUint256,
          r.vouching?.combineWithHierarchy || false,
        ],
        [ // defaults: eligible(bool), standing(bool)
          r.defaults?.eligible ?? true,
          r.defaults?.standing ?? true,
        ],
        [ // hierarchy: adminRoleIndex(uint256)
          r.hierarchy?.adminRoleIndex ?? ethers.constants.MaxUint256,
        ],
        [ // distribution: mintToDeployer(bool), additionalWearers(address[])
          r.distribution?.mintToDeployer ?? true,
          r.distribution?.additionalWearers || [],
        ],
        [ // hatConfig: maxSupply(uint32), mutableHat(bool)
          r.hatConfig?.maxSupply ?? MAX_UINT32,  // uint32, NOT uint256
          r.hatConfig?.mutableHat ?? true,
        ],
      ]);

      // Build role assignment bitmaps
      const ra = config.roleAssignments;
      const roleAssignments = [
        indicesToBitmap(ra.quickJoinRoles),
        indicesToBitmap(ra.tokenMemberRoles),
        indicesToBitmap(ra.tokenApproverRoles),
        indicesToBitmap(ra.taskCreatorRoles),
        indicesToBitmap(ra.educationCreatorRoles || []),
        indicesToBitmap(ra.educationMemberRoles || []),
        indicesToBitmap(ra.hybridProposalCreatorRoles),
        indicesToBitmap(ra.ddVotingRoles),
        indicesToBitmap(ra.ddCreatorRoles),
      ];

      // Build paymaster config
      // ABI: operatorRoleIndex(uint256), autoWhitelistContracts(bool),
      //      maxFeePerGas(uint256), maxPriorityFeePerGas(uint256),
      //      maxCallGas(uint32), maxVerificationGas(uint32), maxPreVerificationGas(uint32),
      //      defaultBudgetCapPerEpoch(uint128), defaultBudgetEpochLen(uint32)
      const pm = config.paymaster;
      const paymasterConfig = pm ? [
        pm.operatorRoleIndex,                                    // uint256
        true,                                                    // bool
        ethers.utils.parseUnits(pm.maxFeePerGas, 'gwei'),       // uint256
        ethers.utils.parseUnits(pm.maxPriorityFeePerGas, 'gwei'), // uint256
        500000,                                                  // uint32 maxCallGas
        500000,                                                  // uint32 maxVerificationGas
        100000,                                                  // uint32 maxPreVerificationGas
        ethers.utils.parseEther(pm.defaultBudgetCapPerEpoch),   // uint128
        pm.defaultBudgetEpochLen,                                // uint32
      ] : [
        ethers.constants.MaxUint256, // operatorRoleIndex = MaxUint256 disables paymaster
        false,                       // autoWhitelistContracts
        0,                           // maxFeePerGas
        0,                           // maxPriorityFeePerGas
        0,                           // maxCallGas
        0,                           // maxVerificationGas
        0,                           // maxPreVerificationGas
        0,                           // defaultBudgetCapPerEpoch
        0,                           // defaultBudgetEpochLen
      ];

      // Optional org-wide TaskManager ROLE_PERM grants
      // (OrgDeployer.TaskManagerPermConfig: roleIndices[] + masks[] — empty
      // arrays skip the bootstrapGlobalPerms step entirely; verified against
      // contracts origin/main src/OrgDeployer.sol).
      const tmPerms = config.taskManagerPerms;
      if (tmPerms && (tmPerms.roleIndices?.length || 0) !== (tmPerms.masks?.length || 0)) {
        throw new CliError(
          'Config invalid: taskManagerPerms.roleIndices and taskManagerPerms.masks must be the same length.',
          EXIT.USAGE
        );
      }
      const taskManagerPerms = [
        tmPerms?.roleIndices || [], // uint256[] roleIndices
        tmPerms?.masks || [],       // uint8[] masks
      ];

      // Build the full DeploymentParams struct
      // ABI field order (verified against src/abi/OrgDeployerNew.json +
      // contracts origin/main src/OrgDeployer.sol DeploymentParams):
      //   orgId, orgName, metadataHash, registryAddr, deployerAddress,
      //   deployerUsername, regDeadline, regNonce, regSignature, autoUpgrade,
      //   hybridThresholdPct, ddThresholdPct, hybridClasses, ddInitialTargets,
      //   roles, roleAssignments, metadataAdminRoleIndex, passkeyEnabled,
      //   educationHubConfig, bootstrap, paymasterConfig, taskManagerPerms
      const deployParams = [
        orgId,                                                   // bytes32
        config.orgName,                                          // string
        metadataHash,                                            // bytes32
        registryAddr,                                            // address
        address,                                                 // address deployerAddress
        deployerUsername,                                             // string deployerUsername
        regDeadline,                                             // uint256
        regNonce,                                                // uint256
        regSignature,                                            // bytes
        config.autoUpgrade ?? true,                              // bool
        config.hybridVoting.thresholdPct,                        // uint8
        config.directDemocracy?.thresholdPct || 51,              // uint8
        hybridClasses,                                           // ClassConfig[]
        [],                                                      // address[] ddInitialTargets
        roles,                                                   // RoleConfig[]
        roleAssignments,                                         // RoleAssignments struct
        config.metadataAdminRoleIndex ?? ethers.constants.MaxUint256, // uint256
        true,                                                    // bool passkeyEnabled
        [config.educationHub?.enabled ?? true],                  // EducationHubConfig struct
        [[], []],                                                // BootstrapConfig struct (projects, tasks)
        paymasterConfig,                                         // PaymasterConfig struct
        taskManagerPerms,                                        // TaskManagerPermConfig struct (roleIndices, masks)
      ];

      const contract = createWriteContract(orgDeployerAddr, 'OrgDeployerNew', signer);
      const txValue = pm?.funding ? ethers.utils.parseEther(pm.funding) : undefined;

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      // When the paymaster is being funded, the wallet must cover the
      // funding value on top of gas.
      await runPreflight(ctx.provider, [
        checkGasBalance(address, txValue ? txValue.add(ethers.utils.parseEther('0.0001')) : undefined),
      ], { skip: !argv.preflight });

      // Estimated cost, when computable (a failing estimate is NOT fatal
      // here — executeTx re-estimates and surfaces the decoded revert).
      spin.text = 'Estimating deployment cost...';
      let estimatedCost: string | undefined;
      try {
        // Sequential awaits (not Promise.all) so a synchronous throw from
        // either call can never leave the other promise floating.
        const gasEstimate = await contract.estimateGas.deployFullOrg(deployParams, { value: txValue });
        const gasPrice = await ctx.provider.getGasPrice();
        const symbol = getNetworkByChainId(ctx.chainId)?.nativeCurrency.symbol ?? 'ETH';
        const cost = ethers.utils.formatEther(gasEstimate.mul(gasPrice));
        estimatedCost = `~${Number(cost).toFixed(6)} ${symbol} (${gasEstimate.toString()} gas)`;
      } catch { /* not computable — the summary simply omits it */ }
      spin.stop();

      // ── DESTRUCTIVE confirmation BEFORE the one and only tx ───────────
      const classesLabel = config.hybridVoting.classes
        .map(c => `${c.strategy} ${c.slicePct}%${c.quadratic ? ' quadratic' : ''}`)
        .join(' + ');
      await confirmWrite(argv, {
        org: config.orgName,
        orgId,
        chain: ctx.networkName,
        deployer: `${address} (@${deployerUsername})`,
        roles: `${config.roles.length} (${config.roles.map(r => r.name).join(', ')})`,
        votingClasses: `${classesLabel} — threshold ${config.hybridVoting.thresholdPct}%`,
        paymasterFunding: pm?.funding
          ? `${pm.funding} ${getNetworkByChainId(ctx.chainId)?.nativeCurrency.symbol ?? 'ETH'}`
          : undefined,
        autoUpgrade: String(config.autoUpgrade ?? true),
        estimatedCost,
      }, { destructive: true, actionLabel: 'About to DEPLOY a new organization (deploys every module; cannot be undone)' });

      // Single on-chain write. --dry-run stops inside executeTx at the gas
      // estimate — zero transactions are sent.
      const txSpin = output.spinner('Sending deploy transaction...');
      txSpin.start();
      const result = await executeTx(
        contract,
        'deployFullOrg',
        [deployParams],
        { dryRun: argv.dryRun, gasLimit: 15000000, value: txValue }
      );
      txSpin.stop();

      finishWrite(result, {
        successMsg: 'Organization deployed',
        fields: {
          orgId,
          orgName: config.orgName,
          metadataCid: metaCid,
          gasUsed: result.gasUsed,
          nextStep: `pop org status --org ${orgId}`,
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
