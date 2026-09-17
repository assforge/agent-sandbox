import { realpathSync } from 'node:fs';

import { lookupWorkspace, type Registry } from './registry.js';

export type ResolutionKind = 'registered' | 'unregistered-explicit' | 'unregistered-git' | 'unregistered-cwd';

export interface Resolution {
  kind: ResolutionKind;
  root: string;
  registered: boolean;
}

export interface ResolveInputs {
  explicitRoot?: string;
  cwd: string;
  registry: Registry;
  /** Nearest git worktree root for cwd, or null when cwd is not in a repository. */
  gitRoot?: string | null;
  canonicalize?: (path: string) => string;
}

export const defaultCanonicalize = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

function stripTrailingSlash(path: string): string {
  if (path.length > 1) return path.replace(/\/+$/, '');
  return path;
}

/** Ancestor-or-self comparison that tolerates trailing slashes and the filesystem root. */
export function isAncestorOrSelf(parent: string, child: string): boolean {
  const normParent = stripTrailingSlash(parent);
  const normChild = stripTrailingSlash(child);
  if (normParent === normChild) return true;
  if (normParent === '/') return normChild.startsWith('/');
  return normChild.startsWith(`${normParent}/`);
}

/**
 * Deterministic workspace resolution.
 * Precedence: explicit path, nearest registered ancestor, git root, cwd.
 * A registered governance root wins over nested repositories.
 */
export function resolveWorkspace(inputs: ResolveInputs): Resolution {
  const canonicalize = inputs.canonicalize ?? defaultCanonicalize;
  if (inputs.explicitRoot) {
    const root = canonicalize(inputs.explicitRoot);
    const found = lookupWorkspace(inputs.registry, root) !== null;
    return { kind: found ? 'registered' : 'unregistered-explicit', root, registered: found };
  }
  const cwd = canonicalize(inputs.cwd);
  const ancestor = nearestRegisteredAncestor(inputs.registry, cwd, canonicalize);
  if (ancestor) return { kind: 'registered', root: ancestor, registered: true };
  if (inputs.gitRoot) {
    const root = canonicalize(inputs.gitRoot);
    return { kind: 'unregistered-git', root, registered: false };
  }
  return { kind: 'unregistered-cwd', root: cwd, registered: false };
}

function nearestRegisteredAncestor(
  registry: Registry,
  cwd: string,
  canonicalize: (path: string) => string,
): string | null {
  let best: string | null = null;
  for (const entry of Object.values(registry.workspaces)) {
    const root = canonicalize(entry.root);
    if (isAncestorOrSelf(root, cwd)) {
      if (!best || stripTrailingSlash(root).length > stripTrailingSlash(best).length) best = root;
    }
  }
  return best;
}
