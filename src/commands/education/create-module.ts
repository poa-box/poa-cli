/**
 * pop education create — create a learning module that rewards PT.
 *
 * EducationHub.createModule(title, contentHash, payout, correctAnswer) —
 * verified contracts origin/main src/EducationHub.sol: onlyCreator (creator
 * hat / executor; a decoded NotCreator revert is the authority) and payout
 * must be 1..uint128.max. The correct answer is hashed into the module at
 * creation and can NEVER be changed by updateModule — pick it carefully.
 *
 * Metadata JSON key order ({name, description, link, quiz, answers}) MUST
 * match the frontend for subgraph/UI compatibility.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface CreateModuleArgs {
  org: string;
  name: string;
  description?: string;
  link?: string;
  payout: number;
  quiz?: string;
  answers?: string;
  'correct-answer': number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const createModuleHandler = {
  builder: (yargs: Argv) => yargs
    .option('name', { type: 'string', demandOption: true, describe: 'Module title' })
    .option('description', { type: 'string', describe: 'Module description' })
    .option('link', { type: 'string', describe: 'External learning resource URL' })
    .option('payout', { type: 'number', demandOption: true, describe: 'PT reward for completion (must be > 0)' })
    .option('quiz', { type: 'string', describe: 'JSON array of question strings: \'["Q1?", "Q2?"]\'' })
    .option('answers', { type: 'string', describe: 'JSON array of option arrays: \'[["A","B"],["C","D"]]\'' })
    .option('correct-answer', { type: 'number', demandOption: true, describe: 'Index of correct answer (0-based; PERMANENT — updateModule cannot change it)' })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Explicit idempotency key. Two identical creates within the TTL return the same result without re-submitting. Default: auto-derived from argv.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit a new module.',
    })
    .example('pop education create --name "Intro to POP" --payout 5 --correct-answer 0', 'Minimal module paying 5 PT')
    .example('pop education create --name "Quiz" --payout 5 --quiz \'["2+2?"]\' --answers \'[["3","4"]]\' --correct-answer 1', 'One-question quiz where option index 1 ("4") is correct'),

  handler: async (argv: ArgumentsCamelCase<CreateModuleArgs>) => {
    const spin = output.spinner('Creating education module...');
    spin.start();

    try {
      // ── 0. Fail fast on input problems before any network work ─────────
      if (!(argv.payout > 0) || !isFinite(argv.payout)) {
        throw new CliError(
          `--payout must be a positive number (the contract reverts InvalidPayout for 0), got: ${argv.payout}`,
          EXIT.USAGE
        );
      }
      const correctAnswer = argv.correctAnswer;
      if (!Number.isInteger(correctAnswer) || correctAnswer < 0 || correctAnswer > 255) {
        throw new CliError(`--correct-answer must be an integer 0-255 (uint8), got: ${correctAnswer}`, EXIT.USAGE);
      }

      let quiz: string[] = [];
      let answers: string[][] = [];
      if (argv.quiz) {
        try { quiz = JSON.parse(argv.quiz); } catch { throw new CliError('--quiz must be valid JSON array of strings', EXIT.USAGE); }
      }
      if (argv.answers) {
        try { answers = JSON.parse(argv.answers); } catch { throw new CliError('--answers must be valid JSON array of string arrays', EXIT.USAGE); }
      }
      if (quiz.length > 0 && answers.length > 0 && quiz.length !== answers.length) {
        throw new CliError(`Quiz has ${quiz.length} questions but ${answers.length} answer sets. They must match.`, EXIT.USAGE);
      }

      const ctx = await getWriteContext(argv);
      const educationHubAddress = requireModule(ctx.modules, 'educationHubAddress');

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: argv.preflight === false });
      spin.stop();

      await confirmWrite(argv, {
        name: argv.name,
        payout: `${argv.payout} PT`,
        questions: quiz.length || undefined,
        correctAnswer: `index ${correctAnswer} (permanent)`,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to create education module' });

      const run = async (): Promise<Record<string, any>> => {
        // Key order MUST match the frontend (and education/update.ts).
        const metadata = {
          name: argv.name,
          description: argv.description || '',
          link: argv.link || '',
          quiz,
          answers,
        };

        const txSpin = output.spinner('Pinning module metadata to IPFS...');
        txSpin.start();
        const cid = await pinJson(JSON.stringify(metadata));
        const contentHash = ipfsCidToBytes32(cid);

        const titleBytes = stringToBytes(argv.name);
        const payoutWei = ethers.utils.parseUnits(argv.payout.toString(), 18);

        txSpin.text = 'Sending transaction...';
        const contract = createWriteContract(educationHubAddress, 'EducationHubNew', ctx.signer);
        const result = await executeTx(
          contract,
          'createModule',
          [titleBytes, contentHash, payoutWei, correctAnswer],
          { dryRun: argv.dryRun }
        );
        txSpin.stop();

        const created = result.logs?.find(l => l.name === 'ModuleCreated');
        const moduleId = created?.args?.id?.toString();

        finishWrite(result, {
          successMsg: moduleId !== undefined
            ? `Education module #${moduleId} created`
            : 'Education module created',
          fields: {
            moduleId,
            ipfsCid: cid,
            payout: `${argv.payout} PT`,
          },
        });
        return { moduleId, ipfsCid: cid, txHash: result.txHash };
      };

      // Dry runs simulate unconditionally: they neither consult nor record
      // the idempotency cache (nothing lands on-chain).
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'education.create-module', run);
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
