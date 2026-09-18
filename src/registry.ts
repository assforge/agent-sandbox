import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { rejectForbiddenMount } from './config.js';

export interface InstanceEntry {
  name: string;
  kind: string;
  window: string;
}

export type NetworkPolicy = 'open' | 'restricted';

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
  return join(homeDir, '.sandbox', 'registry.json');
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
  for (const entry of Object.values(workspaces)) {
    // Backfill registries written before the network policy existed.
    if (entry.network !== 'open' && entry.network !== 'restricted') entry.network = 'open';
    if (entry.previousImage === undefined) entry.previousImage = null;
    if (typeof entry.runtime !== 'string' || entry.runtime.length === 0) entry.runtime = 'docker';
    if (typeof entry.terminal !== 'string' || entry.terminal.length === 0) entry.terminal = 'tmux';
  }
  return { version: REGISTRY_VERSION, workspaces };
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
