import { describe, expect, it } from 'vitest';

import { emptyRegistry, registerWorkspace } from '../src/registry.js';
import { defaultCanonicalize, isAncestorOrSelf, resolveWorkspace } from '../src/resolve.js';

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
    expect(resolveWorkspace({ explicitRoot: '/w/new', cwd: '/other', registry, canonicalize: id })).toEqual({
      kind: 'unregistered-explicit',
      root: '/w/new',
      registered: false,
    });
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

  it('distinguishes sibling prefixes and tolerates trailing slashes and root', () => {
    expect(isAncestorOrSelf('/w', '/w2/x')).toBe(false);
    expect(isAncestorOrSelf('/w', '/w/x')).toBe(true);
    expect(isAncestorOrSelf('/w/microsb/', '/w/microsb/sub')).toBe(true);
    expect(isAncestorOrSelf('/', '/Users/chomin')).toBe(true);
    expect(isAncestorOrSelf('/w', '/w')).toBe(true);
    const registry = emptyRegistry();
    registerWorkspace(registry, '/w', []);
    expect(resolveWorkspace({ cwd: '/w2/x', registry, gitRoot: '/w2', canonicalize: id }).root).toBe('/w2');
  });

  it('falls back to the raw path when realpath fails', () => {
    expect(defaultCanonicalize('/definitely/not/here-xyz')).toBe('/definitely/not/here-xyz');
    expect(defaultCanonicalize('/tmp')).not.toContain('//');
  });
});
