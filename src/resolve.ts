import { realpathSync } from 'node:fs';

import { lookupWorkspace, type Registry } from './registry.js';

export type ResolutionKind = 'registered' | 'unregistered-git' | 'unregistered-cwd';

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

const defaultCanonicalize = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

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
    return { kind: found ? 'registered' : 'unregistered-cwd', root, registered: found };
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
    if (cwd === root || cwd.startsWith(`${root}/`)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}
