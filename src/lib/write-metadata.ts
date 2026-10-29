import { ethers } from 'ethers';
import { bytes32ToIpfsCid, pinJson } from './ipfs';
/** A dry-run uses a synthetic CID-shaped digest solely for calldata preview.
 * It does not claim a persisted/pinned UnixFS CID and is never published. */
export function pinWriteMetadata(content: string, dryRun?: boolean): Promise<string> {
  if (dryRun) return Promise.resolve(bytes32ToIpfsCid(ethers.utils.sha256(ethers.utils.toUtf8Bytes(content)))!);
  return pinJson(content);
}
