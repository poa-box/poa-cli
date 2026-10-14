/** Diagnostic compatibility only. No historical methods, permissions or grants. */
import { ethers } from "ethers";

export const HISTORICAL_EXTERNAL_ERROR_FRAGMENTS: readonly string[] = [
  "error AllHatsWorn(uint256)",
  "error AlreadyWearingHat(address,uint256)",
  "error ApplicationAlreadyExists()",
  "error DefaultEligibilityConflictsWithVouch()",
  "error ETHTransferFailed()",
  "error HatNotActive()",
  "error InsufficientDelivery(uint256,uint256)",
  "error InvalidApplicationHash()",
  "error InvalidHatId()",
  "error InvalidJoinTime()",
  "error InvalidMembershipHat()",
  "error InvalidUser()",
  "error NewUserVouchingRestricted()",
  "error NoActiveApplication()",
  "error NoPendingRecovery()",
  "error NotAdmin(address,uint256)",
  "error NotAuthorizedAdmin()",
  "error NotAuthorizedEmailVerifier()",
  "error NotAuthorizedExecutor()",
  "error NotAuthorizedToVouch()",
  "error NotEligible()",
  "error NotOwner()",
  "error NotSuperAdmin()",
  "error NotToggleAdmin()",
  "error RequestHashAlreadyFailed()",
  "error VouchingNotEnabled()",
  "error VouchingRateLimitExceeded()",
  "error WouldDrainRecoveryFunds()",
  "error WrongToken(address,address)",
  "error ZeroDepositor()"
];

/** Hats NotAdmin collides by name with a different hub error: keep its historical alias. */
export const HISTORICAL_EXTERNAL_ERROR_NAMES: Readonly<Record<string, string>> = {
  "0x0cd96ab8": "AllHatsWorn",
  "0x643d2083": "AlreadyWearingHat",
  "0x0b792c8f": "ApplicationAlreadyExists",
  "0x70414907": "DefaultEligibilityConflictsWithVouch",
  "0xb12d13eb": "ETHTransferFailed",
  "0xe629aba3": "HatNotActive",
  "0x0710b3e1": "InsufficientDelivery",
  "0x391ab2ea": "InvalidApplicationHash",
  "0xb43a0650": "InvalidHatId",
  "0xade46c67": "InvalidJoinTime",
  "0xd5f24564": "InvalidMembershipHat",
  "0xfd684c3b": "InvalidUser",
  "0x594ea677": "NewUserVouchingRestricted",
  "0xa4f5cfae": "NoActiveApplication",
  "0xd1e1fa49": "NoPendingRecovery",
  "0xf921ec01": "NotAdminHats",
  "0x9fa7b4bb": "NotAuthorizedAdmin",
  "0x9d28e06e": "NotAuthorizedEmailVerifier",
  "0x69d6514c": "NotAuthorizedExecutor",
  "0xd059c6eb": "NotAuthorizedToVouch",
  "0xf8eb54de": "NotEligible",
  "0x30cd7471": "NotOwner",
  "0x16c726b1": "NotSuperAdmin",
  "0xb8d29e28": "NotToggleAdmin",
  "0x15236fdf": "RequestHashAlreadyFailed",
  "0xf536e173": "VouchingNotEnabled",
  "0x76370673": "VouchingRateLimitExceeded",
  "0xde7ad8ef": "WouldDrainRecoveryFunds",
  "0x2d6ac127": "WrongToken",
  "0xe5d19efb": "ZeroDepositor"
};

export function historicalExternalErrorInterface(): ethers.utils.Interface {
  return new ethers.utils.Interface([...HISTORICAL_EXTERNAL_ERROR_FRAGMENTS]);
}
