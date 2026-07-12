/**
 * pop role create — create a new role hat via the EligibilityModule.
 *
 * createHatWithEligibility(CreateHatParams) — onlySuperAdmin (VERIFIED
 * against contracts origin/main src/EligibilityModule.sol). The tuple is
 * built in EXACT ABI order (verified in src/abi/EligibilityModuleNew.json
 * CreateHatParams components):
 *   (uint256 parentHatId, string details, uint32 maxSupply, bool _mutable,
 *    string imageURI, bool defaultEligible, bool defaultStanding,
 *    address[] mintToAddresses, bool[] wearerEligibleFlags,
 *    bool[] wearerStandingFlags)
 *
 * The module creates the hat with itself as the eligibility module and the
 * org ToggleModule as toggle, auto-activates it, and mints to any
 * --mint-to addresses. wearerEligibleFlags/wearerStandingFlags default to
 * TRUE per minted address so initial wearers are eligible even when the hat
 * defaults are false. Success parses HatCreatedWithEligibility for the new
 * hat ID.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { requireAddress } from '../../lib/validation';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { parseHatId, requireSuperAdmin } from '../vouch/helpers';

interface CreateArgs {
  org?: string;
  'parent-hat': string;
  name: string;
  image?: string;
  'max-supply': number;
  mutable?: boolean;
  'default-eligible'?: boolean;
  'default-standing'?: boolean;
  'mint-to'?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

/** Parse "--mint-to a,b,c" into checksummed addresses (empty when omitted). */
export function parseMintTo(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(addr => requireAddress(addr, 'mint-to'));
}

export const createHandler = {
  builder: (yargs: Argv) => yargs
    .option('parent-hat', { type: 'string', demandOption: true, describe: 'Parent hat ID the new role hangs under' })
    .option('name', { type: 'string', demandOption: true, describe: 'Role name (stored as the hat details)' })
    .option('image', { type: 'string', describe: 'Hat image URI (optional)' })
    .option('max-supply', { type: 'number', default: 1000, describe: 'Max simultaneous wearers (uint32)' })
    .option('mutable', { type: 'boolean', default: false, describe: 'Allow the hat\'s properties to be changed later' })
    .option('default-eligible', { type: 'boolean', default: false, describe: 'Wearers eligible by default' })
    .option('default-standing', { type: 'boolean', default: false, describe: 'Wearers in good standing by default' })
    .option('mint-to', { type: 'string', describe: 'Comma-separated addresses to mint the new hat to immediately' })
    .option('idempotency-key', { type: 'string', describe: 'Explicit idempotency key (repeat creates within the TTL return the prior result).' })
    .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache and always submit.' })
    .example('pop role create --parent-hat 123 --name "Reviewer" --mint-to 0xabc...,0xdef...', 'Create a Reviewer role and mint it to two members')
    .example('pop role create --parent-hat 123 --name "Member" --default-eligible --default-standing --mutable', 'Create an open role, editable later'),

  handler: async (argv: ArgumentsCamelCase<CreateArgs>) => {
    const spin = output.spinner('Preparing createHatWithEligibility...');
    spin.start();

    try {
      const parentHatId = parseHatId(argv['parent-hat'] ?? (argv as any).parentHat);
      const maxSupply = argv['max-supply'] ?? (argv as any).maxSupply ?? 1000;
      if (!Number.isInteger(maxSupply) || maxSupply <= 0 || maxSupply > 0xffffffff) {
        throw new CliError(`Invalid --max-supply ${maxSupply}.`, EXIT.USAGE, 'Pass a positive integer that fits uint32.');
      }
      const mintTo = parseMintTo(argv['mint-to'] ?? (argv as any).mintTo);
      const defaultEligible = Boolean((argv as any).defaultEligible ?? argv['default-eligible']);
      const defaultStanding = Boolean((argv as any).defaultStanding ?? argv['default-standing']);
      const isMutable = Boolean(argv.mutable);

      const ctx = await getWriteContext(argv);
      const eligibilityModuleAddress = requireModule(ctx.modules, 'eligibilityModuleAddress');

      // createHatWithEligibility is onlySuperAdmin (verified) — fail fast
      // naming the actual superAdmin before any gas is spent.
      if (argv.preflight !== false) {
        await requireSuperAdmin(ctx.provider, eligibilityModuleAddress, ctx.address, 'Creating a role hat');
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      // CreateHatParams tuple — MUST match ABI component order (see header).
      // wearerEligibleFlags/wearerStandingFlags: true per mint-to address so
      // initial wearers are eligible regardless of the hat defaults.
      const params = [
        parentHatId,                    // parentHatId (uint256)
        argv.name,                      // details (string)
        maxSupply,                      // maxSupply (uint32)
        isMutable,                      // _mutable (bool)
        argv.image ?? '',               // imageURI (string)
        defaultEligible,                // defaultEligible (bool)
        defaultStanding,                // defaultStanding (bool)
        mintTo,                         // mintToAddresses (address[])
        mintTo.map(() => true),         // wearerEligibleFlags (bool[])
        mintTo.map(() => true),         // wearerStandingFlags (bool[])
      ];

      await confirmWrite(argv, {
        name: argv.name,
        parentHat: parentHatId.toString(),
        maxSupply,
        mutable: isMutable ? 'yes' : 'no',
        defaults: `eligible=${defaultEligible}, standing=${defaultStanding}`,
        mintTo: mintTo.length > 0 ? mintTo.join(', ') : 'none',
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to create role hat' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Creating role hat...');
        txSpin.start();
        const contract = createWriteContract(eligibilityModuleAddress, 'EligibilityModuleNew', ctx.signer);
        const result = await executeTx(contract, 'createHatWithEligibility', [params], { dryRun: argv.dryRun });
        txSpin.stop();

        // HatCreatedWithEligibility(creator, parentHatId, newHatId,
        //   defaultEligible, defaultStanding, mintedCount) — verified in ABI.
        const createdEvent = result.logs?.find(l => l.name === 'HatCreatedWithEligibility');
        const newHatId = createdEvent?.args?.newHatId?.toString();
        const mintedCount = createdEvent?.args?.mintedCount !== undefined
          ? Number(createdEvent.args.mintedCount.toString())
          : (mintTo.length || undefined);

        finishWrite(result, {
          successMsg: newHatId
            ? `Role "${argv.name}" created — hat ${newHatId}`
            : `Role "${argv.name}" created`,
          fields: {
            hatId: newHatId,
            name: argv.name,
            parentHat: parentHatId.toString(),
            mintedCount,
            nextStep: newHatId ? `pop vouch config set --hat ${newHatId} --quorum <n> --membership-hat <id> (optional: enable vouching)` : undefined,
          },
        });
        return { hatId: newHatId, name: argv.name, txHash: result.txHash };
      };

      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'role.create', run);
      }
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
