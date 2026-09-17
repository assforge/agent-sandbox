import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { main, type MainDeps } from '../src/bin/sandbox.js';
import { containerState } from '../src/docker.js';
import type { RunResult } from '../src/docker.js';
import { emptyRegistry, loadRegistry, registerWorkspace } from '../src/registry.js';

/** Scripted docker+tmux world. Captures env from docker run; serves ready.json accordingly. */
class FakeWorld {
  calls: string[][] = [];
  containers = new Map<string, { running: boolean; owner: string; generation: string; fingerprint: string; startedAt: number }>();
  volumes = new Set<string>();
  sessions = new Map<string, Set<string>>();
  images = new Set<string>(['sandbox-workspace:current']);

  run = (command: string, args: string[]): RunResult => {
    this.calls.push([command, ...args]);
    if (command === 'docker') return this.docker(args);
    if (command === 'tmux') return this.tmux(args);
    if (command === 'npm') return this.npm(args);
    return { status: 0, stdout: '', stderr: '' };
  };

  private docker(args: string[]): RunResult {
    const [verb, ...rest] = args;
    if (verb === 'ps') {
      const filterIndex = rest.indexOf('--filter');
      let names = [...this.containers.keys()];
      if (filterIndex >= 0) {
        const filter = rest[filterIndex + 1] as string;
        const match = /^name=\^\/(.+)\$$/.exec(filter);
        if (match) names = names.filter((name) => name === match[1]);
      }
      return { status: 0, stdout: names.join('\n'), stderr: '' };
    }
    if (verb === 'inspect' && rest[0] === '--format') {
      const name = rest[rest.length - 1] as string;
      const container = this.containers.get(name);
      if (!container) return { status: 1, stdout: '', stderr: 'No such container' };
      return { status: 0, stdout: `${container.running}|true|${container.owner}`, stderr: '' };
    }
    if (verb === 'volume' && rest[0] === 'ls') {
      const filterIndex = rest.indexOf('--filter');
      let names = [...this.volumes];
      if (filterIndex >= 0) {
        const filter = rest[filterIndex + 1] as string;
        const match = /^name=\^(.+)\$$/.exec(filter);
        if (match) names = names.filter((name) => name === match[1]);
      }
      return { status: 0, stdout: names.join('\n'), stderr: '' };
    }
    if (verb === 'volume' && rest[0] === 'create') {
      this.volumes.add(rest[rest.length - 1] as string);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (verb === 'run' && rest[0] === '-d') {
      const nameIndex = rest.indexOf('--name');
      const name = rest[nameIndex + 1] as string;
      const env: Record<string, string> = {};
      for (let i = 0; i < rest.length; i += 1) {
        if (rest[i] === '-e' && rest[i + 1]) {
          const [key, ...value] = (rest[i + 1] as string).split('=');
          env[key as string] = value.join('=');
        }
      }
      let owner = '';
      for (let i = 0; i < rest.length; i += 1) {
        if (rest[i] === 'sandbox.workspace=false') owner = '';
        if (typeof rest[i] === 'string' && (rest[i] as string).startsWith('sandbox.workspace=')) {
          owner = (rest[i] as string).split('=')[1] as string;
        }
      }
      this.containers.set(name, {
        running: true,
        owner,
        generation: env['SANDBOX_GENERATION'] ?? '',
        fingerprint: env['SANDBOX_CONFIG_FINGERPRINT'] ?? '',
        startedAt: Math.floor(Date.now() / 1000),
      });
      return { status: 0, stdout: 'cid', stderr: '' };
    }
    if (verb === 'start') {
      const container = this.containers.get(rest[0] as string);
      if (!container) return { status: 1, stdout: '', stderr: 'no such container' };
      container.running = true;
      container.startedAt = Math.floor(Date.now() / 1000);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (verb === 'stop') {
      const container = this.containers.get(rest[0] as string);
      if (!container) return { status: 1, stdout: '', stderr: 'no such container' };
      container.running = false;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (verb === 'exec' && rest.includes('cat')) {
      const container = this.containers.get(rest[0] as string);
      if (!container || !container.running) return { status: 1, stdout: '', stderr: 'not running' };
      return {
        status: 0,
        stdout: JSON.stringify({ generation: container.generation, fingerprint: container.fingerprint, started_at: container.startedAt }),
        stderr: '',
      };
    }
    if (verb === 'exec') {
      return { status: 0, stdout: 'exec-output\n', stderr: '' };
    }
    if (verb === 'cp') return { status: 0, stdout: '', stderr: '' };
    if (verb === 'image' && rest[0] === 'inspect') {
      return this.images.has(rest[rest.length - 1] as string)
        ? { status: 0, stdout: 'sha256:x', stderr: '' }
        : { status: 1, stdout: '', stderr: 'no such image' };
    }
    if (verb === 'images' && rest[0] === '-q') {
      return { status: 0, stdout: this.images.has(rest[1] as string) ? 'sha256:x' : '', stderr: '' };
    }
    if (verb === 'ps') {
      return { status: 0, stdout: [...this.containers.keys()].join('\n'), stderr: '' };
    }
    if (verb === 'build') return { status: 0, stdout: 'built', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  }

  private tmux(args: string[]): RunResult {
    if (args[0] === 'has-session') {
      return this.sessions.has(args[2] as string)
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: 'no session' };
    }
    if (args[0] === 'new-session') {
      const nameIndex = args.indexOf('-s');
      const windowIndex = args.indexOf('-n');
      this.sessions.set(args[nameIndex + 1] as string, new Set([args[windowIndex + 1] as string]));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'new-window') {
      const target = (args[args.indexOf('-t') + 1] as string).replace(/:$/, '');
      const name = args[args.indexOf('-n') + 1] as string;
      this.sessions.get(target)?.add(name);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'list-windows') {
      const session = args[args.indexOf('-t') + 1] as string;
      return { status: 0, stdout: [...(this.sessions.get(session) ?? [])].join('\n'), stderr: '' };
    }
    if (args[0] === 'list-sessions') {
      return { status: 0, stdout: [...this.sessions.keys()].join('\n'), stderr: '' };
    }
    if (args[0] === 'select-window' || args[0] === 'attach-session' || args[0] === 'switch-client') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'volume' || args[0] === 'ls') return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  }

  private npm(args: string[]): RunResult {
    if (args[0] === 'ls') return { status: 0, stdout: JSON.stringify({ dependencies: {} }), stderr: '' };
    if (args[0] === 'view') return { status: 0, stdout: '9.9.9\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'sandbox-life-'));
  const root = mkdtempSync(join(tmpdir(), 'sandbox-root-'));
  const world = new FakeWorld();
  const out: string[] = [];
  const err: string[] = [];
  const deps: MainDeps = {
    cwd: root,
    homeDir: home,
    lockDir: join(home, 'locks'),
    platform: 'darwin',
    nodeVersion: 'v22.0.0',
    pathLookup: (name) => `/usr/bin/${name}`,
    commandSucceeds: () => true,
    runner: world,
    insideTmux: false,
    stdinIsTTY: true,
    assumeYes: true,
    confirm: async () => true,
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
  };
  return { home, root, world, deps, out, err };
}

describe('container state detection', () => {
  it('reports absent, running, and foreign distinctly', () => {
    const world = new FakeWorld();
    expect(containerState(world, 'missing', 'w')).toBe('absent');
    world.containers.set('mine', { running: true, owner: 'w', generation: 'g', fingerprint: 'f', startedAt: 0 });
    expect(containerState(world, 'mine', 'w')).toBe('running');
    world.containers.set('theirs', { running: true, owner: 'other', generation: 'g', fingerprint: 'f', startedAt: 0 });
    expect(containerState(world, 'theirs', 'w')).toBe('foreign');
  });
});

describe('workspace lifecycle flows', () => {
  it('registers, activates an image, starts, opens windows, and stops', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      const afterRegister = loadRegistry(join(home, '.sandbox', 'registry.json'));
      const id = Object.keys(afterRegister.workspaces)[0] as string;
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      expect(world.containers.get(`sandbox-${id}`)?.running).toBe(true);
      expect(await main(['claude', '--name', 'rollout', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('created window rollout (claude)');
      expect(await main(['workspace', 'status', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('rollout(claude)');
      expect(await main(['workspace', 'stop', '--workspace', root], deps)).toBe(0);
      expect(world.containers.get(`sandbox-${id}`)?.running).toBe(false);
      world.images.add('sandbox-workspace:next');
      expect(await main(['image', 'activate', 'sandbox-workspace:next', '--workspace', root], deps)).toBe(0);
      expect(await main(['image', 'rollback', '--workspace', root], deps)).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to start without a selected image and refuses foreign containers', async () => {
    const { home, root, world, deps, err } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(1);
      expect(err.join('')).toMatch(/no image selected/);
      const registry = emptyRegistry();
      const entry = registerWorkspace(registry, root, [root]);
      world.containers.set(entry.container, { running: true, owner: 'someone-else', generation: 'g', fingerprint: 'f', startedAt: 0 });
      expect(containerState(world, entry.container, entry.id)).toBe('foreign');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs exec with exit propagation, backup, and dry-run migration', async () => {
    const { home, root, deps, out } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['workspace', 'exec', '--workspace', root, '--', 'echo', 'hi'], deps)).toBe(0);
      expect(out.join('')).toContain('exec-output');
      const backupDir = join(home, 'backup');
      expect(await main(['workspace', 'backup', '--workspace', root, '--output', backupDir], deps)).toBe(0);
      expect(out.join('')).toContain('written to');
      expect(await main(['workspace', 'migrate', '--workspace', root, '--source', 'claude-relay'], deps)).toBe(0);
      expect(out.join('')).toContain('dry-run');
      expect(await main(['workspace', 'list'], deps)).toBe(0);
      expect(await main(['agent', 'list'], deps)).toBe(0);
      expect(await main(['agent', 'outdated'], deps)).toBe(0);
      expect(await main(['agent', 'upgrade', 'codex'], deps)).toBe(0);
      expect(await main(['image', 'list'], deps)).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses a matching window and rejects occupied names', async () => {
    const { home, root, deps, out } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('reused window codex');
      expect(await main(['claude', '--name', 'codex', '--workspace', root], deps)).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
