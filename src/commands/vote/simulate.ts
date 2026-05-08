import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { resolveOrgModules } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import { query } from '../../lib/subgraph';
import * as output from '../../lib/output';

interface SimulateArgs {
  org: string;
  calls: string;
  chain?: number;
  rpc?: string;
  verbose?: boolean;
  warpMinutes?: number;
  gasLimit?: number;
}

export const simulateHandler = {
  builder: (yargs: Argv) => yargs
    .option('calls', {
      type: 'string',
      demandOption: true,
      describe: 'JSON array of execution calls: [{"target":"0x...","value":"0","data":"0x..."}]',
    })
    .option('warp-minutes', {
      type: 'number',
      default: 60,
      describe: 'Advance fork block.timestamp by N minutes before running the batch. ' +
        'Models the gap between proposal creation and actual execution (typical voting window). ' +
        'Catches time-sensitive failures like expired bridge quotes, stale oracle prices, ' +
        'and rate-limited routers. Set to 0 to test at current block.',
    })
    .option('gas-limit', {
      type: 'number',
      default: 0,
      describe: 'Bound the OUTERMOST execute() call frame at N gas to model the ' +
        'production UserOp callGasLimit ceiling. The 63/64 EVM gas-forwarding ' +
        'rule then starves deep sub-calls inside the batch the same way it does ' +
        'on-chain when announce-side sponsored-tx callGasLimit is too tight. ' +
        '0 (default) = unbounded, current behaviour. 300000 reproduces the ' +
        'silent-failure mode that killed proposals #41/#49/#50/#52 (Curve+GasZip ' +
        'BREAD→ETH bridges OOGing at the ERC20Votes checkpoint write). 2000000 ' +
        'is the floor minCallGas in sponsored.ts that fixed proposal #53.',
    }),

  handler: async (argv: ArgumentsCamelCase<SimulateArgs>) => {
    const spin = output.spinner('Simulating proposal execution...');
    spin.start();

    try {
      // 1. Parse and validate calls
      let calls: Array<{ target: string; value: string; data: string }>;
      try {
        calls = JSON.parse(argv.calls as string);
      } catch {
        throw new Error('Invalid --calls JSON. Expected: [{"target":"0x...","value":"0","data":"0x..."}]');
      }

      if (!Array.isArray(calls) || calls.length === 0) {
        throw new Error('--calls must be a non-empty array');
      }

      if (calls.length > 8) {
        throw new Error(`Too many calls (${calls.length}). Executor max is 8 per batch.`);
      }

      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        if (!c.target || !ethers.utils.isAddress(c.target)) {
          throw new Error(`Call ${i}: invalid target address "${c.target}"`);
        }
        if (!c.data || !c.data.startsWith('0x')) {
          throw new Error(`Call ${i}: invalid calldata "${c.data}"`);
        }
      }

      // 2. Resolve org contracts
      spin.text = 'Resolving org contracts...';
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const executorAddr = modules.executorAddress;
      const hybridVotingAddr = modules.hybridVotingAddress;

      if (!executorAddr) throw new Error('No Executor contract found for this org');
      if (!hybridVotingAddr) throw new Error('No HybridVoting contract found for this org');

      // 2b. List active proposals as potential conflicts.
      // Can't check exact target overlap from subgraph (calls aren't exposed for
      // active proposals), so surface all active proposals and let the operator/agent
      // review whether any could change state before this one executes.
      spin.text = 'Checking for conflicting active proposals...';
      const conflictQuery = `{
        proposals(
          where: {
            hybridVoting: "${hybridVotingAddr.toLowerCase()}",
            status: "Active"
          }
          first: 20
        ) {
          proposalId
          title
          endTimestamp
        }
      }`;
      let conflicts: Array<{
        proposalId: string;
        title: string;
        minutesLeft: number;
      }> = [];
      try {
        const activeResult = await query<{ proposals: any[] }>(conflictQuery, {}, argv.chain);
        const now = Math.floor(Date.now() / 1000);
        for (const p of activeResult.proposals || []) {
          conflicts.push({
            proposalId: p.proposalId,
            title: p.title,
            minutesLeft: Math.max(0, Math.round((parseInt(p.endTimestamp) - now) / 60)),
          });
        }
      } catch {
        // Subgraph failure — don't block simulation, just skip conflict check
      }

      // 3. Get RPC URL
      const networkConfig = resolveNetworkConfig(argv.chain);
      const rpcUrl = (argv.rpc as string) || networkConfig.resolvedRpc;

      // 4. Check forge is available
      try {
        execSync('forge --version', { stdio: 'pipe' });
      } catch {
        throw new Error('Foundry (forge) not installed. Install: curl -L https://foundry.paradigm.xyz | bash');
      }

      // 5. Build Foundry script
      spin.text = 'Building simulation script...';
      const scriptDir = join(__dirname, '..', '..', '..', '.simulate');
      if (!existsSync(scriptDir)) mkdirSync(scriptDir, { recursive: true });

      // Checksum all addresses for Solidity
      const checksumExecutor = ethers.utils.getAddress(executorAddr);
      const checksumVoting = ethers.utils.getAddress(hybridVotingAddr);

      // Generate the Solidity call encoding
      const callStructs = calls.map((c, i) => {
        const val = c.value || '0';
        const checksumTarget = ethers.utils.getAddress(c.target);
        return `        targets[${i}] = ${checksumTarget};
        values[${i}] = ${val};
        calldatas[${i}] = hex"${c.data.slice(2)}";`;
      }).join('\n');

      // Try to decode function selectors for better reporting
      const selectorLabels = calls.map((c, i) => {
        const selector = c.data.slice(0, 10);
        return `        emit log_named_string("  selector", "${selector}");`;
      }).join('\n');

      const script = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";

interface IExecutor {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }
    function execute(uint256 proposalId, Call[] calldata batch) external;
}

contract SimulateProposal is Test {
    function run() external {
        address executor = ${checksumExecutor};
        address votingContract = ${checksumVoting};
        uint256 numCalls = ${calls.length};
        uint256 warpSeconds = ${(argv.warpMinutes ?? 60) * 60};

        address[] memory targets = new address[](numCalls);
        uint256[] memory values = new uint256[](numCalls);
        bytes[] memory calldatas = new bytes[](numCalls);

${callStructs}

        IExecutor.Call[] memory batch = new IExecutor.Call[](numCalls);
        for (uint256 i = 0; i < numCalls; i++) {
            batch[i] = IExecutor.Call(targets[i], values[i], calldatas[i]);
        }

        // === Fund Executor with enough xDAI to cover batch values ===
        // The Executor needs to hold the value being forwarded to each call.
        // Without this, tests of payable bridges (GasZip.deposit, etc.) fail
        // with silent reverts because the .call{value:X}() pattern has no
        // funds to transfer. On-chain, value comes from the Executor's
        // actual balance — simulate must mirror that.
        uint256 totalValue = 0;
        for (uint256 i = 0; i < numCalls; i++) {
            totalValue += values[i];
        }
        if (totalValue > 0) {
            vm.deal(executor, executor.balance + totalValue);
        }

        // === WARP TIME TO MODEL EXECUTION-GAP DRIFT ===
        // Proposals are simulated at creation but executed after the voting
        // window closes — typically 60+ minutes later. In the meantime:
        //   - Bridge quotes expire (LiFi signed quotes, 1inch routes, etc.)
        //   - DEX rates shift (Curve pool balances, Uniswap prices)
        //   - Oracles update (Chainlink, DIA, etc.)
        //   - Rate-limited routers refill or deplete
        // vm.warp advances fork block.timestamp to model this gap. A batch
        // that passes at warpSeconds=0 but fails at warpSeconds=3600 reveals
        // the exact failure mode that killed #41, #49, #50, #51 (LiFi quotes
        // expiring during the voting window).
        if (warpSeconds > 0) {
            emit log_named_uint("WARPING_TIME_SECONDS", warpSeconds);
            vm.warp(block.timestamp + warpSeconds);
        }

        // === Test each call individually on clean state ===
        emit log("=== INDIVIDUAL CALL RESULTS ===");
        for (uint256 i = 0; i < numCalls; i++) {
            uint256 snap = vm.snapshot();
            vm.prank(executor);
            (bool success, bytes memory retData) = targets[i].call{value: values[i]}(calldatas[i]);
            vm.revertTo(snap);

            if (success) {
                emit log_named_uint("PASS", i);
            } else {
                emit log_named_uint("FAIL", i);
                if (retData.length > 0) {
                    emit log_named_bytes("  revert_data", retData);
                }
            }
        }

        // === Full batch through Executor (authoritative) ===
        emit log("=== SIMULATING FULL BATCH ===");

        uint256 gasLimitCap = ${argv.gasLimit ?? 0};
        if (gasLimitCap > 0) {
            // BOUNDED-GAS PATH — models production UserOp callGasLimit.
            // The outermost call into execute() is given exactly gasLimitCap
            // gas. The EVM then forwards 63/64 of remaining gas at every
            // internal sub-call. A batch that passes unbounded but fails
            // here is the exact failure mode that killed proposals
            // #41/#49/#50/#52: PaymasterHub passed a 300K callGasLimit, and
            // by the time control reached BREAD.transferFrom several frames
            // deep, ~52K remained — not enough for the ERC20Votes
            // checkpoint write. Fixed by sponsored.ts minCallGas: 2_000_000n.
            emit log_named_uint("GAS_LIMIT_APPLIED", gasLimitCap);
            bytes memory payload = abi.encodeWithSelector(
                IExecutor.execute.selector,
                uint256(0),
                batch
            );
            uint256 gasBefore = gasleft();
            vm.prank(votingContract);
            (bool ok, bytes memory retData) = address(executor).call{gas: gasLimitCap}(payload);
            uint256 gasUsed = gasBefore - gasleft();
            if (ok) {
                emit log("RESULT: FULL BATCH SUCCESS (BOUNDED)");
                emit log_named_uint("GAS_USED", gasUsed);
            } else {
                emit log("RESULT: GAS_BOUNDED_FAILURE");
                emit log_named_uint("GAS_USED", gasUsed);
                if (retData.length > 0) {
                    emit log_named_bytes("  revert_data", retData);
                } else {
                    emit log("  empty revert data - classic OOG signature");
                }
            }
        } else {
            // UNBOUNDED PATH (default) — measures raw batch gas with no
            // outer cap. This is the original simulator behaviour. Use it
            // to get an accurate gas-usage number for setting the
            // announce-side minCallGas floor.
            uint256 gasBefore = gasleft();
            vm.prank(votingContract);
            try IExecutor(executor).execute(0, batch) {
                uint256 gasUsed = gasBefore - gasleft();
                emit log("RESULT: FULL BATCH SUCCESS");
                emit log_named_uint("GAS_USED", gasUsed);

                // Warn if gas is high (announceWinner has overhead + sponsored txs have limits)
                if (gasUsed > 1500000) {
                    emit log("WARNING: GAS_HIGH - batch uses >1.5M gas. May fail via sponsored tx or announceWinner.");
                    emit log("Consider: unset PIMLICO vars and announce via direct tx with high gas limit.");
                } else if (gasUsed > 500000) {
                    emit log("WARNING: GAS_MODERATE - batch uses >500K gas. Monitor announcement tx.");
                }
            } catch Error(string memory reason) {
                emit log_named_string("RESULT: FULL BATCH REVERTED", reason);
            } catch (bytes memory lowLevelData) {
                emit log("RESULT: FULL BATCH REVERTED (low-level)");
                emit log_named_bytes("  revert_data", lowLevelData);
            }
        }
    }
}
`;

      const scriptPath = join(scriptDir, 'SimulateProposal.s.sol');
      writeFileSync(scriptPath, script);

      // 6. Ensure foundry.toml exists
      const foundryToml = join(scriptDir, 'foundry.toml');
      if (!existsSync(foundryToml)) {
        writeFileSync(foundryToml, `[profile.default]
src = "."
out = "out"
libs = ["lib"]
`);
      }

      // Install forge-std if needed
      const libDir = join(scriptDir, 'lib', 'forge-std');
      if (!existsSync(libDir)) {
        spin.text = 'Installing forge-std (first run only)...';
        try {
          execSync(`cd "${scriptDir}" && forge install foundry-rs/forge-std --no-commit --no-git 2>&1`, {
            timeout: 60000,
            stdio: 'pipe',
          });
        } catch {
          // forge install may fail without git — try direct clone
          mkdirSync(join(scriptDir, 'lib'), { recursive: true });
          execSync(`git clone --depth 1 https://github.com/foundry-rs/forge-std "${libDir}" 2>&1`, {
            timeout: 60000,
            stdio: 'pipe',
          });
        }
      }

      // 7. Run simulation
      spin.text = 'Running fork simulation against live chain state...';
      let forgeOutput: string;
      try {
        forgeOutput = execSync(
          `cd "${scriptDir}" && forge script SimulateProposal.s.sol:SimulateProposal --fork-url "${rpcUrl}" -vvvv 2>&1`,
          { timeout: 120000, encoding: 'utf8' }
        );
      } catch (err: any) {
        forgeOutput = err.stdout || err.stderr || err.message;
      }

      spin.stop();

      // 8. Parse and report results
      const gasLimitApplied = (argv.gasLimit ?? 0) > 0 ? (argv.gasLimit as number) : null;
      const gasBoundedFailure = forgeOutput.includes('RESULT: GAS_BOUNDED_FAILURE');
      const batchSuccess =
        forgeOutput.includes('RESULT: FULL BATCH SUCCESS') &&
        !gasBoundedFailure;
      const batchReverted =
        forgeOutput.includes('RESULT: FULL BATCH REVERTED') || gasBoundedFailure;

      // Parse individual results
      const individualResults: Array<{ index: number; pass: boolean }> = [];
      for (let i = 0; i < calls.length; i++) {
        const passMatch = forgeOutput.includes(`PASS: ${i}`);
        const failMatch = forgeOutput.includes(`FAIL: ${i}`);
        individualResults.push({ index: i, pass: passMatch && !failMatch });
      }

      // Extract revert reason if present
      let revertReason = '';
      const revertMatch = forgeOutput.match(/RESULT: FULL BATCH REVERTED[:\s]*(.+)/);
      if (revertMatch) revertReason = revertMatch[1];

      // Extract gas usage
      const gasMatch = forgeOutput.match(/GAS_USED: (\d+)/);
      const gasUsed = gasMatch ? parseInt(gasMatch[1]) : null;
      const gasWarning = forgeOutput.includes('WARNING: GAS_HIGH') ? 'HIGH'
        : forgeOutput.includes('WARNING: GAS_MODERATE') ? 'MODERATE'
        : null;

      // Check for time-sensitive calldata (bridge quotes, DEX swaps with deadlines)
      const totalCalldataBytes = calls.reduce((sum, c) => sum + (c.data.length - 2) / 2, 0);
      const hasBridgeCall = calls.some(c => {
        const sel = c.data.slice(0, 10);
        // Common bridge/aggregator selectors
        return ['0x606326ff', '0x8aac16ba', '0x4630a0d8', '0x733214a3'].includes(sel);
      });

      if (output.isJsonMode()) {
        output.json({
          success: batchSuccess,
          calls: calls.map((c, i) => ({
            index: i,
            target: c.target,
            selector: c.data.slice(0, 10),
            pass: individualResults[i]?.pass ?? false,
          })),
          revertReason: revertReason || undefined,
          gasUsed,
          gasWarning,
          gasLimitApplied,
          gasBoundedFailure,
          calldataBytes: totalCalldataBytes,
          hasBridgeCall,
          conflicts,
          executorAddress: executorAddr,
          votingContract: hybridVotingAddr,
          rpcUrl,
        });
      } else {
        console.log('');
        if (batchSuccess) {
          console.log('  \x1b[32m✓ SIMULATION PASSED\x1b[0m — all calls would execute successfully');
          if (gasLimitApplied) {
            console.log(`  \x1b[32m  (under bounded gas cap of ${gasLimitApplied.toLocaleString()} — safe under sponsored-tx callGasLimit)\x1b[0m`);
          }
        } else if (gasBoundedFailure) {
          console.log('  \x1b[31m✗ GAS_BOUNDED_FAILURE\x1b[0m — batch ran out of gas under the ' +
            `${gasLimitApplied?.toLocaleString()}-gas cap.`);
          console.log('  \x1b[31m  Production sponsored-tx callGasLimit will hit the same wall.\x1b[0m');
          console.log('  \x1b[31m  Fix: raise minCallGas in src/lib/sponsored.ts (current floor 2_000_000n)\x1b[0m');
          console.log('  \x1b[31m  or split the batch so each call frame has more headroom.\x1b[0m');
          console.log('  \x1b[31m  This is the same failure mode that killed proposals #41/#49/#50/#52.\x1b[0m');
        } else {
          console.log('  \x1b[31m✗ SIMULATION FAILED\x1b[0m — proposal would revert on execution');
          if (revertReason) {
            console.log(`  Reason: ${revertReason}`);
          }
        }

        // Gas warnings
        if (gasUsed) {
          console.log(`  Gas used: ${gasUsed.toLocaleString()}`);
        }
        if (gasWarning === 'HIGH') {
          console.log('  \x1b[33m⚠ WARNING: High gas usage (>1.5M). Will likely fail via sponsored tx.\x1b[0m');
          console.log('  \x1b[33m  Announce with: PIMLICO_API_KEY="" pop vote announce --proposal N\x1b[0m');
        } else if (gasWarning === 'MODERATE') {
          console.log('  \x1b[33m⚠ WARNING: Moderate gas usage (>500K). Monitor announcement tx.\x1b[0m');
        }

        // Bridge calldata warning
        if (hasBridgeCall) {
          console.log('  \x1b[33m⚠ WARNING: Contains bridge/aggregator call. Quote may expire.\x1b[0m');
          console.log('  \x1b[33m  Use quote-free bridge (GasZip direct deposit) or announce promptly after voting.\x1b[0m');
        }

        // Active proposals warning — THE #44 FAILURE MODE
        if (conflicts.length > 0) {
          console.log(`  \x1b[33m⚠ ACTIVE PROPOSALS: ${conflicts.length} other proposal(s) may execute before this one:\x1b[0m`);
          for (const c of conflicts) {
            console.log(`  \x1b[33m  - #${c.proposalId} "${c.title}" (${c.minutesLeft}m left)\x1b[0m`);
          }
          console.log('  \x1b[33m  State may change before your proposal runs. Check if any of these\x1b[0m');
          console.log('  \x1b[33m  would drain funds or modify targets you depend on. Coordinate via\x1b[0m');
          console.log('  \x1b[33m  `pop vote discuss` before voting.\x1b[0m');
        }

        console.log('');
        console.log('  Calls:');
        for (let i = 0; i < calls.length; i++) {
          const c = calls[i];
          const result = individualResults[i]?.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
          console.log(`    ${result} [${i}] ${c.target} ${c.data.slice(0, 10)}`);
        }
        console.log('');
        console.log(`  Executor:  ${executorAddr}`);
        console.log(`  Voting:    ${hybridVotingAddr}`);
        console.log(`  Fork:      ${rpcUrl}`);
        console.log(`  Calldata:  ${totalCalldataBytes} bytes`);
        console.log('');
      }

      if (argv.verbose) {
        console.log('--- Raw Forge Output ---');
        console.log(forgeOutput);
      }

      // Clean up
      try { unlinkSync(scriptPath); } catch {}

      if (!batchSuccess) {
        process.exit(1);
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
