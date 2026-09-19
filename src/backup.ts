import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { redactedConfig } from './config.js';
import type { InstanceEntry, Registry, WorkspaceEntry } from './registry.js';

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
 * Roster comes back with home modes intact; windows themselves are gone
 * and return through reopen. Unknown shapes fail closed like the rest.
 */
function restoreInstances(record: Record<string, unknown>): InstanceEntry[] {
  const raw = record['instances'];
  if (!Array.isArray(raw)) return [];
  const instances: InstanceEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('backup workspace.json has an invalid instance');
    }
    const fields = item as Record<string, unknown>;
    const name = fields['name'];
    const kind = fields['kind'];
    const window = fields['window'];
    if (typeof name !== 'string' || typeof kind !== 'string' || typeof window !== 'string' || !name || !kind || !window) {
      throw new Error('backup workspace.json has an invalid instance');
    }
    const homeMode = fields['homeMode'];
    if (homeMode !== undefined && homeMode !== 'shared' && homeMode !== 'fork' && homeMode !== 'fresh') {
      throw new Error('backup workspace.json has an invalid instance homeMode');
    }
    instances.push(homeMode === undefined ? { name, kind, window } : { name, kind, window, homeMode });
  }
  return instances;
}

/**
 * Parse and validate a backup's `workspace.json`, then apply it to the registry:
 * reinstates the entry, recreating it when the workspace was lost. The selected
 * image is restored as recorded; data migrations are never reversed.
 *
 * Registry-only apart from the manifest read, so it is safe to run inside a short
 * registry transaction. The home volume is copied separately by `copyRestoreHome`:
 * a volume copy is slow and must never be held under the registry lock.
 */
export function planRestore(registry: Registry, outputDir: string): WorkspaceEntry {
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
  const rawForks = record['forks'];
  const forks = Array.isArray(rawForks) && rawForks.every((fork): fork is string => typeof fork === 'string') ? rawForks : [];
  const entry: WorkspaceEntry = {
    id,
    root: requiredRoot(record, 'root'),
    container: requiredName(record, 'container'),
    image: typeof record['image'] === 'string' ? (record['image'] as string) : null,
    previousImage: typeof record['previousImage'] === 'string' ? (record['previousImage'] as string) : null,
    session: requiredName(record, 'session'),
    instances: restoreInstances(record),
    homeVolume: requiredName(record, 'homeVolume'),
    network: record['network'] === 'restricted' ? 'restricted' : 'open',
    runtime: typeof record['runtime'] === 'string' && record['runtime'].length > 0 ? (record['runtime'] as string) : 'docker',
    terminal: typeof record['terminal'] === 'string' && record['terminal'].length > 0 ? (record['terminal'] as string) : 'tmux',
    mounts,
    forks,
  };
  registry.workspaces[id] = entry;
  return entry;
}

/**
 * Copy the snapshot's home directory back into the workspace container. This is the slow
 * half of a restore, and it is deliberately outside the registry transaction.
 */
export function copyRestoreHome(runner: BackupRunner, entry: WorkspaceEntry, outputDir: string): void {
  runner.copyToContainer(entry.container, join(outputDir, 'home'), '/home/agent');
}

/**
 * The composed form, for callers that want both halves in one step. The CLI uses the two
 * halves separately so the registry write is never held across the copy.
 */
export function restoreWorkspace(runner: BackupRunner, registry: Registry, outputDir: string): WorkspaceEntry {
  const entry = planRestore(registry, outputDir);
  copyRestoreHome(runner, entry, outputDir);
  return entry;
}
