/**
 * pop zkemail check <identifier> — is this domain/address invited, and can it still claim?
 *
 * Answers the three questions an operator actually gets asked:
 *   1. what is this identifier's circuit commitment (Poseidon leaf id)?
 *   2. is it in the active allowlist, and for which role hats?
 *   3. has a specific address already been used to claim (registeredEmails dedup)?
 *
 * `--proof` additionally emits the merkle proof, which is what a claimant needs to submit
 * alongside a ZK proof. Generating the ZK proof itself needs the circuit witness and is a
 * browser/prover concern — see `pop zkemail check --help`.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveZkEmailModule, readModuleState, fetchRoleNames, labelHat } from './helpers';
import { domainHash, emailHash, assertRootMatches, proofForDomain, proofForEmailHash, isPrintableAscii, dkimSeededFromIndex } from '../../lib/zkemail';
import { createReadContract } from '../../lib/contracts';
import { resolveNetworkConfig } from '../../config/networks';
import { fetchJson } from '../../lib/ipfs';
import { query } from '../../lib/subgraph';
import { FETCH_ZKEMAIL_REGISTERED_EMAIL } from '../../queries/zkemail';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface CheckArgs {
  identifier: string;
  org?: string;
  chain?: number;
  proof?: boolean;
}

/**
 * Is any currently-valid DKIM key registered for `domainLeafId`?
 *
 * PoaDKIMRegistry exposes only `isKeyHashValid(domainHash, keyHash)` — there is no
 * "any key for this domain" getter — so enumerate candidate key hashes from the indexed
 * `KeyHashSet(bytes32 indexed domainHash, ...)` events and re-check each against live state
 * (an event may since have been revoked or expired).
 *
 * Returns null when the probe itself could not run: some RPC providers reject wide
 * `eth_getLogs` ranges, and "we could not check" must never render as "not seeded".
 *
 * Reached only when `state.indexedWiring` is false, which is NOT unreachable: Gnosis serves the
 * post-#197 subgraph (keys indexed, so `dkimSeededFromIndex` answers instead), but ARBITRUM
 * runs deployment QmYGCS4pXoaqXX7WjaPEhA56kiwgC14z7jsstZzEQgxgUp, which has no PoaDkimRegistry
 * entity at all — introspecting it for `ZkEmailClaim`/`PoaDkimRegistry` returns null. Verified
 * 2026-07. This scan is the only answer available on that chain, so it stays.
 */
async function probeDkimSeeded(
  provider: ethers.providers.Provider,
  registry: string,
  domainLeafId: string
): Promise<boolean | null> {
  try {
    const iface = new ethers.utils.Interface([
      'event KeyHashSet(bytes32 indexed domainHash, bytes32 indexed keyHash, bool valid, uint256 validUntil)',
      'function isKeyHashValid(bytes32 domainHash, bytes32 keyHash) view returns (bool)',
    ]);
    const logs = await provider.getLogs({
      address: registry,
      topics: [iface.getEventTopic('KeyHashSet'), ethers.utils.hexZeroPad(domainLeafId, 32)],
      fromBlock: 0,
      toBlock: 'latest',
    });
    if (logs.length === 0) return false;

    const c = new ethers.Contract(registry, iface, provider);
    const keyHashes = Array.from(new Set(logs.map(l => iface.parseLog(l).args.keyHash as string)));
    const results = await Promise.all(keyHashes.map(k => c.isKeyHashValid(domainLeafId, k).catch(() => false)));
    return results.some(Boolean);
  } catch {
    return null;
  }
}


export const checkHandler = {
  command: 'check <identifier>',
  builder: (yargs: Argv) => yargs
    .positional('identifier', { type: 'string', describe: 'A domain (anthropic.com) or address (alice@org.com)' })
    .option('proof', { type: 'boolean', default: false, describe: 'Also emit the merkle proof for this entry' })
    .example('pop zkemail check anthropic.com', 'Is this domain invited, and to which roles?')
    .example('pop zkemail check alice@org.com --proof', 'Entry details plus the merkle proof for claiming')
    .epilogue(
      'The merkle proof is only half of a claim — the other half is a Groth16 proof over a '
      + 'DKIM-signed email, which requires the circuit witness and is produced in the browser.'
    ),

  handler: async (argv: ArgumentsCamelCase<CheckArgs>) => {
    const spin = output.spinner('Checking allowlist...');
    spin.start();

    try {
      const raw = String(argv.identifier || '').trim();
      if (!raw) throw new CliError('Pass a domain or email address to check.', EXIT.USAGE);
      if (!isPrintableAscii(raw)) {
        throw new CliError(
          `"${raw}" contains non-ASCII characters, which no email proof can match on-chain.`,
          EXIT.USAGE,
          'Use the plain ASCII domain or address.'
        );
      }
      const atCount = (raw.match(/@/g) || []).length;
      const isEmail = atCount > 0;
      if (isEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
        // The circuit's From-regex splits at the FIRST '@' and packs the raw bytes, so a display
        // name ("Alice <alice@org.com>") or a quoted local part hashes to something no proof can
        // reproduce. Reject rather than silently answering about the wrong identifier.
        throw new CliError(
          `"${raw}" is not a bare email address.`,
          EXIT.USAGE,
          'Pass just the address (alice@org.com), with no display name, angle brackets, or quoting.'
        );
      }

      const { orgId, orgName, address, subgraph } = await resolveZkEmailModule(argv.org, argv.chain);
      const networkConfig = resolveNetworkConfig(argv.chain);
      const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc);
      // Root/CID (and, post-#197, the wiring + DKIM keys) come from the subgraph. The provider
      // is only still needed on a pre-#197 deployment, for the isEmailRegistered eth_call and
      // the DKIM log scan.
      const state = await readModuleState(address, orgId, orgName, argv.chain, provider, { subgraph, withDkimRegistry: true });

      // The circuit splits the From address at the FIRST '@' (PopRoleClaim's from_domain
      // constrains no earlier '@'), so the domain is everything after it — not after the last.
      const domainPart = isEmail ? raw.slice(raw.indexOf('@') + 1) : raw;
      const leafId = isEmail ? await emailHash(raw) : await domainHash(raw);
      // The domain leaf commits Poseidon(domain); an email matched via its domain must reproduce
      // THIS value, not leafId. Operators also need it to seed the DKIM registry.
      const domainLeafId = await domainHash(domainPart);

      // registeredEmails dedup applies to SPECIFIC-ADDRESS claims only.
      //
      // Post-#197 this is a ZkEmailRegisteredEmail row. Absence is meaningful there — the
      // handler writes a row on every claim — so "no row" is a definitive false, not unknown.
      //
      // The eth_call arm is live support, not dead code: the Arbitrum deployment
      // (QmYGCS4pXoaqXX7WjaPEhA56kiwgC14z7jsstZzEQgxgUp) has no ZkEmailRegisteredEmail type in
      // its schema at all, so querying for one there fails validation outright — hence the
      // branch on indexedWiring rather than a try/catch. Verified by introspection 2026-07.
      let alreadyRegistered: boolean | null = null;
      if (isEmail) {
        if (state.indexedWiring) {
          const rid = `${address.toLowerCase()}-${leafId.toLowerCase()}`;
          const reg = await query<{ zkEmailRegisteredEmail: any }>(
            FETCH_ZKEMAIL_REGISTERED_EMAIL, { id: rid }, argv.chain
          ).catch(() => ({ zkEmailRegisteredEmail: null }));
          alreadyRegistered = reg.zkEmailRegisteredEmail?.registered === true;
        } else {
          const c = createReadContract(address, 'ZkEmailInvites', provider);
          alreadyRegistered = await c.isEmailRegistered(leafId);
        }
      }

      // Evaluate BOTH claim paths independently. They are distinct leaves (kind 1 vs kind 0) with
      // different dedup rules, so an address listed individually AND covered by a domain entry has
      // two routes — and once its specific-address registration is spent, the domain route is the
      // one that still works. Picking only the first match would report a false "cannot claim".
      let emailMatch: { hatIds: string[]; proof: string[] } | null = null;
      let domainMatch: { hatIds: string[]; proof: string[] } | null = null;

      if (!state.dormant && !state.allowlistCid) {
        // setActiveAllowlist takes root and cid independently, so a live root with a zero CID is
        // reachable. There is no file to search, and reporting a definitive "not invited" would
        // be a guess — say so instead.
        spin.stop();
        throw new CliError(
          'The module has an active merkle root but no allowlist CID, so the entry list cannot be fetched.',
          EXIT.PRECONDITION,
          'Governance must re-run setActiveAllowlist with both the root and the pinned CID.'
        );
      }

      if (!state.dormant && state.allowlistCid) {
        spin.text = 'Fetching allowlist from IPFS...';
        const doc = await fetchJson<any>(state.allowlistCid);
        if (!doc) {
          spin.stop();
          throw new CliError(
            `Could not fetch allowlist ${state.allowlistCid} from IPFS.`,
            EXIT.INFRA,
            'The allowlist file may be unpinned — members cannot claim until it is retrievable.'
          );
        }
        // Guard against a swapped CID before trusting any answer derived from it.
        const tree = assertRootMatches(doc, state.merkleRoot);
        if (isEmail) emailMatch = proofForEmailHash(tree, leafId);
        domainMatch = await proofForDomain(tree, domainPart);
      }

      // Prefer the route that actually works: the specific-address entry unless its one
      // registration is already spent, otherwise the domain entry.
      const emailUsable = Boolean(emailMatch) && alreadyRegistered !== true;
      const matchedVia: 'email' | 'domain' | null = emailUsable ? 'email' : domainMatch ? 'domain' : emailMatch ? 'email' : null;
      const chosen = matchedVia === 'email' ? emailMatch : matchedVia === 'domain' ? domainMatch : null;
      const inAllowlist = Boolean(emailMatch || domainMatch);
      const hatIds = chosen?.hatIds ?? [];
      const proof = chosen?.proof ?? null;
      // The leaf the emitted proof belongs to — what a claimant must reproduce.
      const proofLeafId = matchedVia === 'domain' ? domainLeafId : leafId;

      // Every claim also needs a valid DKIM key for the PROVEN sending domain
      // (_commonPreChecks reverts InvalidDKIMKey), and the registry is keyed by the Poseidon
      // domain hash — not keccak. An unseeded domain is the most common real claim failure.
      //
      // Post-#197 the registry's keys are indexed, so this is a field read on data we already
      // fetched. Pre-#197 it falls back to an eth_getLogs scan, which some RPCs reject — hence
      // the tri-state: null means "could not determine", which must never render as "no".
      const dkimSeeded = state.indexedWiring
        ? dkimSeededFromIndex(subgraph.dkimRegistry, domainLeafId)
        : state.dkimRegistry
          ? await probeDkimSeeded(provider, state.dkimRegistry, domainLeafId)
          : null;

      const roleNames = await fetchRoleNames(orgId, argv.chain);
      spin.stop();

      const blockedByRegistration = matchedVia === 'email' && alreadyRegistered === true;
      // Named for what it actually proves. The remaining gates (DKIM validity at proof time, hat
      // eligibility, and the open-claim probe) are enforced on-chain and are not all knowable here.
      const allowlistPermitsClaim = !state.dormant && inAllowlist && !blockedByRegistration;

      // Gates the CLI cannot settle: hat eligibility and the open-claim probe are evaluated
      // against live Hats state at claim time, and DKIM validity binds a specific key hash.
      const uncheckedGates = ['hatEligibility', 'hatNotOpenlyClaimable'];
      if (dkimSeeded === null) uncheckedGates.push('dkimKeySeeded');

      if (output.isJsonMode()) {
        output.json({
          identifier: raw,
          type: isEmail ? 'email' : 'domain',
          leafId,
          domain: domainPart,
          domainLeafId,
          module: address,
          dormant: state.dormant,
          inAllowlist,
          matchedVia,
          matchedByEmailEntry: Boolean(emailMatch),
          matchedByDomainEntry: Boolean(domainMatch),
          hatIds,
          hatNames: hatIds.map(h => roleNames.get(h) ?? null),
          alreadyRegistered,
          dkimSeeded,
          allowlistPermitsClaim,
          uncheckedGates,
          claimMethod: matchedVia === 'domain' ? 'claimRoleByDomain' : matchedVia === 'email' ? 'claimRoleByEmail' : null,
          // The leaf this proof belongs to, and the exact hatIds array to submit with it — the
          // array order is part of the leaf preimage, so it must be passed verbatim.
          proofLeafId: argv.proof ? proofLeafId : undefined,
          merkleProof: argv.proof ? proof : undefined,
        });
        return;
      }

      const viaDomainFallback = matchedVia === 'domain' && isEmail;
      const invitedLabel = !inAllowlist
        ? 'no'
        : viaDomainFallback
          ? `yes — via the "${domainPart}" domain entry`
          : matchedVia === 'email'
            ? 'yes — listed individually'
            : 'yes — domain entry';

      output.keyValueBlock(`${isEmail ? 'Address' : 'Domain'}: ${raw}`, {
        leafId,
        ...(isEmail ? { domainLeafId: `${domainLeafId}  (${domainPart})` } : {}),
        module: address,
        allowlist: state.dormant ? 'DORMANT (no allowlist committed)' : state.merkleRoot,
        invited: invitedLabel,
        grants: hatIds.length ? hatIds.map(h => labelHat(h, roleNames)).join(', ') : '(none)',
        // registeredEmails only gates the specific-address path, so only report it there.
        ...(isEmail && emailMatch
          ? { addressEntryUsed: alreadyRegistered ? 'yes — its one registration is spent' : 'no' }
          : {}),
        dkimKey: dkimSeeded === null ? 'could not check' : dkimSeeded ? 'seeded' : 'NOT SEEDED',
        claimVia: matchedVia === 'domain' ? 'claimRoleByDomain' : matchedVia === 'email' ? 'claimRoleByEmail' : '(n/a)',
        allowlistPermitsClaim: allowlistPermitsClaim ? 'yes' : 'no',
      });

      if (allowlistPermitsClaim && dkimSeeded === false) {
        output.warn(
          `The allowlist invites this ${isEmail ? 'address' : 'domain'}, but no valid DKIM key is `
          + `registered for "${domainPart}", so every claim will revert InvalidDKIMKey. Seed the `
          + `registry at ${state.dkimRegistry} with setKeyHash(${domainLeafId}, <keyHash>, true) — `
          + 'note the key is the POSEIDON domain hash above, not keccak.'
        );
      }

      if (allowlistPermitsClaim) {
        output.info(
          'This confirms the allowlist and registration state only. A claim is additionally gated '
          + 'on-chain by hat eligibility and the open-claim probe, which are evaluated at claim time.'
        );
      }

      if (isEmail) {
        output.info(
          'leafId is the Poseidon commitment of the ADDRESS, not of any single email. '
          + 'A specific-address entry allows ONE registration per address; a domain entry has no '
          + 'per-address limit (only a per-message nullifier).'
        );
      }

      if (argv.proof) {
        if (proof) {
          output.keyValueBlock('Merkle proof', {
            forLeaf: `${proofLeafId} (kind ${matchedVia === 'domain' ? '0 domain' : '1 email'})`,
            // Order is part of the leaf preimage — a reordered array hashes to a different leaf
            // and reverts NotInAllowlist, so give the claimant the exact array to submit.
            hatIds: `[${hatIds.join(', ')}]  — submit in EXACTLY this order`,
            depth: proof.length,
          });
          for (const p of proof) console.log(`  ${p}`);
          output.info('A claim also needs a Groth16 proof over a DKIM-signed email (browser prover).');
        } else {
          output.warn('No merkle proof — this identifier is not in the active allowlist.');
        }
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
