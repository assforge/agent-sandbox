import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { rejectForbiddenMount } from './config.js';
import { sandboxDir } from './paths.js';

export interface InstanceEntry {
  name: string;
  kind: string;
  window: string;
  /**
   * HOME strategy. Absent means shared (the pre-modes default going
   * forward): the instance uses the workspace home at /home/agent.
   * fork clones agent state on first launch, fresh starts empty.
   */
  homeMode?: HomeMode;
}

export type HomeMode = 'shared' | 'fork' | 'fresh';

export const HOME_MODES: readonly HomeMode[] = ['shared', 'fork', 'fresh'];

export type NetworkPolicy = 'open' | 'restricted';

/**
 * A long operation that has begun and has not finished. Only `restore` records
 * one, and only because a crashed restore is the one interruption that leaves
 * nothing else on disk to report it: `acquireLock` reclaims the workspace lock
 * by pid liveness, so a run that dies mid-copy releases the lock that would
 * have serialised the next command against a half-copied home.
 *
 * The record exists to say *a re-run is required*, not to describe a final
 * state. Nothing clears it but a completed re-run.
 */
export interface PendingOperation {
  kind: 'restore';
  /** The backup directory the mandatory re-run must read. */
  source: string;
  /** ISO timestamp of the claim, for the report. Never used for expiry. */
  startedAt: string;
  /** The claiming pid. Liveness separates "in progress" from "interrupted". */
  pid: number;
}

export interface WorkspaceEntry {
  id: string;
  root: string;
  container: string;
  image: string | null;
  previousImage: string | null;
  session: string;
  instances: InstanceEntry[];
  homeVolume: string;
  network: NetworkPolicy;
  /** Container runtime engine that owns this workspace. Foreign runtimes fail closed. */
  runtime: string;
  /** Terminal engine that owns this workspace's windows. */
  terminal: string;
  mounts: string[];
  /** Fork names with state under instances/. Pruned only explicitly. */
  forks: string[];
  /**
   * Agent versions recorded from the image at activation, keyed like the
   * version probe. Absent on pre-feature entries: never backfilled, the
   * drift check skips workspaces without it.
   */
  agentVersions?: Record<string, string>;
  /**
   * Absent means no operation is outstanding. Deliberately never backfilled:
   * unlike the fields below, absence here carries meaning, so a default would
   * invent a claim rather than repair one.
   */
  pendingOperation?: PendingOperation;
}

export interface Registry {
  version: 1;
  workspaces: Record<string, WorkspaceEntry>;
}

export const REGISTRY_VERSION = 1;

export function emptyRegistry(): Registry {
  return { version: REGISTRY_VERSION, workspaces: {} };
}

/** Short digest of the canonical root. Collisions are errors, never aliases. */
export function rootDigest(canonicalRoot: string): string {
  return createHash('sha256').update(canonicalRoot, 'utf8').digest('hex').slice(0, 12);
}

export function basenameOf(canonicalRoot: string): string {
  const trimmed = canonicalRoot.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  const raw = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  // Docker names and tmux targets accept only a narrow charset; everything
  // else becomes a hyphen so any root yields a usable id.
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'workspace';
}

export function workspaceId(canonicalRoot: string): string {
  return `${basenameOf(canonicalRoot)}-${rootDigest(canonicalRoot)}`;
}

/** Deterministic resource names derived from the workspace id. */
export function networkName(workspaceIdValue: string): string {
  return `sandbox-net-${workspaceIdValue}`;
}

export function defaultRegistryPath(homeDir: string): string {
  return join(sandboxDir(homeDir), 'registry.json');
}

export function loadRegistry(registryPath: string): Registry {
  let raw: string;
  try {
    raw = readFileSync(registryPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`registry is not valid JSON: ${registryPath}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`registry has an unexpected shape: ${registryPath}`);
  }
  const record = parsed as Partial<Registry>;
  if (record.version !== REGISTRY_VERSION || typeof record.workspaces !== 'object' || record.workspaces === null) {
    throw new Error(`registry has an unsupported version or shape: ${registryPath}`);
  }
  const workspaces = record.workspaces as Registry['workspaces'];
  for (const [key, entry] of Object.entries(workspaces)) {
    validateWorkspaceEntry(registryPath, key, entry);
    // Backfill registries written before the network policy existed. `pendingOperation`
    // is deliberately absent from this list: for it, absence is the meaning.
    if (entry.network !== 'open' && entry.network !== 'restricted') entry.network = 'open';
    if (entry.previousImage === undefined) entry.previousImage = null;
    if (!Array.isArray(entry.forks)) entry.forks = [];
    if (typeof entry.runtime !== 'string' || entry.runtime.length === 0) entry.runtime = 'docker';
    if (typeof entry.terminal !== 'string' || entry.terminal.length === 0) entry.terminal = 'tmux';
  }
  return { version: REGISTRY_VERSION, workspaces };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Strict entry validation: a corrupt entry fails the whole load with its key, never a later TypeError. */
function validateWorkspaceEntry(registryPath: string, key: string, entry: WorkspaceEntry): void {
  const bad = (why: string): Error => new Error(`registry entry ${key} is invalid (${why}): ${registryPath}`);
  if (typeof entry !== 'object' || entry === null) throw bad('not an object');
  if (!nonEmptyString(entry.id)) throw bad('id must be a non-empty string');
  if (entry.id !== key) throw bad('id does not match its registry key');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.id)) throw bad('id uses illegal characters');
  if (!nonEmptyString(entry.root) || !entry.root.startsWith('/')) throw bad('root must be an absolute path');
  for (const field of ['container', 'session', 'homeVolume'] as const) {
    if (!nonEmptyString(entry[field])) throw bad(`${field} must be a non-empty string`);
  }
  if (entry.image !== null && typeof entry.image !== 'string') throw bad('image must be a string or null');
  if (entry.previousImage !== undefined && entry.previousImage !== null && typeof entry.previousImage !== 'string') {
    throw bad('previousImage must be a string or null');
  }
  if (!Array.isArray(entry.instances)) throw bad('instances must be an array');
  for (const instance of entry.instances) {
    if (typeof instance !== 'object' || instance === null) throw bad('instance must be an object');
    const fields = instance as unknown as Record<string, unknown>;
    for (const field of ['name', 'kind', 'window'] as const) {
      if (!nonEmptyString(fields[field])) throw bad(`instance ${field} must be a non-empty string`);
    }
    // Name, kind, and window share the launch-time assertSafeName charset:
    // names drive host paths (credential files) and container paths
    // (instance homes), windows drive tmux targets. Enforced at the load
    // boundary so no hand-edited registry can seed a traversal.
    for (const field of ['name', 'kind', 'window'] as const) {
      const value = fields[field];
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
        throw bad(`instance ${field} is unsafe: ${String(value)}`);
      }
    }
    if (fields['homeMode'] !== undefined && !HOME_MODES.includes(fields['homeMode'] as HomeMode)) {
      throw bad('instance homeMode must be shared, fork, or fresh');
    }
  }
  if (entry.forks !== undefined) {
    if (!Array.isArray(entry.forks)) throw bad('forks must be an array of strings');
    for (const fork of entry.forks) {
      // A fork name is interpolated into the container path `/v/instances/<fork>`
      // which is then handed to `rm -rf`. Passing it as argv stops it being
      // *code*, but a name containing `/` or `..` would still walk out of
      // instances/ and delete other state on the home volume. Enforced here, at
      // the load boundary, so no source -- a hand-edited registry, a restored
      // backup, or a future writer -- can seed one.
      if (typeof fork !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(fork)) {
        throw bad(`forks entry is unsafe: ${String(fork)}`);
      }
    }
  }
  if (!Array.isArray(entry.mounts) || !entry.mounts.every((mount) => typeof mount === 'string')) {
    throw bad('mounts must be an array of strings');
  }
  if (entry.network !== undefined && entry.network !== 'open' && entry.network !== 'restricted') {
    throw bad('network must be open or restricted');
  }
  if (entry.agentVersions !== undefined) {
    if (typeof entry.agentVersions !== 'object' || entry.agentVersions === null || Array.isArray(entry.agentVersions)) {
      throw bad('agentVersions must be a string map');
    }
    for (const [name, version] of Object.entries(entry.agentVersions)) {
      if (name.length === 0 || typeof version !== 'string' || version.length === 0) {
        throw bad(`agentVersions entry ${name || '(empty)'} must be a non-empty string`);
      }
    }
  }
  if (entry.pendingOperation !== undefined) {
    // A claim is the only thing that freezes a workspace, so a malformed one must
    // fail the load rather than be silently dropped: dropping it would unblock a
    // workspace whose home is still indeterminate, which is the defect this
    // record exists to prevent. Validated here, at the load boundary, so no
    // source -- a hand-edited registry or a future writer -- can seed one.
    const claim = entry.pendingOperation as unknown as Record<string, unknown> | null;
    if (typeof claim !== 'object' || claim === null) throw bad('pendingOperation must be an object');
    if (claim['kind'] !== 'restore') throw bad('pendingOperation kind must be restore');
    if (!nonEmptyString(claim['source'])) throw bad('pendingOperation source must be a non-empty string');
    if (!nonEmptyString(claim['startedAt'])) throw bad('pendingOperation startedAt must be a non-empty string');
    if (typeof claim['pid'] !== 'number' || !Number.isInteger(claim['pid']) || claim['pid'] <= 0) {
      throw bad('pendingOperation pid must be a positive integer');
    }
  }
}

export function saveRegistry(registryPath: string, registry: Registry): void {
  const dir = dirname(registryPath);
  mkdirSync(dir, { recursive: true });
  // Atomic write: a crash mid-write leaves the previous registry intact.
  const tmpPath = join(dir, `.registry.tmp.${process.pid}.${Date.now()}`);
  writeFileSync(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, registryPath);
}

/** Exact lookup by canonical root. A digest collision with another root is an error. */
export function lookupWorkspace(registry: Registry, canonicalRoot: string): WorkspaceEntry | null {
  for (const entry of Object.values(registry.workspaces)) {
    if (entry.root === canonicalRoot) return entry;
  }
  const wanted = workspaceId(canonicalRoot);
  const clash = registry.workspaces[wanted];
  if (clash && clash.root !== canonicalRoot) {
    throw new Error(
      `workspace id collision: ${wanted} is registered for ${clash.root}, refusing to alias ${canonicalRoot}`,
    );
  }
  return null;
}

export interface RegisterOptions {
  homeDir?: string;
  canonicalize?: (path: string) => string;
  runtime?: string;
  terminal?: string;
}

export function registerWorkspace(
  registry: Registry,
  canonicalRoot: string,
  mounts: string[],
  options: RegisterOptions = {},
): WorkspaceEntry {
  const existing = lookupWorkspace(registry, canonicalRoot);
  if (existing) return existing;
  const canonicalize = options.canonicalize ?? ((path: string): string => path);
  for (const mount of [canonicalRoot, ...mounts]) {
    const problem = rejectForbiddenMount(canonicalize(mount), options.homeDir);
    if (problem) throw new Error(`refused mount ${mount}: ${problem}`);
  }
  const id = workspaceId(canonicalRoot);
  const entry: WorkspaceEntry = {
    id,
    root: canonicalRoot,
    container: `sandbox-${id}`,
    image: null,
    previousImage: null,
    session: `sandbox-${id}`,
    instances: [],
    homeVolume: `sandbox-home-${id}`,
    network: 'open',
    runtime: options.runtime ?? 'docker',
    terminal: options.terminal ?? 'tmux',
    mounts: [...mounts],
    forks: [],
  };
  registry.workspaces[id] = entry;
  return entry;
}

export function addInstance(registry: Registry, workspaceIdValue: string, instance: InstanceEntry): void {
  const entry = registry.workspaces[workspaceIdValue];
  if (!entry) throw new Error(`unknown workspace: ${workspaceIdValue}`);
  const same = entry.instances.find((item) => item.name === instance.name);
  if (same) {
    if (same.kind !== instance.kind) {
      throw new Error(
        `instance name is occupied by another agent: ${instance.name} runs ${same.kind}, requested ${instance.kind}`,
      );
    }
    return;
  }
  entry.instances.push(instance);
}
