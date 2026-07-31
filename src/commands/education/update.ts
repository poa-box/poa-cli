/**
 * pop education update — edit a module's metadata and/or payout.
 *
 * updateModule(id, newTitle, newContentHash, newPayout) — verified against
 * contracts origin/main src/EducationHub.sol — is a FULL OVERWRITE of the
 * event-emitted metadata pair plus the stored payout, so this command reads
 * the current state first (payout from the chain via getModule, title +
 * metadata from the subgraph with an IPFS fallback — issued concurrently)
 * and merges only the flags the caller passed. Metadata is re-pinned ONLY
 * when its content actually changes — a payout-only edit keeps the current
 * contentHash.
 *
 * The payout is read on-chain and not from the indexed EducationModule.payout on purpose: a
 * full overwrite writes the read-back value, so a stale one silently reverts a concurrent
 * raise, and the same call is the ModuleUnknown existence gate.
 *
 * Contract gates (same verification): onlyCreator (creator hat / executor;
 * a decoded NotCreator revert is the authority), whenNotPaused, payout must
 * be 1..uint128.max, and the ANSWER HASH IS IMMUTABLE — updateModule never
 * touches answerHash, so changing quiz content cannot change which answer
 * index passes (remove + recreate to change the answer).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson, fetchJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32, bytes32ToIpfsCid, parseModuleId } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { formatToken } from '../../lib/format';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import { query } from '../../lib/subgraph';
import * as output from '../../lib/output';

interface UpdateModuleArgs {
  org: string;
  module: string;
  payout?: number;
  name?: string;
  description?: string;
  link?: string;
  quiz?: string;
  answers?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

/** Same field set as list.ts (schema-safe); title/contentHash for the merge. */
const FETCH_MODULES_FOR_UPDATE = `
  query FetchModulesForUpdate($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      educationHub {
        id
        modules(first: 100) {
          id
          moduleId
          title
          contentHash
          payout
          metadata {
            description
            link
            quiz
            answersJson
          }
        }
      }
    }
  }
`;

const METADATA_FLAGS = ['name', 'description', 'link', 'quiz', 'answers'] as const;

/** "old → new" when changed, plain value otherwise (for the confirm summary). */
function delta(oldValue: string, newValue: string): string {
  return oldValue === newValue ? oldValue : `${oldValue} → ${newValue}`;
}

function parseJsonArrayFlag(value: string, flag: string): any[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch {
    throw new CliError(`--${flag} must be a valid JSON array.`, EXIT.USAGE, `Example: --${flag} '["item1","item2"]'`);
  }
}

export const updateModuleHandler = {
  builder: (yargs: Argv) => yargs
    .option('module', { type: 'string', demandOption: true, describe: 'Module ID' })
    .option('payout', { type: 'number', describe: 'New PT reward for completion (must be > 0)' })
    .option('name', { type: 'string', describe: 'New module title (re-pins metadata)' })
    .option('description', { type: 'string', describe: 'New module description (re-pins metadata)' })
    .option('link', { type: 'string', describe: 'New external learning resource URL (re-pins metadata)' })
    .option('quiz', { type: 'string', describe: 'New JSON array of question strings (note: the correct answer is fixed at creation)' })
    .option('answers', { type: 'string', describe: 'New JSON array of option arrays (note: the correct answer is fixed at creation)' })
    .example('pop education update --module 2 --payout 10', 'Raise module 2\'s reward; metadata is preserved (no re-pin)')
    .example('pop education update --module 2 --name "Intro v2" --description "Updated"', 'Edit metadata; payout is preserved'),

  handler: async (argv: ArgumentsCamelCase<UpdateModuleArgs>) => {
    const spin = output.spinner('Reading current module state...');
    spin.start();

    try {
      // ── 0. Fail fast on input problems before any network work ─────────
      const metadataChanging = METADATA_FLAGS.some(flag => argv[flag] !== undefined);
      const payoutChanging = argv.payout !== undefined;
      if (!metadataChanging && !payoutChanging) {
        throw new CliError(
          'Nothing to update — pass at least one field flag.',
          EXIT.USAGE,
          'Available: --payout, --name, --description, --link, --quiz, --answers'
        );
      }
      if (payoutChanging && (!(argv.payout! > 0) || !isFinite(argv.payout!))) {
        throw new CliError(
          `--payout must be a positive number (the contract reverts InvalidPayout for 0), got: ${argv.payout}`,
          EXIT.USAGE
        );
      }
      const newQuiz = argv.quiz !== undefined ? parseJsonArrayFlag(argv.quiz, 'quiz') : undefined;
      const newAnswers = argv.answers !== undefined ? parseJsonArrayFlag(argv.answers, 'answers') : undefined;

      const ctx = await getWriteContext(argv);
      const educationHubAddress = requireModule(ctx.modules, 'educationHubAddress');
      const moduleId = parseModuleId(argv.module);

      // ── 1+2. READ: on-chain payout/existence AND the indexed metadata ──
      // Issued together: neither depends on the other, and they used to run
      // back-to-back for no reason.
      //
      // The payout deliberately STAYS on-chain even though EducationModule.payout is indexed
      // and populated (verified on live Gnosis). updateModule is a FULL OVERWRITE, and when
      // --payout is omitted this value is written straight back — so a payout that the subgraph
      // has not caught up with yet would silently ROLL BACK someone else's raise. The same call
      // is also the ModuleUnknown gate (EducationHub._module reverts when !m.exists, verified
      // against src/EducationHub.sol:255), which is a revert predictor for the write below.
      // One eth_call on an admin-only command is the right price for both.
      //
      // The chain stores only {answerHash, payout, exists}; title/contentHash are event-only,
      // so the subgraph remains the sole source for metadata preservation.
      const hub = createReadContract(educationHubAddress, 'EducationHubNew', ctx.provider);
      const [chainRead, indexedRead] = await Promise.allSettled([
        hub.getModule(moduleId),
        query<any>(FETCH_MODULES_FOR_UPDATE, { orgId: ctx.orgId }, argv.chain),
      ]);

      if (chainRead.status === 'rejected') {
        throw new PreconditionError(
          `Could not read module ${moduleId} on-chain — it may not exist (getModule reverts ModuleUnknown).`,
          'List modules with: pop education list'
        );
      }
      const currentPayout: ethers.BigNumber = chainRead.value[0];

      // Subgraph unavailable — handled below based on what the merge needs.
      let subgraphModule: any = null;
      if (indexedRead.status === 'fulfilled') {
        const modules = indexedRead.value.organization?.educationHub?.modules || [];
        subgraphModule = modules.find((m: any) => String(m.moduleId) === String(moduleId)) || null;
      }

      let ipfsMetadata: any = null;
      const currentCid = subgraphModule?.contentHash ? bytes32ToIpfsCid(subgraphModule.contentHash) : null;
      if (currentCid) {
        try {
          ipfsMetadata = await fetchJson(currentCid);
        } catch { /* IPFS lag — fall back to subgraph fields */ }
      }

      const currentName: string | undefined = ipfsMetadata?.name ?? subgraphModule?.title ?? undefined;
      const currentDescription: string | undefined = ipfsMetadata?.description ?? subgraphModule?.metadata?.description ?? undefined;
      const currentLink: string | undefined = ipfsMetadata?.link ?? subgraphModule?.metadata?.link ?? undefined;
      const currentQuiz: any[] | undefined = ipfsMetadata?.quiz ?? subgraphModule?.metadata?.quiz ?? undefined;
      let currentAnswers: any[] | undefined = ipfsMetadata?.answers;
      if (currentAnswers === undefined && subgraphModule?.metadata?.answersJson) {
        try {
          currentAnswers = JSON.parse(subgraphModule.metadata.answersJson);
        } catch { /* unparseable — treated as unknown */ }
      }
      const currentContentHash: string | undefined = subgraphModule?.contentHash ?? undefined;

      // updateModule overwrites title + contentHash even when only --payout
      // changed — so the current values must be recoverable.
      if (!metadataChanging && (currentName === undefined || !currentContentHash)) {
        throw new CliError(
          `Module ${moduleId} metadata is not indexed yet (subgraph lag) — cannot preserve the current title/metadata through a full-overwrite update.`,
          EXIT.INFRA,
          'Retry in a few seconds, or pass --name and --description explicitly.'
        );
      }
      if (metadataChanging
        && (argv.name === undefined || argv.description === undefined)
        && (currentName === undefined || currentDescription === undefined)) {
        throw new CliError(
          `Module ${moduleId} metadata is not indexed yet (subgraph lag) — cannot merge a partial metadata edit.`,
          EXIT.INFRA,
          'Retry in a few seconds, or pass BOTH --name and --description.'
        );
      }

      // ── 3. MERGE: flags override, everything else preserved ────────────
      const finalPayout = payoutChanging
        ? ethers.utils.parseUnits(argv.payout!.toString(), 18)
        : currentPayout;
      const finalName = argv.name ?? currentName ?? '';
      const finalDescription = argv.description ?? currentDescription ?? '';
      const finalLink = argv.link ?? currentLink ?? '';
      const finalQuiz = newQuiz ?? currentQuiz ?? [];
      const finalAnswers = newAnswers ?? currentAnswers ?? [];

      if (finalQuiz.length > 0 && finalAnswers.length > 0 && finalQuiz.length !== finalAnswers.length) {
        throw new CliError(
          `Quiz has ${finalQuiz.length} questions but ${finalAnswers.length} answer sets. They must match.`,
          EXIT.USAGE
        );
      }

      // Re-pin only when the metadata content actually changes.
      let finalContentHash = currentContentHash
        ? currentContentHash
        : ethers.constants.HashZero;
      let newCid: string | undefined;
      const metadataActuallyChanged = metadataChanging && (
        finalName !== currentName
        || finalDescription !== (currentDescription ?? '')
        || finalLink !== (currentLink ?? '')
        || JSON.stringify(finalQuiz) !== JSON.stringify(currentQuiz ?? [])
        || JSON.stringify(finalAnswers) !== JSON.stringify(currentAnswers ?? [])
      );
      if (metadataActuallyChanged) {
        if (!ipfsMetadata && !subgraphModule?.metadata) {
          output.warn('Current metadata could not be fetched — unspecified metadata fields reset to defaults in the re-pinned JSON.');
        }
        // Key order MUST match src/commands/education/create-module.ts
        // (frontend/subgraph parity).
        const metadataJson = {
          name: finalName,
          description: finalDescription,
          link: finalLink,
          quiz: finalQuiz,
          answers: finalAnswers,
        };
        spin.text = 'Pinning updated metadata to IPFS...';
        newCid = await pinJson(JSON.stringify(metadataJson));
        finalContentHash = ipfsCidToBytes32(newCid);
      }

      // ── 4. Pre-flight (skippable with --no-preflight) ──────────────────
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: argv.preflight === false });
      spin.stop();

      if (newQuiz !== undefined || newAnswers !== undefined) {
        output.warn(
          'The correct answer is fixed at creation — updateModule never changes the answer hash. ' +
          'If the new quiz needs a different correct answer, remove and recreate the module.'
        );
      }

      // ── 5. Confirm with the FULL final field set (old → new) ───────────
      await confirmWrite(argv, {
        module: moduleId,
        payout: delta(formatToken(currentPayout, 18, 'PT'), formatToken(finalPayout, 18, 'PT')),
        title: delta(currentName ?? '(unknown)', finalName),
        description: metadataActuallyChanged ? delta(currentDescription ?? '(unknown)', finalDescription) : undefined,
        link: metadataActuallyChanged ? delta(currentLink ?? '(none)', finalLink || '(none)') : undefined,
        metadata: metadataActuallyChanged ? 're-pinned to IPFS' : 'unchanged (no re-pin)',
      }, { actionLabel: `Update education module ${moduleId} (full overwrite)` });

      const txSpin = output.spinner('Sending updateModule...');
      txSpin.start();
      const contract = createWriteContract(educationHubAddress, 'EducationHubNew', ctx.signer);
      const result = await executeTx(contract, 'updateModule', [
        moduleId,
        stringToBytes(finalName),
        finalContentHash,
        finalPayout,
      ], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Module ${moduleId} updated`,
        fields: {
          moduleId,
          payout: formatToken(finalPayout, 18, 'PT'),
          title: finalName,
          ipfsCid: newCid,
          metadataChanged: metadataActuallyChanged || undefined,
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
