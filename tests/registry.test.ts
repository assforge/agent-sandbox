import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  addInstance,
  basenameOf,
  defaultRegistryPath,
  emptyRegistry,
  loadRegistry,
  lookupWorkspace,
  registerWorkspace,
  rootDigest,
  saveRegistry,
  workspaceId,
} from '../src/registry.js';

describe('workspaceId', () => {
  it('combines readable basename with a stable digest', () => {
    expect(workspaceId('/Users/a/microsb')).toMatch(/^microsb-[0-9a-f]{12}$/);
    expect(workspaceId('/Users/a/microsb')).toBe(workspaceId('/Users/a/microsb'));
    expect(workspaceId('/Users/a/microsb')).not.toBe(workspaceId('/Users/b/microsb'));
  });

  it('digests the full root so same basenames do not alias', () => {
    expect(rootDigest('/x/microsb')).not.toBe(rootDigest('/y/microsb'));
  });

  it('sanitizes ids to the docker and tmux charset', () => {
    expect(workspaceId('/Users/a/My Project')).toMatch(/^my-project-[0-9a-f]{12}$/);
    expect(workspaceId('/')).toMatch(/^workspace-[0-9a-f]{12}$/);
    expect(basenameOf('/w/repo/')).toBe('repo');
    expect(basenameOf('relative')).toBe('relative');
  });

  it('rejects forbidden mounts at registration', () => {
    const registry = emptyRegistry();
    expect(() => registerWorkspace(registry, '/', [], { homeDir: '/Users/a' })).toThrow(/refused mount/);
    expect(() => registerWorkspace(registry, '/Users/a', [], { homeDir: '/Users/a' })).toThrow(/HOME/);
    expect(() => registerWorkspace(registry, '/w', ['/Users/a/.'], { homeDir: '/Users/a' })).toThrow(/HOME/);
  });

  it('is idempotent for the same root and records previous images', () => {
    const registry = emptyRegistry();
    const first = registerWorkspace(registry, '/w/microsb', ['/w/microsb']);
    expect(registerWorkspace(registry, '/w/microsb', ['/other'])).toBe(first);
    expect(first.mounts).toEqual(['/w/microsb']);
    expect(first.previousImage).toBeNull();
  });

  it('resolves the default registry path under the home directory', () => {
    expect(defaultRegistryPath('/Users/a')).toBe('/Users/a/.sandbox/registry.json');
  });
});

describe('registry persistence', () => {
  it('round-trips through a missing file as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-reg-'));
    try {
      const path = join(dir, 'sub', 'registry.json');
      expect(loadRegistry(path)).toEqual(emptyRegistry());
      const registry = emptyRegistry();
      registerWorkspace(registry, '/Users/a/microsb', ['/Users/a/microsb']);
      saveRegistry(path, registry);
      expect(loadRegistry(path)).toEqual(registry);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid JSON and wrong shapes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-reg-'));
    try {
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{nope', 'utf8');
      expect(() => loadRegistry(bad)).toThrow(/not valid JSON/);
      writeFileSync(bad, '{"version":2,"workspaces":{}}', 'utf8');
      expect(() => loadRegistry(bad)).toThrow(/unsupported version/);
      writeFileSync(bad, '42', 'utf8');
      expect(() => loadRegistry(bad)).toThrow(/unexpected shape/);
      writeFileSync(bad, '{"version":1}', 'utf8');
      expect(() => loadRegistry(bad)).toThrow(/unsupported version/);
      expect(() => loadRegistry(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lookup and instances', () => {
  it('finds by full root and errors on digest collision', () => {
    const registry = emptyRegistry();
    const entry = registerWorkspace(registry, '/Users/a/microsb', ['/Users/a/microsb']);
    expect(lookupWorkspace(registry, '/Users/a/microsb')).toBe(entry);
    expect(lookupWorkspace(registry, '/Users/a/other')).toBeNull();
    const wanted = workspaceId('/Users/a/other');
    registry.workspaces[wanted] = { ...entry, id: wanted, root: '/Users/a/clash' };
    expect(() => lookupWorkspace(registry, '/Users/a/other')).toThrow(/collision/);
  });

  it('accepts a matching instance, rejects an occupied name of another kind', () => {
    const registry = emptyRegistry();
    const entry = registerWorkspace(registry, '/Users/a/microsb', []);
    addInstance(registry, entry.id, { name: 'rollout', kind: 'claude', window: 'rollout' });
    addInstance(registry, entry.id, { name: 'rollout', kind: 'claude', window: 'rollout' });
    expect(entry.instances).toHaveLength(1);
    expect(() => addInstance(registry, entry.id, { name: 'rollout', kind: 'codex', window: 'rollout' })).toThrow(
      /occupied by another agent/,
    );
    expect(() => addInstance(registry, 'missing', { name: 'x', kind: 'claude', window: 'x' })).toThrow(/unknown workspace/);
  });
});
