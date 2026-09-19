import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { main, type MainDeps } from '../src/bin/sandbox.js';
import { redactedConfig } from '../src/config.js';
import { sandboxDir } from '../src/paths.js';
import { emptyRegistry, loadRegistry, registerWorkspace, saveRegistry, workspaceId } from '../src/registry.js';

/**
 * The `restore` claim: what is left on disk when a restore dies between replacing
 * the entry and copying the home back.
 *
 * The workspace lock serialises a *live* restore against every other command, so
 * nothing here tests concurrency -- the claim exists for **death**, and a dead
 * holder is simulated by seeding a claim whose pid is a child that has already
 * exited. Every fixture is realpath'd before the CLI sees it: on macOS `/tmp` is a
 * symlink, so a non-canonical root misses every registry lookup and the run takes
 * the auto-register path instead of the one under test.
 */
function world(): {
  base: string;
  home: string;
  lockDir: string;
  registryPath: string;
  dir: (name: string) => string;
  dispose: () => void;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-claim-')));
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

type World = ReturnType<typeof world>;

function seed(w: World, roots: string[]): void {
  const registry = emptyRegistry();
  for (const root of roots) registerWorkspace(registry, root, [root]);
  saveRegistry(w.registryPath, registry);
}

/** Write a backup directory in the exact shape `backupWorkspace` produces. */
function seedBackup(w: World, root: string, name: string, extra: Record<string, unknown> = {}): string {
  const entry = loadRegistry(w.registryPath).workspaces[workspaceId(root)];
  if (!entry) throw new Error('seedBackup: workspace is not registered');
  const dir = join(w.base, name);
  mkdirSync(join(dir, 'home'), { recursive: true });
  // `redactedConfig` is an explicit field list, so a claim can never ride along in a
  // backup the CLI writes. `extra` injects one by hand, to prove the read side too.
  const manifest = { ...redactedConfig(entry), ...extra };
  writeFileSync(join(dir, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return dir;
}

function seedClaim(w: World, root: string, source: string, pid: number): void {
  const registry = loadRegistry(w.registryPath);
  const entry = registry.workspaces[workspaceId(root)];
  if (!entry) throw new Error('seedClaim: workspace is not registered');
  entry.pendingOperation = { kind: 'restore', source, startedAt: '2026-09-19T00:00:00.000Z', pid };
  saveRegistry(w.registryPath, registry);
}

function claimOf(w: World, root: string): { kind?: string; source?: string; pid?: number } | undefined {
  return loadRegistry(w.registryPath).workspaces[workspaceId(root)]?.pendingOperation;
}

/** A pid that is genuinely dead: a child that has already exited. */
function exitedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.on('error', reject);
    child.on('exit', () => resolve(child.pid as number));
  });
}

interface Harness extends MainDeps {
  out: string[];
  err: string[];
  calls: string[][];
}

/**
 * `failCopy` fails `docker cp`, which is the slow half of a restore and the only
 * thing a crash can interrupt between the two transactions.
 */
function deps(w: World, options: { failCopy?: boolean } = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  return {
    cwd: w.base,
    homeDir: w.home,
    lockDir: w.lockDir,
    platform: process.platform,
    nodeVersion: process.version,
    pathLookup: () => null,
    commandSucceeds: () => false,
    runner: {
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (options.failCopy && command === 'docker' && args[0] === 'cp') {
          return { status: 1, stdout: '', stderr: 'no such container' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
    insideTerminal: false,
    stdinIsTTY: false,
    assumeYes: false,
    confirm: async () => true,
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    out,
    err,
    calls,
  };
}

describe('restore claim', () => {
  it('leaves the claim behind when the copy throws', async () => {
    const w = world();
    try {
      const root = w.dir('ws');
      seed(w, [root]);
      const backup = seedBackup(w, root, 'backup');

      expect(await main(['workspace', 'restore', '--input', backup, '--workspace', root], deps(w, { failCopy: true }))).toBe(1);

      const claim = claimOf(w, root);
      expect(claim?.kind).toBe('restore');
      expect(claim?.source).toBe(backup);
      // The claiming process is the one that just failed, which is what makes the next
      // reader report "in progress" rather than "interrupted".
      expect(claim?.pid).toBe(process.pid);
    } finally {
      w.dispose();
    }
  });

  it('refuses every other command while a claim is outstanding, before touching anything', async () => {
    const w = world();
    try {
      const root = w.dir('ws');
      const mount = w.dir('mnt');
      const out = join(w.base, 'out');
      seed(w, [root]);
      const backup = seedBackup(w, root, 'backup');
      seedClaim(w, root, backup, process.pid);
      const before = readFileSync(w.registryPath, 'utf8');

      // One entry per command that can reach a workspace, and the two `link` arms are
      // listed separately because they are separate arms in the source: a rule applied
      // site by site is exactly the rule that goes missing at a duplicate. A frozen
      // workspace must refuse all of them, and refuse before any resource call.
      const frozen: [string, string[]][] = [
        ['start', ['workspace', 'start', '--workspace', root]],
        ['stop', ['workspace', 'stop', '--workspace', root]],
        ['restart', ['workspace', 'restart', '--workspace', root]],
        ['logs', ['workspace', 'logs', '--workspace', root]],
        ['reopen', ['workspace', 'reopen', '--workspace', root]],
        ['exec', ['workspace', 'exec', '--workspace', root, '--', 'echo', 'hi']],
        ['mount', ['workspace', 'mount', mount, '--workspace', root]],
        ['unmount', ['workspace', 'unmount', mount, '--workspace', root]],
        ['configure', ['workspace', 'configure', '--network', 'restricted', '--workspace', root]],
        ['prune', ['workspace', 'prune', '--workspace', root]],
        ['backup', ['workspace', 'backup', '--output', out, '--workspace', root]],
        ['unlink', ['workspace', 'unlink', '--workspace', root]],
        ['upgrade', ['workspace', 'upgrade', '--workspace', root]],
        ['workspace link', ['workspace', 'link', '--root', root]],
        ['link', ['link', root]],
        ['image activate', ['image', 'activate', 'sandbox-workspace:current', '--workspace', root]],
        ['shell', ['shell', '--workspace', root]],
        ['claude (agent launch)', ['claude', '--workspace', root]],
      ];

      for (const [label, argv] of frozen) {
        const d = deps(w);
        const code = await main(argv, d);
        const complaint = d.err.join('');
        // The stderr travels with the failure so a wrong argv is distinguishable from a
        // missing guard without re-running anything.
        expect([label, code, complaint]).toEqual([label, 1, expect.stringContaining('unfinished restore')]);
        expect([label, complaint.includes(backup)]).toEqual([label, true]);
        expect([label, d.calls.length]).toEqual([label, 0]);
      }

      expect(readFileSync(w.registryPath, 'utf8')).toBe(before);
    } finally {
      w.dispose();
    }
  });

  it('clears the claim when the re-run completes', async () => {
    const w = world();
    try {
      const root = w.dir('ws');
      seed(w, [root]);
      const backup = seedBackup(w, root, 'backup');
      seedClaim(w, root, backup, process.pid);

      expect(await main(['workspace', 'restore', '--input', backup, '--workspace', root], deps(w))).toBe(0);

      expect(claimOf(w, root)).toBeUndefined();
      // Asserted against the file, not just the parsed entry: a `null` residue would pass
      // the check above and still freeze the workspace on the next load.
      expect(readFileSync(w.registryPath, 'utf8')).not.toContain('pendingOperation');
      // And the workspace is usable again, which is the point of clearing it.
      expect(await main(['workspace', 'status', '--workspace', root], deps(w))).toBe(0);
    } finally {
      w.dispose();
    }
  });

  it('reports the claim in status and mutates nothing', async () => {
    const w = world();
    try {
      const root = w.dir('ws');
      seed(w, [root]);
      const backup = seedBackup(w, root, 'backup');
      seedClaim(w, root, backup, process.pid);
      const before = readFileSync(w.registryPath, 'utf8');
      const d = deps(w);

      expect(await main(['workspace', 'status', '--workspace', root], d)).toBe(0);

      const report = d.out.join('');
      expect(report).toContain('restore in progress');
      expect(report).toContain(backup);
      expect(readFileSync(w.registryPath, 'utf8')).toBe(before);
    } finally {
      w.dispose();
    }
  });

  it('tells an interrupted restore from one still in progress', async () => {
    const w = world();
    try {
      const root = w.dir('ws');
      seed(w, [root]);
      const backup = seedBackup(w, root, 'backup');

      seedClaim(w, root, backup, await exitedPid());
      const dead = deps(w);
      expect(await main(['workspace', 'status', '--workspace', root], dead)).toBe(0);
      expect(dead.out.join('')).toContain('restore-interrupted');

      seedClaim(w, root, backup, process.pid);
      const live = deps(w);
      expect(await main(['workspace', 'status', '--workspace', root], live)).toBe(0);
      expect(live.out.join('')).toContain(`restore in progress (pid ${process.pid})`);
    } finally {
      w.dispose();
    }
  });

  it('warns in doctor and names the backup, and stays quiet without a claim', async () => {
    const w = world();
    try {
      const root = w.dir('ws');
      seed(w, [root]);
      const backup = seedBackup(w, root, 'backup');
      const read = (d: Harness): { id: string; status: string; summary: string; remediation?: string }[] => {
        const parsed = JSON.parse(d.out.join('')) as { checks: { id: string; status: string; summary: string; remediation?: string }[] };
        return parsed.checks;
      };

      const clean = deps(w);
      await main(['doctor', '--json', '--workspace', root], clean);
      expect(read(clean).find((check) => check.id === 'workspace-restore')).toBeUndefined();

      seedClaim(w, root, backup, process.pid);
      const warned = deps(w);
      await main(['doctor', '--json', '--workspace', root], warned);
      const check = read(warned).find((item) => item.id === 'workspace-restore');
      expect(check?.status).toBe('warn');
      expect(check?.summary).toContain('did not finish');
      expect(check?.remediation).toContain(backup);
    } finally {
      w.dispose();
    }
  });

  it('refuses to load a malformed claim instead of dropping it', () => {
    const w = world();
    try {
      const root = w.dir('ws');
      seed(w, [root]);
      const id = workspaceId(root);
      const valid = JSON.parse(readFileSync(w.registryPath, 'utf8')) as {
        workspaces: Record<string, Record<string, unknown>>;
      };
      const write = (claim: unknown): void => {
        const entry = valid.workspaces[id] as Record<string, unknown>;
        entry['pendingOperation'] = claim;
        writeFileSync(w.registryPath, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
      };

      // Dropping a malformed claim would unblock a workspace whose home is still
      // indeterminate, which is the defect the record exists to prevent.
      write({ kind: 'upgrade', source: '/x', startedAt: 'now', pid: 1 });
      expect(() => loadRegistry(w.registryPath)).toThrow(/pendingOperation kind must be restore/);

      write({ kind: 'restore', source: '/x', startedAt: 'now', pid: 'not-a-pid' });
      expect(() => loadRegistry(w.registryPath)).toThrow(/pendingOperation pid must be a positive integer/);

      write({ kind: 'restore', source: '', startedAt: 'now', pid: 1 });
      expect(() => loadRegistry(w.registryPath)).toThrow(/pendingOperation source must be a non-empty string/);
    } finally {
      w.dispose();
    }
  });

  it('cannot smuggle a claim through a backup file', async () => {
    const w = world();
    try {
      const root = w.dir('ws');
      seed(w, [root]);
      const backup = seedBackup(w, root, 'backup', {
        pendingOperation: { kind: 'restore', source: '/smuggled', startedAt: 'now', pid: process.pid },
      });

      // The copy fails, so whatever claim survives is the one the CLI wrote -- not the one
      // the backup carried. `planRestore` builds the entry from an explicit field list.
      expect(await main(['workspace', 'restore', '--input', backup, '--workspace', root], deps(w, { failCopy: true }))).toBe(1);

      expect(claimOf(w, root)?.source).toBe(backup);
    } finally {
      w.dispose();
    }
  });
});
