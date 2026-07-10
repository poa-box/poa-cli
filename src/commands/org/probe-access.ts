/**
 * pop org probe-access — burner-callStatic access-control probe for any contract.
 *
 * Codifies the static-analysis methodology vigil_01 used across HB#153-157
 * to map the access-control gates of HybridVoting, Executor, EligibilityModule,
 * PaymentManager, and QuickJoin. The methodology:
 *
 *   1. For every external/payable function in the ABI:
 *   2. Construct a callStatic invocation with realistic-shape zero arguments
 *      (zero address for `address`, 0 for `uint*`, false for `bool`,
 *      empty bytes for `bytes`, empty arrays for `*[]`, etc).
 *   3. Spoof `from` to a fresh burner wallet address (no hats, no balances).
 *   4. Catch the revert. Decode it via Interface.parseError(). Record the
 *      error name + selector + any args.
 *   5. Print a verification table: function name | error | likely access
 *      control gate.
 *
 * Result: a contract's full external surface mapped to its access control
 * model in <5 minutes, zero gas, zero on-chain footprint. Two distinct
 * gating libraries handled by the same decode path (OpenZeppelin Ownable
 * via `OwnableUnauthorizedAccount`, custom errors via `NotSuperAdmin` /
 * `Unauthorized` / `OnlyMasterDeploy` / etc).
 *
 * Limitations explicitly handled and surfaced in --help:
 *   - Functions that revert with `require(string)` instead of a custom
 *     error fall through to the raw revert message. Still reportable.
 *   - Some access checks happen mid-function after state reads, so a
 *     well-shaped argument may pass the access gate and revert later on
 *     a state check. Those are reported as "passed access check, reverted
 *     downstream" and the command notes the function name.
 *   - Reentrancy guards count as access controls for our purposes — a
 *     `ReentrancyGuardReentrantCall` revert means the gate is sound.
 *   - The probe never sends a transaction. It is read-only by construction.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { resolveNetworkConfig } from '../../config/networks';
import * as output from '../../lib/output';
import { expandAliases } from '../../lib/label-aliases';

interface ProbeAccessArgs {
  address: string;
  abi?: string;
  selectors?: string;
  chain?: number;
  rpc?: string;
  skipCodeCheck?: boolean;
  expectedName?: string;
}

/**
 * HB#385 task #390 — pre-probe identity check.
 *
 * HB#384 discovered that the HB#362 "Gitcoin Governor Bravo" audit was
 * actually probing Uniswap Governor Bravo — same address, wrong label.
 * The prevention rule documented in `reports/audits/corrections-hb384.md`
 * is "verify contract name() before probing." This helper makes that
 * check a first-class part of every probe run.
 *
 * Returns:
 *   - contractName: the string returned by the target's `name()` accessor,
 *     or null if the contract doesn't expose one / the call reverts
 *   - nameCheck: when expectedName is supplied, a { expected, actual, match }
 *     record. match is case-insensitive substring — "Compound" matches
 *     "Compound Governor Bravo", "Uniswap" does not.
 *
 * Never throws. name() reverts are silently tolerated — plenty of
 * contracts don't expose name() and the check is best-effort.
 */
/**
 * Pure helper for the substring name-match logic. Exported for unit testing
 * without needing to mock an RPC provider.
 *
 * Match semantics (HB#387+, task #395):
 *   1. Case-insensitive substring of the raw expected string against the
 *      on-chain `name()` return value. This is the original HB#385 behavior.
 *   2. If step 1 fails, consult LABEL_ALIASES: split the expected label into
 *      words, look up aliases for each word, and accept a match if any alias
 *      appears as a case-insensitive substring of the actual name. This
 *      closes the HB#386 sweep false-positive class where "curve" doesn't
 *      literally appear in "Vote-escrowed CRV".
 *
 * An empty expected string matches everything (String.includes semantic).
 * A null actual never matches.
 */
export function matchContractName(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const actualLower = actual.toLowerCase();
  if (actualLower.includes(expected.toLowerCase())) return true;
  // Alias fallback: any aliased token expanded from the expected label.
  for (const candidate of expandAliases(expected)) {
    if (candidate && actualLower.includes(candidate)) return true;
  }
  return false;
}

export async function fetchContractNameAndCheck(
  provider: ethers.providers.JsonRpcProvider,
  address: string,
  expectedName: string | undefined,
): Promise<{
  contractName: string | null;
  nameCheck: { expected: string; actual: string | null; match: boolean } | null;
}> {
  let contractName: string | null = null;
  try {
    // Minimal name() ABI — same shape that ERC20 / Governor / many contracts use
    const nameIface = new ethers.utils.Interface([
      'function name() view returns (string)',
    ]);
    const data = nameIface.encodeFunctionData('name', []);
    const raw = await provider.call({ to: address, data });
    if (raw && raw !== '0x') {
      const decoded = nameIface.decodeFunctionResult('name', raw);
      const result = decoded[0];
      if (typeof result === 'string' && result.trim() !== '') {
        contractName = result;
      }
    }
  } catch {
    // name() doesn't exist, revert, or decode failed — all fine, leave null
  }

  let nameCheck: { expected: string; actual: string | null; match: boolean } | null = null;
  if (expectedName) {
    nameCheck = {
      expected: expectedName,
      actual: contractName,
      match: matchContractName(contractName, expectedName),
    };
  }

  return { contractName, nameCheck };
}

interface ProbeResult {
  name: string;
  selector: string;
  status: 'gated' | 'passed' | 'unknown' | 'invalid-input' | 'reentrancy-guarded' | 'not-implemented';
  errorName?: string;
  errorSignature?: string;
  errorArgs?: any[];
  rawMessage?: string;
  likelyGate: string;
}

/**
 * HB#382 task #384 — probe-reliability heuristic.
 *
 * Detect contract patterns that make burner-callStatic probe results
 * unreliable BEFORE running the probe, so operators can interpret the
 * output correctly instead of treating a passed result as a security
 * finding.
 *
 * Two patterns detected:
 *
 * 1. **ds-auth** (Dappsys library, used by MakerDAO and many older
 *    Ethereum contracts). The permission check is an EXTERNAL CALL to
 *    a separate Authority contract, which is expensive. Contracts
 *    economize by running cheap parameter validation first, so
 *    burner-callStatic with default parameters hits early-return paths
 *    BEFORE the Authority check. Detected by the presence of BOTH
 *    `setUserRole(address,uint8,bool)` (0x67aff484) and
 *    `setAuthority(address)` (0x7a9e5e4b) selectors in the runtime code.
 *    See HB#379 Maker Chief audit for the empirical finding.
 *
 * 2. **Vyper compiler** (used by Curve, Yearn, and most veToken DAOs).
 *    Vyper orders parameter loading + cheap parameter validation before
 *    the `assert msg.sender == self.admin` statement in each function
 *    body. Same symptom as ds-auth — default-parameter burner calls hit
 *    early-returns before the permission check. Detected by the
 *    presence of Curve's signature `commit_transfer_ownership(address)`
 *    (0x6b441a40) + `apply_transfer_ownership()` (0x6a1c05ae) selectors,
 *    which is the canonical 2-step Vyper admin transfer pattern.
 *    See HB#380 Curve VotingEscrow + GaugeController audits.
 *
 * False positive tolerance: we'd rather flag one extra contract as
 * probe-limited than miss a real one. Operators can ignore the warning
 * if they know the contract uses inline modifiers despite matching the
 * selector pattern.
 *
 * False negative concern: any contract using ds-auth or Vyper WITHOUT
 * also exposing these selectors won't be detected. That's acceptable
 * because (a) ds-auth without setAuthority is unusual, and (b) Vyper
 * contracts without the transfer_ownership pattern are rare in DAO
 * governance. Both would require per-contract case-by-case analysis
 * anyway, which is outside the scope of the heuristic.
 */
export function detectProbeReliabilityPatterns(codeLower: string | null): {
  dsAuth: boolean;
  vyper: boolean;
  voteEscrow: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!codeLower) {
    return { dsAuth: false, vyper: false, voteEscrow: false, warnings };
  }

  // ds-auth: setUserRole(address,uint8,bool) + setAuthority(address)
  const HAS_SET_USER_ROLE = codeLower.includes('67aff484');
  const HAS_SET_AUTHORITY = codeLower.includes('7a9e5e4b');
  const dsAuth = HAS_SET_USER_ROLE && HAS_SET_AUTHORITY;
  if (dsAuth) {
    warnings.push(
      'ds-auth detected: probe-access is UNRELIABLE for ds-auth contracts. ' +
      'The Authority check is an external call run AFTER parameter validation, ' +
      'so default-parameter burner calls hit early-return paths before the ' +
      'permission check fires. Admin functions showing passed are probably ' +
      'gated in reality. Source verification required. See the HB#379 Maker ' +
      'Chief audit in reports/audits/ for the empirical finding.',
    );
  }

  // Vyper 2-step ownership transfer: commit_transfer_ownership + apply_transfer_ownership
  const HAS_COMMIT_TRANSFER = codeLower.includes('6b441a40');
  const HAS_APPLY_TRANSFER = codeLower.includes('6a1c05ae');
  const vyper = HAS_COMMIT_TRANSFER && HAS_APPLY_TRANSFER;
  if (vyper) {
    warnings.push(
      'Vyper signature detected: probe-access is UNRELIABLE for Vyper contracts. ' +
      'Vyper orders parameter loading + cheap validation before the ' +
      '`assert msg.sender == self.admin` statement, so default-parameter ' +
      'burner calls hit early-return paths before the permission check fires. ' +
      'Admin functions showing passed are probably gated in reality. Source ' +
      'verification required. See the HB#380 Curve DAO audit in reports/audits/ ' +
      'for the empirical finding.',
    );
  }

  // Vote-escrow family tag (informational, NOT an unreliability flag).
  // HB#292 task #398: detect Curve-style vote-escrow contracts (Curve veCRV,
  // Balancer veBAL, Frax veFXS, and their forks) via the canonical triad of
  // VotingEscrow write methods. Requires ALL 3 to minimize false positives:
  //   - create_lock(uint256,uint256)  → 0x65fc3873
  //   - increase_unlock_time(uint256) → 0xeff7a612
  //   - locked__end(address)          → 0xadc63589
  //
  // Unlike dsAuth / vyper, this does NOT push to warnings. A Solidity fork
  // of Curve veCRV (such as Balancer veBAL) can be probe-reliable because
  // the author can write access checks before parameter validation. The
  // tag exists so operators know "this is a vote-escrow contract" and can
  // correlate admin() / locked token / balance-at-time semantics. When
  // paired with `vyper: true`, the Vyper warning still applies.
  const HAS_CREATE_LOCK = codeLower.includes('65fc3873');
  const HAS_INCREASE_UNLOCK = codeLower.includes('eff7a612');
  const HAS_LOCKED_END = codeLower.includes('adc63589');
  const voteEscrow = HAS_CREATE_LOCK && HAS_INCREASE_UNLOCK && HAS_LOCKED_END;

  return { dsAuth, vyper, voteEscrow, warnings };
}

/**
 * Generate a zero/default value for any Solidity ABI type.
 * Recurses on tuples / arrays. Returns ethers-compatible JS shapes.
 */
function zeroValue(type: string): any {
  if (type.endsWith('[]')) {
    return [];
  }
  // Fixed-size array like uint256[3]
  const fixedArrayMatch = type.match(/^(.+)\[(\d+)\]$/);
  if (fixedArrayMatch) {
    const [, inner, sizeStr] = fixedArrayMatch;
    const size = parseInt(sizeStr, 10);
    return Array.from({ length: size }, () => zeroValue(inner));
  }
  if (type === 'address') return ethers.constants.AddressZero;
  if (type === 'bool') return false;
  if (type === 'string') return '';
  if (type === 'bytes') return '0x';
  if (type.startsWith('bytes')) return ethers.utils.hexZeroPad('0x00', parseInt(type.slice(5), 10) || 32);
  if (type.startsWith('uint') || type.startsWith('int')) return 0;
  // Unknown (probably a tuple) — caller handles via recursion on components
  return null;
}

/**
 * Build the input array for a function. Tuples need their `components`
 * walked recursively because the ABI expresses them as named struct shapes.
 */
function buildInputs(inputs: any[]): any[] {
  return inputs.map((inp) => {
    if (inp.type === 'tuple') {
      const obj: Record<string, any> = {};
      for (const c of inp.components || []) {
        obj[c.name || c.type] = c.type === 'tuple' ? buildInputs([c])[0] : zeroValue(c.type);
      }
      return obj;
    }
    if (inp.type.startsWith('tuple[')) {
      // tuple[] / tuple[N] — empty array of tuples
      return [];
    }
    return zeroValue(inp.type);
  });
}

/**
 * Walk the ethers v5 error envelope through every place a require-string
 * revert reason might be hiding. Returns the first non-empty string found,
 * or '' if nothing is recoverable.
 *
 * The paths in priority order:
 *   1. err.reason — set by ethers when it auto-decodes Error(string)
 *   2. err.errorArgs?.[0] — when ethers sets errorName='Error' and decodes args
 *   3. err.error?.message — JSON-RPC error message from the upstream node;
 *      often "execution reverted: <reason>" for public RPCs
 *   4. err.error?.error?.message — double-nested for some providers
 *   5. err.error?.body — JSON.parse to extract .error.message
 *   6. err.data / err.error?.data — manual decode of 0x08c379a0... (Error(string))
 *   7. err.message — extract via regex for "reverted with reason string '...'"
 *
 * HB#161 Compound Governor Bravo dogfood found that probe-access against
 * old-style require(string) contracts was reporting "no clear gate" for ALL
 * functions, even though manual callStatic showed the strings clearly.
 * The fix: walk the envelope properly. (Task #340.)
 */
function extractRevertReason(err: any): string {
  if (err?.reason && typeof err.reason === 'string') return err.reason;
  if (Array.isArray(err?.errorArgs) && typeof err.errorArgs[0] === 'string') return err.errorArgs[0];
  if (err?.error?.message && typeof err.error.message === 'string') {
    // "execution reverted: <reason>" → strip prefix
    const m = err.error.message.match(/execution reverted:?\s*(.*)/i);
    if (m && m[1]) return m[1].trim();
    return err.error.message;
  }
  if (err?.error?.error?.message && typeof err.error.error.message === 'string') {
    const m = err.error.error.message.match(/execution reverted:?\s*(.*)/i);
    if (m && m[1]) return m[1].trim();
    return err.error.error.message;
  }
  if (err?.error?.body && typeof err.error.body === 'string') {
    try {
      const parsed = JSON.parse(err.error.body);
      const msg = parsed?.error?.message;
      if (typeof msg === 'string') {
        const m = msg.match(/execution reverted:?\s*(.*)/i);
        if (m && m[1]) return m[1].trim();
        return msg;
      }
    } catch { /* ignore */ }
  }
  // Manual decode of 0x08c379a0... (Error(string) ABI encoding)
  const data: string | undefined = err?.data || err?.error?.data;
  if (typeof data === 'string' && data.startsWith('0x08c379a0') && data.length >= 138) {
    try {
      const decoded = ethers.utils.defaultAbiCoder.decode(['string'], '0x' + data.slice(10));
      if (typeof decoded[0] === 'string') return decoded[0];
    } catch { /* ignore */ }
  }
  // Last resort: regex over err.message for "reason string 'X'"
  if (err?.message && typeof err.message === 'string') {
    const m = err.message.match(/reverted with reason string ['"]([^'"]+)['"]/i);
    if (m && m[1]) return m[1];
  }
  return '';
}

/**
 * Classify a revert into a likely access-control gate name for the operator.
 * The point is to surface the gate concept ("OZ Ownable", "custom NotSuperAdmin",
 * "msg.sender == executor") rather than just the bare error name.
 */
function classifyGate(errorName: string | undefined, rawMessage: string): string {
  // Inspect the require-string regardless of whether errorName is set
  // (an unknown(0x08c379a0) errorName plus a meaningful reason should
  // still classify as a require-string gate).
  const reasonLower = rawMessage.toLowerCase();
  if (rawMessage) {
    if (/admin only|only admin|onlyadmin/i.test(reasonLower)) return 'require-string admin gate';
    if (/only owner|caller is not the owner|onlyowner/i.test(reasonLower)) return 'OZ Ownable require-string variant';
    if (/only timelock|onlytimelock/i.test(reasonLower)) return 'governance timelock gate';
    if (/only governor|onlygovernor/i.test(reasonLower)) return 'governance gate';
    if (/paused/i.test(reasonLower)) return 'Pausable require';
    if (/access|owner|admin|unauthor|sender/i.test(reasonLower)) return 'require-string access check';
  }
  if (!errorName) {
    return rawMessage ? `require-string downstream: ${rawMessage.slice(0, 60)}` : 'no clear gate (downstream revert?)';
  }
  if (errorName.startsWith('unknown(')) {
    // We have an undecodable selector but maybe a reason string
    return rawMessage ? `require-string downstream: ${rawMessage.slice(0, 60)}` : `unknown selector ${errorName}`;
  }
  if (errorName === 'Error') {
    // Solidity stdlib Error(string) — ethers sets errorName='Error' when it
    // decodes the standard require/revert reason. The reason already passed
    // the access-keyword regex above; if we got here, the reason is a
    // state/input validation message, not an access check.
    return rawMessage
      ? `passed access gate; reverted with: ${rawMessage.slice(0, 60)}`
      : 'standard require revert (no reason captured)';
  }
  if (errorName === 'OwnableUnauthorizedAccount') return 'OZ Ownable (msg.sender == owner)';
  if (errorName === 'OwnableInvalidOwner') return 'OZ Ownable invalid input';
  if (errorName === 'NotSuperAdmin') return 'custom super-admin gate (msg.sender == superAdmin)';
  if (errorName === 'NotAuthorizedAdmin') return 'custom admin-hat gate (wearer of admin hat)';
  if (errorName === 'NotAuthorizedToVouch') return 'voucher hat eligibility gate';
  if (errorName === 'Unauthorized') return 'custom Unauthorized() (likely msg.sender == executor)';
  if (errorName === 'UnauthorizedCaller') return 'custom UnauthorizedCaller() (executor caller check)';
  if (errorName === 'OnlyMasterDeploy') return 'POP master deployer gate (NOT governance-controlled)';
  if (errorName === 'TargetSelf') return 'self-target guard (executor cannot call itself)';
  if (errorName === 'ReentrancyGuardReentrantCall') return 'OZ ReentrancyGuard';
  if (errorName === 'EnforcedPause') return 'Pausable (paused)';
  if (errorName === 'CannotVouchForSelf') return 'self-vouch guard';
  // Heuristic for downstream reverts that are not access checks
  if (/InvalidProposal|EmptyBatch|NoUsername|InvalidInput|InvalidHat|ZeroAddress|ZeroAmount|InvalidAmount/.test(errorName)) {
    return 'passed access gate; reverted on input/state validation';
  }
  return `custom error: ${errorName}`;
}

export const probeAccessHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('address', {
        type: 'string',
        demandOption: true,
        describe: 'Contract address to probe',
      })
      .option('abi', {
        type: 'string',
        describe:
          'Path to the ABI JSON file. If omitted, will try src/abi/<contract>.json by name guess; otherwise required.',
      })
      .option('selectors', {
        type: 'string',
        describe:
          'Comma-separated function names or 4-byte selectors to probe. If omitted, probes ALL external/payable functions.',
      })
      .option('skip-code-check', {
        type: 'boolean',
        default: false,
        describe:
          'Skip the on-chain selector existence check. Use when probing behind a proxy (EIP-1967) where the runtime code does not contain the implementation selectors, or when you know the ABI matches the target.',
      })
      .option('expected-name', {
        type: 'string',
        describe:
          "HB#385 (task #390): expected substring in the contract's name() return value. Case-insensitive substring match — 'Compound' matches 'Compound Governor Bravo'. When set, the tool calls name() on the target before probing and warns (non-fatal) if the result doesn't match. Prevents the HB#384 class of error where an audit labeled 'Gitcoin Governor Bravo' was actually probing Uniswap's contract. The name() call always runs even without this flag — result is recorded as contractName in JSON output.",
      })
      .epilogue(
        'Limitations:\n' +
        '  - Functions that revert with require(string) instead of custom errors fall through to raw messages.\n' +
        '  - Some access checks happen mid-function after state reads, so a well-shaped zero argument may pass\n' +
        '    the access gate and revert later on a state check. Those are reported as "passed gate, reverted downstream".\n' +
        '  - Reentrancy guards count as access controls (ReentrancyGuardReentrantCall = sound gate).\n' +
        '  - The probe never sends a transaction. Read-only by construction.\n' +
        '\nExamples:\n' +
        '  pop org probe-access --address 0x409f51250dc5c66bb1d6952f947d841192f1140e \\\n' +
        '    --abi src/abi/PaymentManager.json\n' +
        '  pop org probe-access --address 0xb37a97c8136f6d300c399162cefab5b61c675caf \\\n' +
        '    --abi src/abi/EligibilityModuleNew.json --selectors transferSuperAdmin,setUserJoinTime\n'
      ),

  handler: async (argv: ArgumentsCamelCase<ProbeAccessArgs>) => {
    const networkConfig = resolveNetworkConfig(argv.chain);
    const rpcUrl = (argv.rpc as string) || networkConfig.resolvedRpc;
    // Use StaticJsonRpcProvider so a chain-id mismatch between --chain and the
    // override --rpc doesn't blow up with "underlying network changed". This
    // matters for probing external contracts on chains we don't have in the
    // network config (HB#161 Compound case used --chain 42161 + Ethereum RPC).
    // The probe is read-only so we don't actually need chain-id validation.
    const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl);

    if (!ethers.utils.isAddress(argv.address)) {
      output.error(`Invalid contract address: ${argv.address}`);
      process.exit(1);
    }

    // HB#385 task #390: pre-probe identity check. Always call name() on the
    // target, log it, and compare against --expected-name if supplied. See
    // `fetchContractNameAndCheck` docstring for the full rationale.
    const identity = await fetchContractNameAndCheck(
      provider,
      argv.address,
      argv.expectedName,
    );
    if (identity.nameCheck && !identity.nameCheck.match && !output.isJsonMode()) {
      console.log('');
      console.log(
        `  ⚠ NAME CHECK MISMATCH: expected "${identity.nameCheck.expected}", ` +
        `got "${identity.nameCheck.actual ?? '(no name() accessor)'}". ` +
        `This is the HB#384-class error: verify the target address before ` +
        `trusting the probe output.`,
      );
      console.log('');
    } else if (identity.contractName && !output.isJsonMode()) {
      console.log('');
      console.log(`  Contract name: ${identity.contractName}`);
    }

    let abi: any[];
    try {
      const abiPath = argv.abi || '';
      if (!abiPath || !fs.existsSync(abiPath)) {
        output.error(
          `--abi <path> is required (or pass a valid src/abi/<name>.json). ` +
          `Future enhancement: auto-fetch from chain explorer / Sourcify.`
        );
        process.exit(1);
      }
      const raw = JSON.parse(fs.readFileSync(abiPath, 'utf-8'));
      abi = Array.isArray(raw) ? raw : raw.abi;
      if (!Array.isArray(abi)) {
        output.error(`Could not parse ABI from ${abiPath} — expected array or { abi: [...] }`);
        process.exit(1);
      }
    } catch (err: any) {
      output.error(`ABI load failed: ${err.message}`);
      process.exit(1);
    }

    const iface = new ethers.utils.Interface(abi);
    const contract = new ethers.Contract(argv.address, abi, provider);

    // Collect external/payable function fragments from the ABI.
    const allFns = abi.filter(
      (f) =>
        f.type === 'function' &&
        (f.stateMutability === 'nonpayable' || f.stateMutability === 'payable')
    );

    let targetFns = allFns;
    if (argv.selectors) {
      const wanted = argv.selectors.split(',').map((s) => s.trim().toLowerCase());
      targetFns = allFns.filter((f) => {
        const sig = `${f.name}(${(f.inputs || []).map((i: any) => i.type).join(',')})`;
        const sel = ethers.utils.id(sig).slice(0, 10).toLowerCase();
        return wanted.includes(f.name.toLowerCase()) || wanted.includes(sel);
      });
      if (targetFns.length === 0) {
        output.error(`No functions matched --selectors. Use names or 4-byte selectors.`);
        process.exit(1);
      }
    }

    // Burner address — fresh keypair, never funded, no hats.
    const burner = ethers.Wallet.createRandom().address;

    // HB#167 (#345): fetch the target contract's runtime code once and use
    // it to detect ABI-mismatch false positives. If a selector is not present
    // in the runtime code, callStatic against it hits the fallback/empty
    // return path and the old probe reported 'passed' (false positive).
    // Classify those rows as 'not-implemented' instead.
    //
    // The scan is a substring check on the hex code. PUSH4 <selector>
    // appears as `63<selector>` in bytecode, and direct immediates appear
    // inline — either way the 8-char selector hex appears literally.
    //
    // Proxy handling: EIP-1967 proxies store the implementation address at a
    // fixed slot. If the target's runtime code is missing >90% of ABI selectors
    // we check the EIP-1967 slot and use the implementation's code instead.
    // Compound Governor Bravo is a GovernorBravoDelegator (older-style
    // delegatecall proxy, storage layout predates EIP-1967) — for that case
    // we fall back to a "skip the check entirely, probe as before" mode so
    // legacy proxies don't false-negative.
    //
    // --skip-code-check forces the bypass unconditionally.
    let contractCodeLower: string | null = null;
    if (!argv.skipCodeCheck) {
      try {
        const code = await provider.getCode(argv.address);
        if (!code || code === '0x') {
          output.error(
            `No code at ${argv.address} on chain ${networkConfig.chainId}. ` +
              `The address is an EOA or the contract is not deployed. ` +
              `Use --skip-code-check to probe anyway.`,
          );
          process.exit(1);
        }
        contractCodeLower = code.toLowerCase();

        // Quick coverage check: how many ABI selectors appear in the code?
        const abiSelectorsFound = targetFns.filter((fn) => {
          const sig = `${fn.name}(${(fn.inputs || []).map((i: any) => i.type).join(',')})`;
          const sel = ethers.utils.id(sig).slice(2, 10).toLowerCase();
          return contractCodeLower!.includes(sel);
        }).length;
        const coverage = abiSelectorsFound / targetFns.length;

        if (coverage < 0.1) {
          // Almost nothing matches. Either (a) EIP-1967 proxy, (b) legacy
          // delegator proxy, (c) completely wrong ABI. Try EIP-1967 first.
          // Canonical slot = bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
          const EIP1967_IMPL_SLOT =
            '0x360894a13ba1a3210667c828492db98dcef42afd4e7f9f47de01b44f10e6fe2c';

          // HB#178 (#351) refinement: track whether the EIP-1967 lookup
          // resolved a real implementation. If it did, the proxy chain has
          // been fully unwound — there's no further indirection to try, so
          // a still-low coverage means the ABI is definitively wrong and
          // we should classify everything as not-implemented (rather than
          // falling back to the legacy-delegator "probe everything" path
          // and producing false positives). Only when the EIP-1967 lookup
          // did NOT resolve (slot zero, getStorageAt failed, impl code
          // empty) should we treat it as a legacy delegator and disable
          // the check entirely.
          let proxyResolved = false;
          try {
            const raw = await provider.getStorageAt(argv.address, EIP1967_IMPL_SLOT);
            const impl = '0x' + raw.slice(26);
            if (impl !== '0x0000000000000000000000000000000000000000') {
              const implCode = await provider.getCode(impl);
              if (implCode && implCode !== '0x') {
                contractCodeLower = implCode.toLowerCase();
                proxyResolved = true;
                if (!output.isJsonMode()) {
                  console.log(`  [proxy] followed EIP-1967 → impl ${impl}`);
                }
              }
            }
          } catch {
            // getStorageAt failed — some RPCs block state reads. Fall through.
          }

          // Re-check coverage after potential impl lookup.
          const recheck = targetFns.filter((fn) => {
            const sig = `${fn.name}(${(fn.inputs || []).map((i: any) => i.type).join(',')})`;
            const sel = ethers.utils.id(sig).slice(2, 10).toLowerCase();
            return contractCodeLower!.includes(sel);
          }).length;

          if (recheck / targetFns.length < 0.1) {
            if (proxyResolved) {
              // EIP-1967 resolved a real implementation but its code still
              // doesn't match the ABI. This is a DEFINITIVE wrong-ABI
              // signal — there's no further proxy indirection to unwind.
              // Keep contractCodeLower set so the per-function loop
              // classifies everything as not-implemented (correct
              // behavior, not false positives).
              if (!output.isJsonMode()) {
                console.log(
                  `  [probe] EIP-1967 implementation resolved but its code ` +
                    `still has <10% coverage of the supplied ABI. Classifying ` +
                    `all functions as not-implemented — wrong ABI for this ` +
                    `contract family.`,
                );
              }
            } else {
              // No EIP-1967 implementation was resolved. Could be a legacy
              // delegator proxy, custom dispatch, or unreachable storage.
              // Disable the selector check entirely and probe as before.
              // Strictly better than false-negatives; ABI-mismatch false
              // positives still possible here but that's the pre-#345
              // baseline behavior.
              contractCodeLower = null;
              if (!output.isJsonMode()) {
                console.log(
                  `  [probe] selector-presence check disabled: <10% of ABI ` +
                    `selectors found in runtime code AND no EIP-1967 impl ` +
                    `resolved (legacy proxy or unreachable storage). ` +
                    `Probing all functions; results may include ABI-mismatch ` +
                    `false positives.`,
                );
              }
            }
          }
        }
      } catch (err: any) {
        output.error(`Failed to fetch contract code: ${err.message}`);
        process.exit(1);
      }
    }

    // HB#382 task #384: probe-reliability heuristic. Detect ds-auth and Vyper
    // patterns in the runtime code. When either is detected, emit a warning
    // so operators interpret passed results correctly instead of treating
    // them as security findings. See detectProbeReliabilityPatterns docstring
    // for the full rationale.
    //
    // IMPORTANT: this heuristic needs to run even when --skip-code-check is
    // set (which is the common case for proxies like Maker Chief and Curve
    // VotingEscrow). The skip-code-check flag skips the SELECTOR COVERAGE
    // check (because proxies don't contain their implementation's selectors)
    // but the reliability heuristic is a DIFFERENT check: it needs the
    // IMPLEMENTATION's bytecode to scan for ds-auth/Vyper patterns. If we
    // already have contractCodeLower from the coverage check path, use it;
    // otherwise fetch the code here (trying EIP-1967 impl lookup too) for
    // the heuristic to scan. Tolerate fetch failures silently — the
    // heuristic is purely additive and shouldn't break the probe.
    let reliabilityCode: string | null = contractCodeLower;
    if (reliabilityCode === null) {
      try {
        const code = await provider.getCode(argv.address);
        if (code && code !== '0x') {
          reliabilityCode = code.toLowerCase();
          // Try EIP-1967 impl lookup for proxies so the heuristic sees the
          // real implementation's selectors, not the proxy's dispatch stub.
          const EIP1967_IMPL_SLOT =
            '0x360894a13ba1a3210667c828492db98dcef42afd4e7f9f47de01b44f10e6fe2c';
          try {
            const raw = await provider.getStorageAt(argv.address, EIP1967_IMPL_SLOT);
            const impl = '0x' + raw.slice(26);
            if (impl !== '0x0000000000000000000000000000000000000000') {
              const implCode = await provider.getCode(impl);
              if (implCode && implCode !== '0x') {
                reliabilityCode = implCode.toLowerCase();
              }
            }
          } catch {
            // EIP-1967 not applicable or RPC blocks state reads — use the
            // proxy code we already have.
          }
        }
      } catch {
        // Fetch failed — heuristic will return no warnings for null input.
      }
    }
    const reliability = detectProbeReliabilityPatterns(reliabilityCode);
    if (reliability.warnings.length > 0 && !output.isJsonMode()) {
      console.log('');
      for (const w of reliability.warnings) {
        console.log(`  ⚠ ${w}`);
      }
      console.log('');
    }

    const results: ProbeResult[] = [];

    for (const fn of targetFns) {
      const sig = `${fn.name}(${(fn.inputs || []).map((i: any) => i.type).join(',')})`;
      const selector = ethers.utils.id(sig).slice(0, 10);

      // Selector-presence check. Skip if --skip-code-check or no code fetched.
      if (contractCodeLower) {
        const selectorHex = selector.slice(2).toLowerCase(); // strip 0x
        if (!contractCodeLower.includes(selectorHex)) {
          results.push({
            name: fn.name,
            selector,
            status: 'not-implemented',
            likelyGate: 'selector not in contract runtime code — function not implemented on this target (ABI/contract family mismatch). Use --skip-code-check for proxies.',
          });
          continue;
        }
      }

      let inputs: any[];
      try {
        inputs = buildInputs(fn.inputs || []);
      } catch (err: any) {
        results.push({
          name: fn.name,
          selector,
          status: 'invalid-input',
          rawMessage: `could not build zero-args: ${err.message}`,
          likelyGate: 'unknown (could not encode probe args)',
        });
        continue;
      }

      try {
        // HB#298 task #408: use provider.call() directly instead of
        // contract.callStatic, AND inspect the return data for encoded
        // error signatures.
        //
        // Two distinct false-positive vectors fixed:
        //
        // 1. ethers v5 callStatic void-function bug: contract.callStatic
        //    for functions with empty outputs treats an EMPTY-DATA revert
        //    ("execution reverted" with data "0x") as SILENT SUCCESS.
        //    Fix: provider.call() returns the raw response for inspection.
        //
        // 2. RPC revert-in-success-path: some RPCs (notably Arbitrum's
        //    public endpoint) return revert data as a SUCCESS response
        //    instead of throwing. provider.call() doesn't throw, but the
        //    returned hex IS encoded revert data (Error(string),
        //    Panic(uint256), or a custom error selector). Fix: inspect
        //    the return data for known error selectors before treating
        //    the call as "passed".
        //
        // Together these cover: (a) proxy forwarding unknown selectors
        // that return empty reverts, (b) Arbitrum-style RPCs that embed
        // Error(string) in the success path, (c) assembly revert(0,0).
        const calldata = iface.encodeFunctionData(fn.name, inputs);
        const result = await provider.call({ to: argv.address as string, data: calldata, from: burner });

        // Check if the "success" response is actually encoded revert data.
        // Known error selectors:
        //   0x08c379a0 — Error(string) (require/revert with message)
        //   0x4e487b71 — Panic(uint256) (assert, overflow, etc.)
        const ERROR_STRING_PREFIX = '0x08c379a0';
        const PANIC_PREFIX = '0x4e487b71';

        if (result && result.length >= 10) {
          const resultPrefix = result.slice(0, 10).toLowerCase();

          if (resultPrefix === ERROR_STRING_PREFIX || resultPrefix === PANIC_PREFIX) {
            // Revert data in success response. Synthesize an error object
            // matching ethers' shape and fall through to the catch block's
            // existing decode logic.
            const synth: any = new Error('execution reverted (revert data in success response)');
            synth.data = result;
            throw synth;
          }

          // Check against ABI-defined custom error selectors.
          try {
            const parsed = iface.parseError(result);
            if (parsed) {
              const synth: any = new Error('execution reverted (custom error in success response)');
              synth.data = result;
              throw synth;
            }
          } catch (pe: any) {
            if (pe.data) throw pe; // Re-throw our synthesized error
            // parseError failed → not a known error, genuine return data
          }
        }

        // Empty result (0x) from a non-void function is suspicious: a
        // function that declares outputs should return data. Treat as a
        // revert with no data (catches proxy fallback returns where the
        // implementation doesn't recognize the selector).
        const hasOutputs = fn.outputs && fn.outputs.length > 0;
        if ((!result || result === '0x') && hasOutputs) {
          const synth: any = new Error('execution reverted with empty data (non-void function returned nothing)');
          synth.data = '0x';
          throw synth;
        }

        // Genuine pass — no revert, no error-encoded return data.
        results.push({
          name: fn.name,
          selector,
          status: 'passed',
          likelyGate: 'no revert from burner — fully permissionless or access check is silent',
        });
      } catch (err: any) {
        // Decode the revert. ethers v5 exposes errorName / errorSignature when
        // the error is in the Interface. Fallback to error.data parsing if not.
        let errorName: string | undefined = err.errorName || (err.error && err.error.errorName);
        let errorSignature: string | undefined = err.errorSignature || (err.error && err.error.errorSignature);
        let errorArgs: any[] | undefined = err.errorArgs;
        const errorData: string | undefined =
          err.data || (err.error && err.error.data) || (err.error && err.error.error && err.error.error.data);

        if (!errorName && errorData && typeof errorData === 'string' && errorData.length >= 10) {
          try {
            const parsed = iface.parseError(errorData);
            errorName = parsed.name;
            errorSignature = parsed.signature;
            errorArgs = Array.from(parsed.args);
          } catch {
            // Selector not in this contract's interface — surface raw selector
            errorName = `unknown(${errorData.slice(0, 10)})`;
          }
        }

        // HB#162 fix (#340): walk the ethers v5 error envelope for require-string
        // reasons. Old-style require(string) reverts (Compound Governor Bravo style)
        // store the reason in err.error.message or err.error.body or as raw
        // 0x08c379a0... data. The old extraction only checked err.reason || err.message
        // which was empty for many providers. extractRevertReason walks all the
        // known paths.
        const rawMessage = extractRevertReason(err);
        const isReentrancy = errorName === 'ReentrancyGuardReentrantCall';

        // Status: gated covers both custom-error reverts AND require-string
        // reverts that produced a meaningful reason. unknown only when we got
        // nothing usable.
        const hasUsefulInfo = !!errorName || !!rawMessage;
        results.push({
          name: fn.name,
          selector,
          status: isReentrancy ? 'reentrancy-guarded' : (hasUsefulInfo ? 'gated' : 'unknown'),
          errorName,
          errorSignature,
          errorArgs: errorArgs ? errorArgs.map((a) => (a && a._isBigNumber ? a.toString() : a)) : undefined,
          // ALWAYS surface the reason if we extracted one — operators want to see
          // the actual revert string, not just the gate classification.
          rawMessage: rawMessage || undefined,
          likelyGate: classifyGate(errorName, rawMessage),
        });
      }
    }

    // Output
    if (output.isJsonMode()) {
      output.json({
        address: argv.address,
        chainId: networkConfig.chainId,
        burnerAddress: burner,
        // HB#385 task #390: contract identity. contractName is always
        // populated when the target exposes a name() accessor; null
        // otherwise. nameCheck is only populated when --expected-name
        // was supplied. Together these let downstream consumers audit
        // the corpus for mislabeled artifacts without re-running the
        // probe.
        contractName: identity.contractName,
        nameCheck: identity.nameCheck,
        functionsProbed: results.length,
        // HB#382 task #384: surface the probe-reliability heuristic in
        // machine-readable output so downstream consumers (leaderboards,
        // audit pipelines, corpus builders) can decide how to interpret
        // the results.
        reliability: {
          dsAuth: reliability.dsAuth,
          vyper: reliability.vyper,
          voteEscrow: reliability.voteEscrow,
          warnings: reliability.warnings,
        },
        results,
      });
      return;
    }

    console.log('');
    console.log(`Burner-callStatic probe of ${argv.address}`);
    console.log(`Chain: ${networkConfig.chainId} | Burner: ${burner}`);
    console.log('═'.repeat(80));
    console.log(`${'Function'.padEnd(36)} ${'Status'.padEnd(20)} Likely Gate`);
    console.log('─'.repeat(80));
    for (const r of results) {
      const status =
        r.status === 'gated' ? `\x1b[32m✓ gated\x1b[0m`
        : r.status === 'reentrancy-guarded' ? `\x1b[32m✓ reentrancy\x1b[0m`
        : r.status === 'passed' ? `\x1b[33m⚠ passed\x1b[0m`
        : r.status === 'invalid-input' ? `\x1b[31m✗ no probe\x1b[0m`
        : `\x1b[31m✗ unknown\x1b[0m`;
      console.log(`${r.name.padEnd(36)} ${status.padEnd(35)} ${r.likelyGate}`);
      if (r.errorName && r.errorSignature) {
        console.log(`  ${' '.repeat(34)} ${'  '.padEnd(20)} (error: ${r.errorSignature})`);
      }
    }
    console.log('');
    console.log(`Summary: ${results.filter((r) => r.status === 'gated' || r.status === 'reentrancy-guarded').length} gated, ` +
      `${results.filter((r) => r.status === 'passed').length} passed-burner, ` +
      `${results.filter((r) => r.status === 'unknown' || r.status === 'invalid-input').length} unknown.`);
    // HB#382 task #384: repeat the reliability warnings at the end of the
    // summary so operators see them AFTER scanning the per-function table.
    // The earlier pre-probe warning (before the probe runs) may have
    // scrolled out of view for contracts with long ABIs.
    if (reliability.warnings.length > 0) {
      console.log('');
      console.log('⚠ Probe reliability warnings:');
      if (reliability.dsAuth) {
        console.log('  • ds-auth library detected — passed results on admin functions are probably tool artifacts');
      }
      if (reliability.vyper) {
        console.log('  • Vyper compiler signature detected — passed results on admin functions are probably tool artifacts');
      }
      console.log('  See the full warnings above and the HB#379/HB#380 audit reports in reports/audits/ for details.');
    }
    // HB#292 task #398: vote-escrow family tag. Informational only — no
    // reliability warning. Surfaces whether the target belongs to the
    // Curve-style VotingEscrow family so operators know to interpret
    // admin() / locked token / veCRV-style write methods in context.
    if (reliability.voteEscrow) {
      console.log('');
      console.log('ℹ Vote-escrow family detected (Curve veCRV-style VotingEscrow).');
      console.log('  Canonical write methods present: create_lock, increase_unlock_time, locked__end.');
      if (!reliability.vyper) {
        console.log('  Implementation: Solidity fork (Vyper markers absent). Probe-access is likely reliable for this contract.');
      }
    }
    console.log('');
  },
};
