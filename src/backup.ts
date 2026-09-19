import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { redactedConfig, rejectForbiddenMount } from './config.js';
import type { InstanceEntry, Registry, WorkspaceEntry } from './registry.js';
import { defaultCanonicalize } from './resolve.js';

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
  // Trailing `/.` copies the *contents* of /home/agent. Without it the
  // destination directory already exists, so the runtime copies the source
  // directory into it and the snapshot gains a spurious `agent/` level that
  // restore then reproduces as `/home/agent/home/agent/...`.
  runner.copyFromContainer(entry.container, '/home/agent/.', stateDir);
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
/**
 * A backup manifest carries a path registration would refuse. The CLI maps
 * this to exit code 2, matching the registration refusal; anything else the
 * restore boundary rejects stays a plain error.
 */
export class BackupRefusedError extends Error {}
export function planRestore(registry: Registry, outputDir: string, homeDir: string): WorkspaceEntry {
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
  // A restored root is bound read-write on the next start with no further
  // vetting, so it gets the same guard as registration. Validated here,
  // before the claim is written: a bad backup fails without freezing the
  // workspace behind a claim it can never clear. The vetted canonical path
  // is what gets stored, exactly as registration stores its canonical root:
  // vetting one spelling while storing another would let a symlink swapped
  // between restore and start redirect the next bind.
  const root = requiredRoot(record, 'root');
  const canonicalRoot = defaultCanonicalize(root);
  const rootProblem = rejectForbiddenMount(canonicalRoot, homeDir);
  if (rootProblem) throw new BackupRefusedError(`backup workspace.json has a refused root: ${root} (${rootProblem})`);
  const rawMounts = record['mounts'];
  const listed = Array.isArray(rawMounts) && rawMounts.every((mount): mount is string => typeof mount === 'string') ? rawMounts : [];
  // Same guard for restored mounts, same canonicalization as registration
  // (`vettedMount` passes `homeDir` through as-is and stores the canonical
  // mount); callers pass a canonical home directory as `os.homedir()`
  // provides. Stored canonical, for the same symlink-swap reason as root.
  const mounts: string[] = [];
  for (const mount of listed) {
    const canonical = defaultCanonicalize(mount);
    const problem = rejectForbiddenMount(canonical, homeDir);
    if (problem) throw new BackupRefusedError(`backup workspace.json mounts a refused path: ${mount} (${problem})`);
    mounts.push(canonical);
  }
  const rawForks = record['forks'];
  // A restored fork name reaches fork pruning, so it is validated here
  // with the same charset every other name gets. Accepting an arbitrary
  // string array would let a tampered backup smuggle shell metacharacters
  // and path traversal toward that command.
  const forks = Array.isArray(rawForks)
    ? rawForks.map((fork) => {
        if (typeof fork !== 'string') throw new Error('backup workspace.json has a non-string forks entry');
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(fork)) {
          throw new Error(`backup workspace.json has an unsafe forks entry: ${fork}`);
        }
        return fork;
      })
    : [];
  const entry: WorkspaceEntry = {
    id,
    root: canonicalRoot,
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
  // Mirrors the backup side: `/.` copies the contents of the snapshot's home
  // directory into the live one. `path.join` would normalise a `.` segment
  // away, so the suffix is concatenated.
  runner.copyToContainer(entry.container, `${join(outputDir, 'home')}/.`, '/home/agent');
}

/**
 * The composed form, for callers that want both halves in one step. The CLI uses the two
 * halves separately so the registry write is never held across the copy.
 */
export function restoreWorkspace(runner: BackupRunner, registry: Registry, outputDir: string, homeDir: string): WorkspaceEntry {
  const entry = planRestore(registry, outputDir, homeDir);
  copyRestoreHome(runner, entry, outputDir);
  return entry;
}
