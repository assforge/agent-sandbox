import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** Home directory name for sandbox host state. Groups with the .agent.* family. */
export const SANDBOX_DIR_NAME = '.agent.sandbox';

const LEGACY_DIR_NAME = '.sandbox';

/** Absolute path of the sandbox home directory. Single source of truth. */
export function sandboxDir(homeDir: string): string {
  return join(homeDir, SANDBOX_DIR_NAME);
}

/**
 * One-time move from the legacy home directory. Moves only when the new
 * directory does not exist yet and the legacy one does; never merges, so
 * a split state is impossible to create here. Returns true when it moved.
 */
export function migrateHomeDir(homeDir: string): boolean {
  const next = sandboxDir(homeDir);
  if (existsSync(next)) return false;
  const prev = join(homeDir, LEGACY_DIR_NAME);
  if (!existsSync(prev)) return false;
  renameSync(prev, next);
  return true;
}
