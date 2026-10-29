import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readFileSync } from 'fs';
import { registrationChallenge, registrationDomain, REGISTER_ACCOUNT_TYPES, REGISTER_PASSKEY_ACCOUNT_TYPES } from '@poa-box/core/accounts/codecs';
import { buildRegisterAndQuickJoin, buildRegisterAndQuickJoinWithPasskey } from '@poa-box/core/tx/user';
import { buildUserProfileMetadata, replaceUserProfileMetadata, serializeUserProfileMetadata, USER_PROFILE_FIELDS } from '@poa-box/core/metadata/user';
import { encodeIntent, type TxIntent } from '@poa-box/core/tx/intent';
import * as output from '../../lib/output';
import { requireValidUsername } from '@poa-box/core/validation';
import { EXIT } from '../../lib/exit-codes';

/** Prepared inputs contain public proofs/authorization, never wallet keys. No I/O beyond the selected file. */
export function readPreparedInput(file: string): Record<string, any> {
  const input = JSON.parse(readFileSync(file, 'utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Prepared input must be a JSON object');
  return input;
}
export function preparedIntentOutput(intent: TxIntent) {
  return { prepared: true, broadcast: false, ...encodeIntent(intent), method: intent.method, meta: intent.meta };
}

export function prepareUserAction(action: string, input: Record<string, any>): unknown {
  switch (action) {
    case 'registration-challenge': {
      const kind = input.kind ?? 'passkey';
      if (kind !== 'eoa' && kind !== 'passkey') throw new Error('kind must be eoa or passkey');
      requireValidUsername(input.username);
      const challenge = registrationChallenge(input as any, kind);
      return { prepared: true, broadcast: false, kind, challenge,
        domain: registrationDomain(input.chainId, input.registryAddress),
        types: kind === 'eoa' ? REGISTER_ACCOUNT_TYPES : REGISTER_PASSKEY_ACCOUNT_TYPES,
        message: { user: input.user, username: input.username, nonce: String(input.nonce), deadline: String(input.deadline) } };
    }
    case 'register-and-join': return preparedIntentOutput(buildRegisterAndQuickJoin(input as any));
    case 'register-and-join-passkey': return preparedIntentOutput(buildRegisterAndQuickJoinWithPasskey(input as any));
    case 'profile': {
      if (input.mode !== 'patch' && input.mode !== 'replace') throw new Error('Profile mode must be patch or replace');
      if (!input.updates || typeof input.updates !== 'object' || Array.isArray(input.updates)) throw new Error('Profile updates must be an object');
      for (const field of USER_PROFILE_FIELDS) if (input.updates[field] !== undefined && typeof input.updates[field] !== 'string') throw new Error(`Invalid profile field: ${field}`);
      const metadata = input.mode === 'replace' ? replaceUserProfileMetadata(input.updates ?? {})
        : buildUserProfileMetadata(input.updates ?? {}, input.existing);
      return { prepared: true, broadcast: false, metadata, serialized: serializeUserProfileMetadata(metadata) };
    }
    default: throw new Error(`Unsupported user preparation: ${action}`);
  }
}

export const prepareHandler = {
  builder: (yargs: Argv) => yargs
    .positional('action', { choices: ['registration-challenge', 'register-and-join', 'register-and-join-passkey', 'profile'] as const })
    .option('file', { type: 'string', demandOption: true, describe: 'JSON public enrollment arguments or explicit profile merge inputs' })
    .example('pop user prepare registration-challenge --file challenge.json --json', 'Build a typed registration challenge locally')
    .epilogue('Prepares calldata only. The executing host must verify current chain, registry, nonce, deadline and passkey account; WebAuthn signing remains host-owned.'),
  handler: async (argv: ArgumentsCamelCase<{ action: string; file: string }>) => {
    try { output.json(prepareUserAction(argv.action, readPreparedInput(argv.file))); }
    catch (err: any) { output.error(err?.message || String(err)); process.exit(EXIT.USAGE); }
  },
};
