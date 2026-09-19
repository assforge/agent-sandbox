import { normalizeLexical, rejectForbiddenMount } from '../config.js';
import { defaultCanonicalize } from '../resolve.js';
import type { WorkspaceEntry } from '../registry.js';
import { CliError, type MainDeps } from './deps.js';
/** Canonicalize and vet a mount path. Shared by configure/mount. Throws on refusal. */
export function vettedMount(deps: MainDeps, path: string): string {
  const canonical = defaultCanonicalize(path);
  const problem = rejectForbiddenMount(canonical, deps.homeDir);
  if (problem) throw new CliError(`refused mount ${canonical}: ${problem}`, 2);
  return canonical;
}
/** Drop a mount, refusing the workspace root. Shared by configure/unmount. */
export function dropMountFromEntry(entry: WorkspaceEntry, path: string): void {
  const canonicalDrop = defaultCanonicalize(path);
  if (normalizeLexical(canonicalDrop) === normalizeLexical(entry.root)) {
    throw new CliError(`cannot drop the workspace root mount: ${entry.root}`, 2);
  }
  entry.mounts = entry.mounts.filter((mount) => normalizeLexical(mount) !== normalizeLexical(canonicalDrop));
}
