import { describe, expect, it } from 'vitest';

import { emptyRegistry, registerWorkspace } from '../src/registry.js';
import { resolveWorkspace } from '../src/resolve.js';

const id = (path: string): string => path;

describe('resolveWorkspace', () => {
  it('prefers the explicit path and reports registration', () => {
    const registry = emptyRegistry();
    registerWorkspace(registry, '/w/microsb', []);
    expect(resolveWorkspace({ explicitRoot: '/w/microsb', cwd: '/other', registry, canonicalize: id })).toEqual({
      kind: 'registered',
      root: '/w/microsb',
      registered: true,
    });
    expect(resolveWorkspace({ explicitRoot: '/w/new', cwd: '/other', registry, canonicalize: id }).registered).toBe(false);
  });

  it('lets a registered governance root win over nested repositories', () => {
    const registry = emptyRegistry();
    registerWorkspace(registry, '/w/microsb', []);
    const found = resolveWorkspace({ cwd: '/w/microsb/assforge/agent-harness', registry, gitRoot: '/w/microsb/assforge/agent-harness', canonicalize: id });
    expect(found).toEqual({ kind: 'registered', root: '/w/microsb', registered: true });
  });

  it('falls back to git root then cwd', () => {
    const registry = emptyRegistry();
    expect(
      resolveWorkspace({ cwd: '/w/repo/sub', registry, gitRoot: '/w/repo', canonicalize: id }),
    ).toEqual({ kind: 'unregistered-git', root: '/w/repo', registered: false });
    expect(resolveWorkspace({ cwd: '/tmp/scratch', registry, canonicalize: id })).toEqual({
      kind: 'unregistered-cwd',
      root: '/tmp/scratch',
      registered: false,
    });
  });

  it('picks the longest registered ancestor', () => {
    const registry = emptyRegistry();
    registerWorkspace(registry, '/w', []);
    registerWorkspace(registry, '/w/microsb', []);
    expect(resolveWorkspace({ cwd: '/w/microsb/x', registry, canonicalize: id }).root).toBe('/w/microsb');
  });
});
