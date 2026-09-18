import { homedir } from 'node:os';

import type { WorkspaceEntry } from './registry.js';

/** Lexical normalization without touching the filesystem: resolves ., .., duplicate and trailing slashes. */
export function normalizeLexical(path: string): string {
  const absolute = path.startsWith('/');
  const parts = path.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join('/');
  if (absolute) return `/${joined}`;
  return joined || '.';
}

/** Root and HOME mounts are rejected by default. Callers must canonicalize symlinks via realpath first. */
export function rejectForbiddenMount(mount: string, homeDir: string = homedir()): string | null {
  const normalized = normalizeLexical(mount);
  if (normalized === '/') return 'root mount is rejected by default';
  if (normalized === normalizeLexical(homeDir)) return 'HOME mount is rejected by default';
  return null;
}

/** Redacted view for configure output. Secrets never appear here. */
export function redactedConfig(entry: WorkspaceEntry): Record<string, unknown> {
  return {
    id: entry.id,
    root: entry.root,
    container: entry.container,
    image: entry.image,
    previousImage: entry.previousImage,
    session: entry.session,
    homeVolume: entry.homeVolume,
    network: entry.network,
    runtime: entry.runtime,
    terminal: entry.terminal,
    mounts: entry.mounts,
    instances: entry.instances.map((instance) => ({ name: instance.name, kind: instance.kind, window: instance.window })),
  };
}

export function validateRegistryShape(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) return ['registry root must be an object'];
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1) problems.push('registry version must be 1');
  if (typeof record['workspaces'] !== 'object' || record['workspaces'] === null) {
    problems.push('registry workspaces must be an object');
  }
  return problems;
}
