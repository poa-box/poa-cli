import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createSigner } from '../../lib/signer';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { ipfsCidToBytes32, stringToBytes } from '../../lib/encoding';
import { resolveOrgModules } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import * as output from '../../lib/output';

interface BridgeArgs {
  org: string;
  token: string;
  amount: number;
  recipient: string;
  'dest-chain': number;
  'dest-token'?: string;
  duration?: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  simulate?: boolean;
}

// Known Curve pools for swapping
const CURVE_POOLS: Record<string, { address: string; tokenIndex: number; wxdaiIndex: number }> = {
  BREAD: {
    address: '0xf3D8F3dE71657D342db60dd714c8a2aE37Eac6B4',
    tokenIndex: 0,
    wxdaiIndex: 1,
  },
};

const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
// GasZip: quote-free direct deposit bridge. Takes (chainId, recipient) + native value.
// No TTL, no signed quote, no oracle. Delivers native gas token on destination chain.
// Contract: https://gnosisscan.io/address/0x2a37D63EAdFe4b4682a3c28C1c2cD4F109Cc2762
const GASZIP_GNOSIS = '0x2a37D63EAdFe4b4682a3c28C1c2cD4F109Cc2762';
// GasZip uses its own internal chain IDs, NOT EVM chain IDs.
// 57 = Arbitrum One, 54 = Optimism, 52 = Base. See https://dev.gas.zip/gas/chain-support
const GASZIP_CHAIN_IDS: Record<number, number> = {
  42161: 57, // Arbitrum One
  10: 54,    // Optimism
  8453: 52,  // Base
};

export const bridgeHandler = {
  builder: (yargs: Argv) => yargs
    .option('token', {
      type: 'string',
      demandOption: true,
      describe: 'Source token symbol (e.g. BREAD, WXDAI, xDAI)',
    })
    .option('amount', {
      type: 'number',
      demandOption: true,
      describe: 'Amount to bridge (in token units, e.g. 10)',
    })
    .option('recipient', {
      type: 'string',
      demandOption: true,
      describe: 'Recipient address on destination chain',
    })
    .option('dest-chain', {
      type: 'number',
      demandOption: true,
      describe: 'Destination chain ID (e.g. 42161 for Arbitrum)',
    })
    .option('dest-token', {
      type: 'string',
      default: 'ETH',
      describe: 'Destination token (ETH, USDC, DAI)',
    })
    .option('duration', {
      type: 'number',
      default: 60,
      describe: 'Proposal voting duration in minutes',
    })
    .option('simulate', {
      type: 'boolean',
      default: true,
      describe: 'Run fork simulation before creating proposal',
    }),

  handler: async (argv: ArgumentsCamelCase<BridgeArgs>) => {
    const spin = output.spinner('Building bridge proposal...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const executorAddr = modules.executorAddress;
      if (!executorAddr) throw new Error('No Executor contract found');

      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });
      const networkConfig = resolveNetworkConfig(argv.chain);

      const tokenSymbol = (argv.token as string).toUpperCase();
      const amount = ethers.utils.parseUnits(argv.amount.toString(), 18);
      const recipient = ethers.utils.getAddress(argv.recipient as string);
      const destChain = argv.destChain as number;
      const destToken = (argv.destToken as string || 'ETH').toUpperCase();

      const erc20Iface = new ethers.utils.Interface(['function approve(address spender, uint256 amount)']);
      const curveIface = new ethers.utils.Interface(['function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)']);
      const wxdaiIface = new ethers.utils.Interface(['function withdraw(uint256 amount)']);
      const gaszipIface = new ethers.utils.Interface(['function deposit(uint256 chains, address to)']);

      const calls: Array<{ target: string; value: string; data: string }> = [];
      // `bridgeInputAmount` is the guaranteed-minimum native xDAI we'll have at
      // the GasZip step. It must be ≤ actual post-swap balance or call 3 reverts.
      // For xDAI source: amount as-is.
      // For WXDAI source: amount (unwrap is 1:1).
      // For BREAD source: minWxdai from Curve (after slippage floor).
      let bridgeInputAmount = amount;

      // Step 1: If source token needs swapping to WXDAI first
      if (tokenSymbol !== 'WXDAI' && tokenSymbol !== 'XDAI') {
        const curvePool = CURVE_POOLS[tokenSymbol];
        if (!curvePool) {
          throw new Error(`No Curve pool configured for ${tokenSymbol}. Supported: ${Object.keys(CURVE_POOLS).join(', ')}, WXDAI, xDAI`);
        }

        // Get expected output from Curve
        spin.text = 'Getting swap quote from Curve...';
        const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc);
        const curveContract = new ethers.Contract(
          curvePool.address,
          ['function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)'],
          provider,
        );

        const tokenAddress = networkConfig.bountyTokens?.[tokenSymbol];
        if (!tokenAddress) throw new Error(`Token ${tokenSymbol} not found in network config`);

        const expectedWxdai = await curveContract.get_dy(curvePool.tokenIndex, curvePool.wxdaiIndex, amount);
        const minWxdai = expectedWxdai.mul(95).div(100); // 5% slippage
        bridgeInputAmount = minWxdai;

        // Approve Curve pool
        calls.push({
          target: tokenAddress,
          value: '0',
          data: erc20Iface.encodeFunctionData('approve', [curvePool.address, amount]),
        });

        // Swap via Curve
        calls.push({
          target: curvePool.address,
          value: '0',
          data: curveIface.encodeFunctionData('exchange', [
            curvePool.tokenIndex,
            curvePool.wxdaiIndex,
            amount,
            minWxdai,
          ]),
        });

        output.isJsonMode() || spin.text && (spin.text = `Swap: ${argv.amount} ${tokenSymbol} → ~${ethers.utils.formatEther(expectedWxdai)} WXDAI`);
      }

      // Step 2: Bridge via GasZip direct deposit
      //
      // GasZip is quote-free: deposit(chainId, recipient) payable with native xDAI.
      // No oracle, no TTL, no signed quote. Delivers native gas on destination.
      //
      // CRITICAL: The value passed to GasZip.deposit MUST be ≤ the xDAI balance the
      // Executor will have at execution time. If source is BREAD/WXDAI, we must
      // first unwrap to native xDAI inside the same batch. We use the GUARANTEED
      // MINIMUM from the Curve swap (bridgeInputAmount) as the bridge value, NOT
      // the current expected output — because expected can drift within slippage
      // tolerance and we need the call to succeed even in the worst-case swap.
      const gaszipChainId = GASZIP_CHAIN_IDS[destChain];
      if (!gaszipChainId) {
        throw new Error(
          `GasZip does not support destination chain ${destChain}. Supported: ${Object.keys(GASZIP_CHAIN_IDS).join(', ')}.`
        );
      }

      spin.text = 'Building GasZip deposit call...';

      // If source is WXDAI (no swap), unwrap the amount directly.
      // If source is BREAD (swap was added above), unwrap the guaranteed-minimum Curve output.
      // If source is xDAI, no unwrap needed — GasZip takes native directly.
      if (tokenSymbol === 'WXDAI') {
        calls.push({
          target: WXDAI,
          value: '0',
          data: wxdaiIface.encodeFunctionData('withdraw', [amount]),
        });
      } else if (tokenSymbol !== 'XDAI') {
        // Source was BREAD or another token that swapped to WXDAI via Curve above.
        // bridgeInputAmount is the min_dy floor; unwrap that much.
        calls.push({
          target: WXDAI,
          value: '0',
          data: wxdaiIface.encodeFunctionData('withdraw', [bridgeInputAmount]),
        });
      }

      // GasZip deposit: value = bridgeInputAmount (guaranteed-available xDAI).
      calls.push({
        target: GASZIP_GNOSIS,
        value: bridgeInputAmount.toString(),
        data: gaszipIface.encodeFunctionData('deposit', [gaszipChainId, recipient]),
      });

      const estimatedOutput = ethers.utils.formatEther(bridgeInputAmount);
      const bridgeName = 'GasZip';

      // Step 3: Simulate if requested
      if (argv.simulate !== false) {
        spin.text = 'Running fork simulation...';
        const { execSync } = require('child_process');
        const simResult = execSync(
          `node dist/index.js vote simulate --json --calls '${JSON.stringify(calls)}'`,
          { encoding: 'utf8', timeout: 180000, cwd: process.cwd() },
        );
        const sim = JSON.parse(simResult);
        if (!sim.success) {
          spin.stop();
          output.error('Simulation FAILED — proposal would revert on execution. Use --simulate false to skip.');
          if (output.isJsonMode()) {
            output.json({ simulation: 'failed', calls: sim.calls });
          }
          process.exit(1);
        }
        spin.text = 'Simulation passed — creating proposal...';
      }

      // Step 4: Create the proposal
      const proposalMeta = {
        description: `Bridge ${argv.amount} ${tokenSymbol} from treasury to ${recipient} as ${destToken} on chain ${destChain}. ` +
          `Route: ${tokenSymbol !== 'WXDAI' ? tokenSymbol + ' → WXDAI (Curve) → ' : ''}${destToken} (${bridgeName}). ` +
          `Estimated output: ${estimatedOutput} ${destToken}. Simulation-verified.`,
        optionNames: [`Bridge ${argv.amount} ${tokenSymbol}`, 'Keep in treasury'],
        createdAt: Date.now(),
      };

      spin.text = 'Pinning metadata to IPFS...';
      const cid = await pinJson(JSON.stringify(proposalMeta));
      const descriptionHash = ipfsCidToBytes32(cid);
      const titleBytes = stringToBytes(`Bridge ${argv.amount} ${tokenSymbol} → ${destToken} on chain ${destChain}`);

      const batches: any[][] = [];
      const option0Batch = calls.map(c => [c.target, ethers.BigNumber.from(c.value || '0'), c.data]);
      batches.push(option0Batch);
      batches.push([]); // option 1: no-op

      const votingAddr = modules.hybridVotingAddress;
      if (!votingAddr) throw new Error('No HybridVoting contract found');

      spin.text = 'Sending proposal transaction...';
      const contract = createWriteContract(votingAddr, 'HybridVotingNew', signer);
      const result = await executeTx(
        contract,
        'createProposal',
        [titleBytes, descriptionHash, argv.duration || 60, 2, batches, []],
        { dryRun: argv.dryRun },
      );

      spin.stop();

      if (result.success) {
        const proposalEvent = result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal');
        const proposalId = proposalEvent?.args?.id?.toString();
        output.success('Bridge proposal created', {
          proposalId,
          txHash: result.txHash,
          explorerUrl: result.explorerUrl,
          route: `${tokenSymbol} → ${destToken} (chain ${destChain})`,
          bridge: bridgeName,
          estimatedOutput: `${estimatedOutput} ${destToken}`,
          recipient,
          calls: calls.length,
          simulated: argv.simulate !== false,
          ipfsCid: cid,
        });
      } else {
        output.error('Proposal creation failed', { error: result.error, errorCode: result.errorCode });
        process.exit(2);
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
