import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { main, hasGitDir, reattachOrHint, type MainDeps } from '../src/bin/sandbox.js';
import { emptyRegistry, saveRegistry } from '../src/registry.js';
import type { TerminalEngine } from '../src/engines/terminal.js';

function deps(overrides: Partial<MainDeps> = {}): MainDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    cwd: '/w',
    homeDir: '/nonexistent-home',
    lockDir: join(tmpdir(), 'sandbox-test-locks'),
    platform: 'darwin',
    nodeVersion: 'v22.0.0',
    pathLookup: (name) => `/usr/bin/${name}`,
    commandSucceeds: () => true,
    runner: { run: () => ({ status: 0, stdout: '', stderr: '' }) },
    insideTerminal: false,
    stdinIsTTY: true,
    assumeYes: true,
    confirm: async () => true,
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    ...overrides,
  };
}

describe('main', () => {
  it('serves help and version without touching the environment', async () => {
    const help = deps();
    expect(await main(['--help'], help)).toBe(0);
    expect(help.out.join('')).toContain('Read-only diagnostics');
    const version = deps();
    expect(await main(['--version'], version)).toBe(0);
    expect(version.out.join('')).toMatch(/sandbox \d+\.\d+\.\d+/);
  });

  it('formats usage errors with exit code 2', async () => {
    const d = deps();
    expect(await main(['frobnicate'], d)).toBe(2);
    expect(d.err.join('')).toMatch(/unknown command/);
  });

  it('runs doctor against the resolved workspace registry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-main-'));
    try {
      const d = deps({ homeDir: home, cwd: join(home, 'proj') });
      expect(await main(['doctor'], d)).toBe(0);
      expect(d.out.join('')).toContain('[WARN]');
      const registry = emptyRegistry();
      saveRegistry(join(home, '.agent.sandbox', 'registry.json'), registry);
      const d2 = deps({ homeDir: home, cwd: join(home, 'proj') });
      expect(await main(['doctor', '--json'], d2)).toBe(0);
      expect(JSON.parse(d2.out.join('')) as unknown).toHaveProperty('checks');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses a tampered restore root with exit code 2 and leaves the registry untouched', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-main-'));
    try {
      const registry = emptyRegistry();
      registry.workspaces['w'] = {
        id: 'w', root: '/w', container: 'c', image: null, previousImage: null,
        session: 's', instances: [], homeVolume: 'v', network: 'open',
        runtime: 'docker', terminal: 'tmux', mounts: [], forks: [],
      };
      const registryPath = join(home, '.agent.sandbox', 'registry.json');
      saveRegistry(registryPath, registry);
      const before = readFileSync(registryPath, 'utf8');
      const input = join(home, 'input');
      mkdirSync(input, { recursive: true });
      writeFileSync(
        join(input, 'workspace.json'),
        JSON.stringify({ id: 'w', root: join(home, '.agent.sandbox', 'stolen'), container: 'c', session: 's', homeVolume: 'v', mounts: [], forks: [] }),
        'utf8',
      );
      const d = deps({ homeDir: home });
      expect(await main(['workspace', 'restore', '--input', input], d)).toBe(2);
      expect(d.err.join('')).toMatch(/refused root/);
      expect(readFileSync(registryPath, 'utf8')).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prunes unreferenced workspace images but keeps current and previous', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-main-'));
    try {
      const registry = emptyRegistry();
      registry.workspaces['w'] = {
        id: 'w', root: '/w', container: 'c', image: 'sandbox-workspace:keep', previousImage: 'sandbox-workspace:prev',
        session: 's', instances: [], homeVolume: 'v', network: 'open',
        runtime: 'docker', terminal: 'tmux', mounts: [], forks: [],
      };
      saveRegistry(join(home, '.agent.sandbox', 'registry.json'), registry);
      const removed: string[] = [];
      const d = deps({
        homeDir: home,
        runner: {
          run: (command, args) => {
            if (command === 'docker' && args[0] === 'images') {
              return { status: 0, stdout: 'sandbox-workspace:keep\nsandbox-workspace:prev\nsandbox-workspace:stale\nnode:22\n', stderr: '' };
            }
            if (command === 'docker' && args[0] === 'rmi') {
              removed.push(args[1] as string);
              return { status: 0, stdout: '', stderr: '' };
            }
            throw new Error(`unexpected call: ${command} ${args.join(' ')}`);
          },
        },
      });
      expect(await main(['image', 'prune'], d)).toBe(0);
      expect(removed).toEqual(['sandbox-workspace:stale']);
      expect(d.out.join('')).toMatch(/pruned 1 image\(s\), kept 2 referenced/);
      const d2 = deps({
        homeDir: home,
        runner: { run: () => ({ status: 0, stdout: 'sandbox-workspace:keep\n', stderr: '' }) },
      });
      expect(await main(['image', 'prune'], d2)).toBe(0);
      expect(d2.out.join('')).toMatch(/no unreferenced workspace images/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails closed with exit 2 on a corrupt registry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-main-'));
    try {
      writeFileSync(join(home, 'registry.json'), '{broken', 'utf8');
      const nested = join(home, '.agent.sandbox');
      mkdirSync(nested, { recursive: true });
      renameSync(join(home, 'registry.json'), join(nested, 'registry.json'));
      const d = deps({ homeDir: home });
      expect(await main(['doctor'], d)).toBe(2);
      expect(d.err.join('')).toMatch(/cannot read registry/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('serves resource help topics', async () => {
    expect(await main(['workspace', 'help'], deps())).toBe(0);
    expect(await main(['agent', 'help'], deps())).toBe(0);
    expect(await main(['image', 'help'], deps())).toBe(0);
  });

  it('prints group help for bare groups and per-action help on demand', async () => {
    const group = deps();
    expect(await main(['workspace'], group)).toBe(0);
    expect(group.out.join('')).toContain('Commands:');
    expect(group.out.join('')).toContain('prune');
    const action = deps();
    expect(await main(['workspace', 'restart', '--help'], action)).toBe(0);
    expect(action.out.join('')).toContain('Usage: sandbox workspace restart');
    const image = deps();
    expect(await main(['image', 'activate', '--help'], image)).toBe(0);
    expect(image.out.join('')).toContain('Usage: sandbox image activate');
    const unknown = deps();
    expect(await main(['workspace', 'frobnicate', '--help'], unknown)).toBe(2);
    const retired = deps();
    expect(await main(['workspace', 'add'], retired)).toBe(2);
    expect(await main(['workspace', 'forget'], retired)).toBe(2);
    const add = deps();
    expect(await main(['link', '--help'], add)).toBe(0);
    expect(add.out.join('')).toContain('Usage: sandbox link');
  });

  it('checks and applies self-updates without touching workspaces', async () => {
    const view = (version: string) => ({
      run: (command: string, args: string[]) => {
        if (command === 'npm' && args[0] === 'view') return { status: 0, stdout: `${version}\n`, stderr: '' };
        if (command === 'npm' && args[0] === 'install') return { status: 0, stdout: 'added\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const check = deps({ runner: view('9.9.9') });
    expect(await main(['update', '--check'], check)).toBe(0);
    expect(check.out.join('')).toMatch(/current .* latest 9\.9\.9/);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const current = deps({ runner: view(pkg.version) });
    expect(await main(['update'], current)).toBe(0);
    expect(current.out.join('')).toContain('already current');
    const upgrade = deps({ runner: view('9.9.9') });
    expect(await main(['update'], upgrade)).toBe(0);
    expect(upgrade.out.join('')).toMatch(/updated sandbox .* -> 9\.9\.9/);
    const broken = deps({ runner: { run: () => ({ status: 1, stdout: '', stderr: 'boom' }) } });
    expect(await main(['update'], broken)).toBe(1);
    expect(broken.err.join('')).toMatch(/cannot check/);
  });

  it('moves the legacy home directory on mutating commands only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-main-'));
    try {
      mkdirSync(join(home, '.sandbox'), { recursive: true });
      saveRegistry(join(home, '.sandbox', 'registry.json'), emptyRegistry());
      // The move is a renameSync, so help, version and doctor must not
      // trigger it. doctor is read-only by contract 4: asking the question
      // reports a pending move (its own check) instead of performing one.
      for (const argv of [['--version'], ['--help'], ['doctor']]) {
        const probe = deps({ homeDir: home, cwd: join(home, 'proj') });
        expect(await main(argv, probe)).toBe(0);
        expect(probe.err.join('')).not.toContain('sandbox home moved');
        expect(existsSync(join(home, '.sandbox', 'registry.json'))).toBe(true);
        expect(existsSync(join(home, '.agent.sandbox'))).toBe(false);
      }
      const doctor = deps({ homeDir: home, cwd: join(home, 'proj') });
      await main(['doctor'], doctor);
      expect(doctor.out.join('')).toContain('home-dir');
      // A mutating command performs the move, carrying the registry over.
      const list = deps({ homeDir: home, cwd: join(home, 'proj') });
      expect(await main(['workspace', 'list'], list)).toBe(0);
      expect(list.err.join('')).toContain('sandbox home moved from ~/.sandbox to ~/.agent.sandbox');
      expect(existsSync(join(home, '.sandbox'))).toBe(false);
      expect(existsSync(join(home, '.agent.sandbox', 'registry.json'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('skips the git probe outside a repository', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-main-'));
    try {
      expect(hasGitDir(home)).toBe(false);
      mkdirSync(join(home, 'repo', '.git'), { recursive: true });
      expect(hasGitDir(join(home, 'repo', 'sub'))).toBe(true);
      const seen: string[][] = [];
      const d = deps({
        homeDir: home,
        cwd: home,
        runner: { run: (command: string, args: string[]) => { seen.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; } },
      });
      expect(await main(['doctor'], d)).toBe(0);
      expect(seen.some((call) => call[0] === 'git')).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('turns a terminal-less attach failure into an actionable message', () => {
    const d = deps();
    const deadTerm = { reattach: () => { throw new Error('open terminal failed: not a terminal'); } } as unknown as TerminalEngine;
    try {
      reattachOrHint(d, deadTerm, 'sandbox-demo');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('the window is ready');
      expect((error as Error).message).toContain('sandbox workspace attach');
    }
    let attached = 0;
    const liveTerm = { reattach: () => { attached += 1; } } as unknown as TerminalEngine;
    reattachOrHint(d, liveTerm, 'sandbox-demo');
    expect(attached).toBe(1);
  });
});

describe.skipIf(!existsSync(new URL('../dist/bin/sandbox.js', import.meta.url)))('installed entry point', () => {
  it('fires through a symlinked bin path like a global install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-bin-'));
    try {
      const link = join(dir, 'sandbox');
      symlinkSync(new URL('../dist/bin/sandbox.js', import.meta.url), link);
      const output = execFileSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
      expect(output).toMatch(/sandbox \d+\.\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
