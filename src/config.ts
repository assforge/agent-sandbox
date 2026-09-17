import { homedir } from 'node:os';

import type { WorkspaceEntry } from './registry.js';

/** Root and HOME mounts are rejected by default. Symlinks must be canonicalized by the caller. */
export function rejectForbiddenMount(mount: string, homeDir: string = homedir()): string | null {
  const normalized = mount.replace(/\/+$/, '') || '/';
  if (normalized === '/') return 'root mount is rejected by default';
  if (normalized === homeDir.replace(/\/+$/, '')) return 'HOME mount is rejected by default';
  return null;
}

/** Redacted view for configure output. Secrets never appear here. */
export function redactedConfig(entry: WorkspaceEntry): Record<string, unknown> {
  return {
    id: entry.id,
    root: entry.root,
    container: entry.container,
    image: entry.image,
    session: entry.session,
    homeVolume: entry.homeVolume,
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
