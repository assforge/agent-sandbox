import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { redactedConfig } from './config.js';
import type { WorkspaceEntry } from './registry.js';

export interface BackupRunner {
  /** Copy a path out of the running container to a host directory. */
  copyFromContainer: (container: string, containerPath: string, hostDir: string) => void;
  /** Copy a host directory back into the running container. */
  copyToContainer: (container: string, hostDir: string, containerPath: string) => void;
}

export interface BackupReceipt {
  outputDir: string;
  workspace: string;
  copiedState: boolean;
}

/**
 * Snapshot a workspace: redacted registry entry plus the container home
 * state. The caller must quiesce writers first; this function copies.
 */
export function backupWorkspace(
  runner: BackupRunner,
  entry: WorkspaceEntry,
  outputDir: string,
): BackupReceipt {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'workspace.json'), `${JSON.stringify(redactedConfig(entry), null, 2)}\n`, 'utf8');
  const stateDir = join(outputDir, 'home');
  mkdirSync(stateDir, { recursive: true });
  runner.copyFromContainer(entry.container, '/home/agent', stateDir);
  return { outputDir, workspace: entry.id, copiedState: true };
}

/** Restore a backup into the running container. Does not change the selected image. */
export function restoreWorkspace(runner: BackupRunner, entry: WorkspaceEntry, outputDir: string): BackupReceipt {
  runner.copyToContainer(entry.container, join(outputDir, 'home'), '/home/agent');
  return { outputDir, workspace: entry.id, copiedState: true };
}
