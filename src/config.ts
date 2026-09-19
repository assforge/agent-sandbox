import { homedir } from 'node:os';

import { sandboxDir } from './paths.js';
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

/**
 * Root, HOME and the sandbox state directory are rejected, together with every
 * ancestor of them. Rejecting only the exact paths was not enough: binding
 * `/Users` or `/home` hands the container HOME — SSH keys, the registry and every
 * other dotfile — without ever naming HOME.
 * Callers must canonicalize symlinks via realpath first.
 */
export function rejectForbiddenMount(mount: string, homeDir: string = homedir()): string | null {
  const normalized = normalizeLexical(mount);
  if (normalized === '/') return 'root mount is rejected by default';
  const guarded: [string, string, 'up' | 'both'][] = [
    ['HOME', normalizeLexical(homeDir), 'up'],
    ['the sandbox state directory', normalizeLexical(sandboxDir(homeDir)), 'both'],
  ];
  for (const [label, target, direction] of guarded) {
    if (normalized === target || target.startsWith(`${normalized}/`)) {
      return `${label} mount is rejected by default: ${normalized} contains ${target}`;
    }
    // Descendants only matter for the state directory: a child of HOME is
    // an ordinary workspace root, but a child of the state directory is a
    // registry or credential file by another name.
    if (direction === 'both' && normalized.startsWith(`${target}/`)) {
      return `${label} mount is rejected by default: ${normalized} is inside ${target}`;
    }
  }
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
    forks: entry.forks,
    instances: entry.instances.map((instance) => ({
      name: instance.name,
      kind: instance.kind,
      window: instance.window,
      ...(instance.homeMode === undefined ? {} : { homeMode: instance.homeMode }),
    })),
  };
}
