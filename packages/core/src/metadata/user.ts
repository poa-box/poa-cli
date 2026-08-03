/**
 * User-profile metadata — the document `pop user update-profile` pins to IPFS
 * before calling UniversalAccountRegistry.setProfileMetadata.
 *
 * Port of the merge logic in src/commands/user/update-profile.ts.
 *
 * KEY ORDER IS A PROTOCOL CONTRACT: keys are CONDITIONALLY PRESENT but appear
 * in the fixed order {bio, avatar, github, twitter, website} — a key is
 * included when the caller supplies a new value (even an empty string) OR the
 * existing indexed metadata carries a truthy value for it. The subgraph's
 * AccountMetadata mapping and the frontend both consume this document; do not
 * reorder or unconditionally include keys.
 */

import { CliError } from '../errors';
import { EXIT } from '../exit-codes';

/** The five profile fields, in canonical document order. */
export const USER_PROFILE_FIELDS = ['bio', 'avatar', 'github', 'twitter', 'website'] as const;
export type UserProfileField = (typeof USER_PROFILE_FIELDS)[number];

/**
 * Canonical profile document. Every key is optional (conditionally present),
 * but present keys always appear in the order bio, avatar, github, twitter,
 * website.
 */
export interface UserProfileMetadata {
  /** Bio, max 280 chars. */
  bio?: string;
  /** Avatar IPFS CID (Qm...). */
  avatar?: string;
  /** GitHub username. */
  github?: string;
  /** Twitter/X handle. */
  twitter?: string;
  /** Website URL. */
  website?: string;
}

/** New values for a profile edit. `undefined` = "leave this field alone". */
export interface UserProfileUpdates {
  bio?: string;
  avatar?: string;
  github?: string;
  twitter?: string;
  website?: string;
}

/**
 * Existing (indexed) metadata being merged over. Values may be null — the
 * subgraph serves null for unset fields.
 */
export type ExistingUserProfileMetadata = Partial<
  Record<UserProfileField, string | null | undefined>
>;

/**
 * Read-then-merge profile metadata builder.
 * Port of `pop user update-profile` — src/commands/user/update-profile.ts.
 *
 * Replicates the CLI's inclusion + precedence rules EXACTLY:
 *   - a key is included when `updates.<k> !== undefined` OR `existing.<k>` is
 *     truthy (so single-flag edits preserve the other fields, and an explicit
 *     empty string clears a field while keeping the key);
 *   - value precedence: updates.<k> ?? existing.<k> ?? '';
 *   - bio is capped at 280 chars (same error message and exit code).
 */
export function buildUserProfileMetadata(
  updates: UserProfileUpdates,
  existing?: ExistingUserProfileMetadata | null
): UserProfileMetadata {
  const prev = existing || {};
  const metadata: UserProfileMetadata = {};

  // Conditional keys, fixed order — order is load-bearing.
  if (updates.bio !== undefined || prev.bio) metadata.bio = updates.bio ?? prev.bio ?? '';
  if (updates.avatar !== undefined || prev.avatar) metadata.avatar = updates.avatar ?? prev.avatar ?? '';
  if (updates.github !== undefined || prev.github) metadata.github = updates.github ?? prev.github ?? '';
  if (updates.twitter !== undefined || prev.twitter) metadata.twitter = updates.twitter ?? prev.twitter ?? '';
  if (updates.website !== undefined || prev.website) metadata.website = updates.website ?? prev.website ?? '';

  if (metadata.bio && metadata.bio.length > 280) {
    throw new CliError(`Bio too long: ${metadata.bio.length}/280 chars`, EXIT.USAGE);
  }

  return metadata;
}

/**
 * Serialize with the exact conditional key order the CLI pins. Rebuilt with
 * explicit ordering so callers cannot accidentally pin a reordered document.
 */
export function serializeUserProfileMetadata(metadata: UserProfileMetadata): string {
  const ordered: UserProfileMetadata = {};
  if (metadata.bio !== undefined) ordered.bio = metadata.bio;
  if (metadata.avatar !== undefined) ordered.avatar = metadata.avatar;
  if (metadata.github !== undefined) ordered.github = metadata.github;
  if (metadata.twitter !== undefined) ordered.twitter = metadata.twitter;
  if (metadata.website !== undefined) ordered.website = metadata.website;
  return JSON.stringify(ordered);
}
