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
 * Whether the one-time move is still pending. Read-only on purpose:
 * doctor is a probe, so it reports a pending move instead of performing
 * it. Never merges, so a split state is impossible to describe here.
 */
export function homeMovePending(homeDir: string): boolean {
  return !existsSync(sandboxDir(homeDir)) && existsSync(join(homeDir, LEGACY_DIR_NAME));
}

/**
 * One-time move from the legacy home directory. Moves only when the new
 * directory does not exist yet and the legacy one does. Returns true when
 * it moved. Mutating: callers that must not write (doctor) use
 * homeMovePending instead.
 */
export function migrateHomeDir(homeDir: string): boolean {
  if (!homeMovePending(homeDir)) return false;
  renameSync(join(homeDir, LEGACY_DIR_NAME), sandboxDir(homeDir));
  return true;
}
