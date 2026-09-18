import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { redactedConfig } from './config.js';
import type { Registry, WorkspaceEntry } from './registry.js';

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
 * Snapshot a workspace: registry entry plus the container home state.
 * The caller must hold the workspace lock and quiesce writers first.
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

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`backup workspace.json has an invalid ${key}`);
  }
  return value;
}

function requiredName(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error(`backup workspace.json has an unsafe ${key}: ${value}`);
  }
  return value;
}

function requiredRoot(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (!value.startsWith('/')) {
    throw new Error(`backup workspace.json has a non-absolute ${key}: ${value}`);
  }
  return value;
}

/**
 * Restore a backup: reinstates the registry entry (recreating it when the
 * workspace was lost) and copies the home state back into the container.
 * The caller saves the registry under the workspace lock. The selected
 * image is restored as recorded; data migrations are never reversed.
 */
export function restoreWorkspace(runner: BackupRunner, registry: Registry, outputDir: string): WorkspaceEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(outputDir, 'workspace.json'), 'utf8'));
  } catch {
    throw new Error(`backup is missing or invalid: ${join(outputDir, 'workspace.json')}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('backup workspace.json has an unexpected shape');
  }
  const record = parsed as Record<string, unknown>;
  const id = requiredName(record, 'id');
  const rawMounts = record['mounts'];
  const mounts = Array.isArray(rawMounts) && rawMounts.every((mount): mount is string => typeof mount === 'string') ? rawMounts : [];
  const entry: WorkspaceEntry = {
    id,
    root: requiredRoot(record, 'root'),
    container: requiredName(record, 'container'),
    image: typeof record['image'] === 'string' ? (record['image'] as string) : null,
    previousImage: typeof record['previousImage'] === 'string' ? (record['previousImage'] as string) : null,
    session: requiredName(record, 'session'),
    instances: [],
    homeVolume: requiredName(record, 'homeVolume'),
    network: record['network'] === 'restricted' ? 'restricted' : 'open',
    runtime: typeof record['runtime'] === 'string' && record['runtime'].length > 0 ? (record['runtime'] as string) : 'docker',
    terminal: typeof record['terminal'] === 'string' && record['terminal'].length > 0 ? (record['terminal'] as string) : 'tmux',
    mounts,
    forks: [],
  };
  registry.workspaces[id] = entry;
  runner.copyToContainer(entry.container, join(outputDir, 'home'), '/home/agent');
  return entry;
}
