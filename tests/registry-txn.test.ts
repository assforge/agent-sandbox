import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { main, type MainDeps } from '../src/bin/sandbox.js';
import { acquireLock, lockPath } from '../src/lock.js';
import { sandboxDir } from '../src/paths.js';
import { REGISTRY_LOCK_ID, withRegistryTxn } from '../src/registry-txn.js';
import { emptyRegistry, loadRegistry, registerWorkspace, saveRegistry, workspaceId } from '../src/registry.js';

/**
 * The registry is one file shared by every workspace, so a write derived from a
 * snapshot taken outside the lock can silently discard another run's write. These
 * tests pin the fix at both levels: the primitive's ordering guarantee, and the
 * CLI behaviour that depends on it.
 *
 * Every fixture is realpath'd before it is handed to the CLI. On macOS `/tmp` is a
 * symlink, so a root that is not canonical misses every registry lookup and the run
 * takes the auto-register path instead of the one under test.
 */
function world(): {
  base: string;
  home: string;
  lockDir: string;
  registryPath: string;
  dir: (name: string) => string;
  dispose: () => void;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-txn-')));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  return {
    base,
    home,
    lockDir: join(sandboxDir(home), 'locks'),
    registryPath: join(sandboxDir(home), 'registry.json'),
    dir: (name) => {
      const path = join(base, name);
      mkdirSync(path, { recursive: true });
      return realpathSync(path);
    },
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}

function seed(w: ReturnType<typeof world>, roots: string[]): void {
  const registry = emptyRegistry();
  for (const root of roots) registerWorkspace(registry, root, [root]);
  saveRegistry(w.registryPath, registry);
}

function deps(
  w: ReturnType<typeof world>,
  confirm: (prompt: string) => Promise<boolean>,
): MainDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd: w.base,
    homeDir: w.home,
    lockDir: w.lockDir,
    platform: process.platform,
    nodeVersion: process.version,
    pathLookup: () => null,
    commandSucceeds: () => false,
    runner: { run: () => ({ status: 0, stdout: '', stderr: '' }) },
    insideTerminal: false,
    stdinIsTTY: false,
    assumeYes: false,
    confirm,
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
  };
}

describe('registry transaction', () => {
  it('loads under the lock, so a pre-lock snapshot never reaches the disk', () => {
    const w = world();
    try {
      const rootA = w.dir('ws-a');
      const rootB = w.dir('ws-b');
      seed(w, [rootA]);

      // Phase 1: a run reads the registry before it takes the lock.
      const stale = loadRegistry(w.registryPath);
      // A concurrent run lands its write in the meantime.
      const concurrent = loadRegistry(w.registryPath);
      registerWorkspace(concurrent, rootB, [rootB]);
      saveRegistry(w.registryPath, concurrent);

      // The snapshot really is stale -- otherwise the assertion below is vacuous.
      expect(Object.keys(stale.workspaces)).toHaveLength(1);

      const seen = withRegistryTxn(w.lockDir, w.registryPath, loadRegistry, (live) => Object.keys(live.workspaces));

      expect(seen).toContain(workspaceId(rootB));
      expect(Object.keys(loadRegistry(w.registryPath).workspaces)).toHaveLength(2);
    } finally {
      w.dispose();
    }
  });

  it('holds the registry lock for the whole callback and releases it after', () => {
    const w = world();
    try {
      const path = lockPath(w.lockDir, REGISTRY_LOCK_ID);
      expect(existsSync(path)).toBe(false);

      const inside: string[] = [];
      const result = withRegistryTxn(w.lockDir, w.registryPath, loadRegistry, () => {
        // Held, not taken and dropped: a second acquisition of the same identity
        // must time out while the callback runs.
        try {
          acquireLock(w.lockDir, REGISTRY_LOCK_ID, 200).release();
          inside.push('acquired');
        } catch (error) {
          inside.push((error as Error).message);
        }
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(inside[0]).toMatch(/timed out acquiring workspace lock/);
      expect(existsSync(path)).toBe(false);
    } finally {
      w.dispose();
    }
  });

  it('writes nothing and releases the lock when the callback throws', () => {
    const w = world();
    try {
      const rootA = w.dir('ws-a');
      seed(w, [rootA]);
      const before = readFileSync(w.registryPath, 'utf8');

      expect(() =>
        withRegistryTxn(w.lockDir, w.registryPath, loadRegistry, (live) => {
          live.workspaces[workspaceId(rootA)]?.mounts.push('/nowhere');
          throw new Error('boom');
        }),
      ).toThrow('boom');

      expect(readFileSync(w.registryPath, 'utf8')).toBe(before);
      expect(existsSync(lockPath(w.lockDir, REGISTRY_LOCK_ID))).toBe(false);
    } finally {
      w.dispose();
    }
  });

  it('keeps both mounts when two runs on different workspaces interleave', async () => {
    const w = world();
    try {
      const rootA = w.dir('ws-a');
      const rootB = w.dir('ws-b');
      const mountA = w.dir('mnt-a');
      const mountB = w.dir('mnt-b');
      seed(w, [rootA, rootB]);

      let releaseA: (approved: boolean) => void = () => {};
      const gateA = new Promise<boolean>((resolve) => {
        releaseA = resolve;
      });
      let reachedA: () => void = () => {};
      const atPromptA = new Promise<void>((resolve) => {
        reachedA = resolve;
      });

      const a = deps(w, async () => {
        reachedA();
        return gateA;
      });
      const b = deps(w, async () => true);

      const runA = main(['workspace', 'mount', mountA, '--workspace', rootA], a);
      await atPromptA; // A has read the registry and is stopped at its prompt
      expect(await main(['workspace', 'mount', mountB, '--workspace', rootB], b)).toBe(0);
      releaseA(true);
      expect(await runA).toBe(0);

      const registry = loadRegistry(w.registryPath);
      expect(registry.workspaces[workspaceId(rootA)]?.mounts).toContain(mountA);
      expect(registry.workspaces[workspaceId(rootB)]?.mounts).toContain(mountB);
    } finally {
      w.dispose();
    }
  });

  it('registers an unregistered root once when two runs race on the prompt', async () => {
    const w = world();
    try {
      const root = w.dir('ws-new');
      const mountA = w.dir('mnt-1');
      const mountB = w.dir('mnt-2');
      seed(w, []);

      let releaseA: (approved: boolean) => void = () => {};
      const gateA = new Promise<boolean>((resolve) => {
        releaseA = resolve;
      });
      let reachedA: () => void = () => {};
      const atPromptA = new Promise<void>((resolve) => {
        reachedA = resolve;
      });

      const a = deps(w, async () => {
        reachedA();
        return gateA;
      });
      const b = deps(w, async () => true);

      const runA = main(['workspace', 'mount', mountA, '--workspace', root], a);
      await atPromptA; // A is stopped at the scope prompt, still unregistered
      expect(await main(['workspace', 'mount', mountB, '--workspace', root], b)).toBe(0);
      releaseA(true);
      expect(await runA).toBe(0);

      const entries = Object.values(loadRegistry(w.registryPath).workspaces);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.root).toBe(root);
      expect(entries[0]?.mounts).toEqual(expect.arrayContaining([root, mountA, mountB]));
    } finally {
      w.dispose();
    }
  });

  it('leaves the CLI no direct way to write the registry', () => {
    // The entry point moved to src/commands/, so the invariant covers the
    // whole command layer: registry writes go through withRegistryTxn only.
    const dir = new URL('../src/commands/', import.meta.url);
    const files = ['../src/bin/sandbox.ts', ...readdirSync(dir).map((file) => `../src/commands/${file}`)];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toContain('saveRegistry');
    }
    const lookup = readFileSync(new URL('../src/commands/lookup.ts', import.meta.url), 'utf8');
    expect(lookup).toContain("from '../registry-txn.js'");

    const primitive = readFileSync(new URL('../src/registry-txn.ts', import.meta.url), 'utf8');
    expect(primitive.match(/saveRegistry\(/g) ?? []).toHaveLength(1);
  });
});
