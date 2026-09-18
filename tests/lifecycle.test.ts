import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  containers = new Map<string, { running: boolean; owner: string; generation: string; fingerprint: string; startedAt: number; imageId: string; network: string }>();
  volumes = new Set<string>();
  networks = new Map<string, boolean>();
  sessions = new Map<string, Map<string, boolean>>();
  images = new Set<string>(['sandbox-workspace:current']);
  failBuild = false;
  lastBuildArgs: Record<string, string> = {};

  imageIdOf = (image: string): string => {
    const alnum = image.replace(/[^a-zA-Z0-9]/g, '');
    return `sha256:s${alnum.length}-fulldigest`;
  };

  shortIdOf = (image: string): string => {
    const alnum = image.replace(/[^a-zA-Z0-9]/g, '');
    return `s${alnum.length}`;
  };

  seedLegacy(): void {
    this.containers.set('pedantic_snyder', { running: true, owner: 'legacy', generation: '', fingerprint: '', startedAt: 0, imageId: 'legacy-img', network: '' });
    for (const volume of ['claude-relay-config', 'claude-relay-codex', 'claude-relay-xdg']) {
      this.volumes.add(volume);
    }
  }

  run = (command: string, args: string[]): RunResult => {
    this.calls.push([command, ...args]);
    if (command === 'docker') return this.docker(args);
    if (command === 'tmux') return this.tmux(args);
    if (command === 'npm') return this.npm(args);
    if (command === 'curl') return { status: 0, stdout: '2.1.277\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  private envOf(args: string[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-e' && args[i + 1]) {
        const [key, ...value] = (args[i + 1] as string).split('=');
        env[key as string] = value.join('=');
      }
    }
    return env;
  }

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
    if (verb === 'network' && rest[0] === 'ls') {
      const filterIndex = rest.indexOf('--filter');
      let names = [...this.networks.keys()];
      if (filterIndex >= 0) {
        const filter = rest[filterIndex + 1] as string;
        const match = /^name=\^(.+)\$$/.exec(filter);
        if (match) names = names.filter((name) => name === match[1]);
      }
      return { status: 0, stdout: names.join('\n'), stderr: '' };
    }
    if (verb === 'network' && rest[0] === 'create') {
      this.networks.set(rest[rest.length - 1] as string, rest.includes('--internal'));
      return { status: 0, stdout: 'netid', stderr: '' };
    }
    if (verb === 'network' && rest[0] === 'inspect') {
      const format = rest[rest.indexOf('--format') + 1] as string;
      if (format.includes('len .Containers')) return { status: 0, stdout: '0', stderr: '' };
      const internal = this.networks.get(rest[rest.length - 1] as string);
      return { status: 0, stdout: internal === true ? 'true' : 'false', stderr: '' };
    }
    if (verb === 'network' && rest[0] === 'rm') {
      this.networks.delete(rest[rest.length - 1] as string);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (verb === 'inspect' && rest[0] === '--format') {
      const format = rest[1] as string;
      const name = rest[rest.length - 1] as string;
      if (format === '{{.Image}}') {
        const container = this.containers.get(name);
        return container ? { status: 0, stdout: container.imageId, stderr: '' } : { status: 1, stdout: '', stderr: 'no such' };
      }
      if (format.startsWith('{{range')) {
        const container = this.containers.get(name);
        return container ? { status: 0, stdout: container.network, stderr: '' } : { status: 1, stdout: '', stderr: 'no such' };
      }
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
      const env = this.envOf(rest);
      let owner = '';
      for (let i = 0; i < rest.length; i += 1) {
        if (typeof rest[i] === 'string' && (rest[i] as string).startsWith('sandbox.workspace=')) {
          owner = (rest[i] as string).split('=')[1] as string;
        }
      }
      const image = rest[rest.length - 3] as string;
      const networkIndex = rest.indexOf('--network');
      const network = networkIndex >= 0 ? (rest[networkIndex + 1] as string) : '';
      this.containers.set(name, {
        running: true,
        owner,
        generation: env['SANDBOX_GENERATION'] ?? '',
        fingerprint: env['SANDBOX_CONFIG_FINGERPRINT'] ?? '',
        startedAt: Math.floor(Date.now() / 1000),
        imageId: this.imageIdOf(image),
        network,
      });
      return { status: 0, stdout: 'cid', stderr: '' };
    }
    if (verb === 'run' && rest[0] === '--rm') {
      const env = this.envOf(rest);
      const script = rest[rest.length - 1] as string;
      if (script.includes('claude --version')) {
        const arg = (name: string, fallback: string): string => this.lastBuildArgs[name] ?? fallback;
        return {
          status: 0,
          stdout: `${arg('CLAUDE_VERSION', '2.1.276')}\n${arg('OPENCODE_VERSION', '1.18.31')}\ncodex-cli ${arg('CODEX_VERSION', '0.154.0')}\nGitHub Copilot CLI ${arg('COPILOT_VERSION', '1.0.85')}.\n`,
          stderr: '',
        };
      }
      if (script.includes('cat /tmp/sandbox-ready/ready.json')) {
        return {
          status: 0,
          stdout: JSON.stringify({ generation: env['SANDBOX_GENERATION'] ?? '', fingerprint: env['SANDBOX_CONFIG_FINGERPRINT'] ?? '' }),
          stderr: '',
        };
      }
      if (script.includes('cp -a /from/. /to/')) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }
    if (verb === 'rm') {
      this.containers.delete(rest[rest.length - 1] as string);
      return { status: 0, stdout: '', stderr: '' };
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
      const image = rest[1] as string;
      return { status: 0, stdout: this.images.has(image) ? this.shortIdOf(image) : '', stderr: '' };
    }
    if (verb === 'ps') {
      return { status: 0, stdout: [...this.containers.keys()].join('\n'), stderr: '' };
    }
    if (verb === 'build') {
      if (this.failBuild) return { status: 1, stdout: 'STEP 3/9 failed\nboom\n', stderr: 'error' };
      this.lastBuildArgs = {};
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--build-arg' && typeof args[i + 1] === 'string') {
          const [key, ...value] = (args[i + 1] as string).split('=');
          this.lastBuildArgs[key as string] = value.join('=');
        }
      }
      return { status: 0, stdout: 'built', stderr: '' };
    }
    if (verb === 'logs') return { status: 0, stdout: 'entrypoint line 1\nready written\n', stderr: '' };
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
      const name = args[nameIndex + 1] as string;
      if (this.sessions.has(name)) return { status: 1, stdout: '', stderr: `duplicate session: ${name}` };
      this.sessions.set(name, new Map([[args[windowIndex + 1] as string, true]]));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'new-window') {
      const target = (args[args.indexOf('-t') + 1] as string).replace(/:$/, '');
      const name = args[args.indexOf('-n') + 1] as string;
      this.sessions.get(target)?.set(name, true);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'list-windows') {
      const session = args[args.indexOf('-t') + 1] as string;
      return { status: 0, stdout: [...(this.sessions.get(session) ?? new Map()).keys()].join('\n'), stderr: '' };
    }
    if (args[0] === 'list-panes') {
      const target = args[args.indexOf('-t') + 1] as string;
      const [session, window] = target.split(':');
      const alive = this.sessions.get(session as string)?.get(window as string);
      if (alive === undefined) return { status: 1, stdout: '', stderr: 'no such window' };
      return { status: 0, stdout: alive ? '0' : '1', stderr: '' };
    }
    if (args[0] === 'respawn-pane') {
      const target = args[args.indexOf('-t') + 1] as string;
      const [session, window] = target.split(':');
      this.sessions.get(session as string)?.set(window as string, true);
      return { status: 0, stdout: '', stderr: '' };
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
    if (args[0] === 'view') {
      const pinned: Record<string, string> = {
        'opencode-ai': '1.18.31',
        '@openai/codex': '0.154.0',
        '@github/copilot': '1.0.85',
      };
      return { status: 0, stdout: `${pinned[args[1] as string] ?? '9.9.9'}\n`, stderr: '' };
    }
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
  };
  return { home, root, world, deps, out, err };
}

describe('container state detection', () => {
  it('reports absent, running, and foreign distinctly', () => {
    const world = new FakeWorld();
    expect(containerState(world, 'missing', 'w')).toBe('absent');
    world.containers.set('mine', { running: true, owner: 'w', generation: 'g', fingerprint: 'f', startedAt: 0, imageId: 'img', network: 'net' });
    expect(containerState(world, 'mine', 'w')).toBe('running');
    world.containers.set('theirs', { running: true, owner: 'other', generation: 'g', fingerprint: 'f', startedAt: 0, imageId: 'img', network: 'net' });
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
      world.containers.set(entry.container, { running: true, owner: 'someone-else', generation: 'g', fingerprint: 'f', startedAt: 0, imageId: 'img', network: 'net' });
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

  it('recreates the container when activation changes the image', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      const before = world.containers.get(`sandbox-${id}`);
      expect(before?.running).toBe(true);
      world.images.add('sandbox-workspace:next');
      expect(await main(['image', 'activate', 'sandbox-workspace:next', '--workspace', root], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      const after = world.containers.get(`sandbox-${id}`);
      expect(after?.imageId).toBe(world.imageIdOf('sandbox-workspace:next'));
      expect(out.join('')).toContain('ready');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('wires upgrade to version resolution and candidate build', async () => {
    const { home, root, deps, out } = setup();
    try {
      expect(await main(['agent', 'upgrade', 'codex'], deps)).toBe(0);
      expect(out.join('')).toContain('Activate explicitly');
      expect(await main(['agent', 'upgrade', 'all'], deps)).toBe(0);
      expect(out.join('')).toContain('claude: pinned 2.1.276, latest 2.1.277');
      expect(await main(['agent', 'upgrade', 'nope'], deps)).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates an internal network for restricted workspaces and recreates on policy switch', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['workspace', 'configure', '--workspace', root, '--network', 'restricted'], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      const net = `sandbox-net-${id}`;
      expect(world.networks.has(net)).toBe(true);
      const createCall = world.calls.find((call) => call.includes('network') && call.includes('create'));
      expect(createCall).toContain('--internal');
      const runCall = world.calls.find((call) => call[0] === 'docker' && call[1] === 'run');
      expect(runCall).toContain('--cap-drop');
      expect(runCall).toContain(net);
      expect(await main(['workspace', 'configure', '--workspace', root, '--network', 'open'], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      expect(world.containers.get(`sandbox-${id}`)?.network).toBe(net);
      expect(out.join('')).toContain('switch network');
      expect(await main(['workspace', 'configure', '--workspace', root, '--network', 'wide'], deps)).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('confirms rollback with live instances and restores from backup', async () => {
    const { home, root, world, deps, out, err } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      world.images.add('sandbox-workspace:next');
      expect(await main(['image', 'activate', 'sandbox-workspace:next', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--no-attach'], deps)).toBe(0);
      const deny = { ...deps, assumeYes: false, confirm: async () => false };
      expect(await main(['image', 'rollback', '--workspace', root], deny)).toBe(1);
      expect(await main(['image', 'rollback', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('rolled back');
      const backupDir = join(home, 'backup');
      expect(await main(['workspace', 'backup', '--workspace', root, '--output', backupDir], deps)).toBe(0);
      expect(await main(['workspace', 'restore', '--workspace', root, '--input', backupDir], deps)).toBe(0);
      expect(out.join('')).toContain('restart the workspace');
      expect(await main(['workspace', 'restore', '--workspace', root, '--input', join(home, 'missing')], deps)).toBe(1);
      expect(await main(['workspace', 'logs', '--workspace', root, '--tail', '10'], deps)).toBe(0);
      expect(out.join('')).toContain('ready written');
      expect(await main(['workspace', 'logs', '--workspace', root, '--tail', 'x'], deps)).toBe(2);
      void err;
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reopens every registered window and reports liveness', async () => {    const { home, root, world, deps, out } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--no-attach'], deps)).toBe(0);
      expect(await main(['shell', '--workspace', root, '--name', 'ops', '--no-attach'], deps)).toBe(0);
      expect(await main(['workspace', 'reopen', '--workspace', root, '--no-attach'], deps)).toBe(0);
      expect(out.join('')).toContain('reused window codex');
      expect(await main(['workspace', 'status', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('codex(codex)');
      world.failBuild = true;
      expect(await main(['image', 'build'], deps)).toBe(1);
      expect(out.join('')).not.toContain('verified');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('registers through the short top-level shortcut', async () => {
    const { home, root, deps, out } = setup();
    try {
      const cwdDeps = { ...deps, cwd: root };
      expect(await main(['register'], cwdDeps)).toBe(0);
      expect(out.join('')).toContain('registered');
      expect(loadRegistry(join(home, '.sandbox', 'registry.json')).workspaces).not.toEqual({});
      expect(await main(['register', join(home, 'no-such-dir')], cwdDeps)).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('unregisters only after confirmation and keeps data resources', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      expect(await main(['unregister', root], deps)).toBe(1);
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      const deny = { ...deps, assumeYes: false, confirm: async () => false };
      expect(await main(['unregister', root], deny)).toBe(1);
      expect(await main(['unregister', root], deps)).toBe(0);
      expect(out.join('')).toContain('unregistered');
      expect(loadRegistry(join(home, '.sandbox', 'registry.json')).workspaces).toEqual({});
      expect(world.volumes.size).toBeGreaterThan(0);
      expect(world.containers.size).toBe(0);
      expect(await main(['workspace', 'unregister', '--workspace', root], deps)).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('selects runtimes and records per-workspace overrides', async () => {
    const { home, root, world, deps, out, err } = setup();
    try {
      expect(await main(['runtime', 'list'], deps)).toBe(0);
      expect(out.join('')).toContain('docker (selected)');
      expect(out.join('')).toContain('apple');
      expect(await main(['runtime', 'use', 'apple'], deps)).toBe(0);
      expect(await main(['runtime', 'use', 'nope'], deps)).toBe(2);
      expect(await main(['terminal', 'list'], deps)).toBe(0);
      expect(out.join('')).toContain('tmux (selected)');
      expect(out.join('')).toContain('herder');
      expect(await main(['terminal', 'use', 'herder'], deps)).toBe(0);
      expect(await main(['terminal', 'use', 'nope'], deps)).toBe(2);
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['workspace', 'configure', '--workspace', root, '--terminal', 'herder'], deps)).toBe(0);
      expect(await main(['workspace', 'configure', '--workspace', root, '--terminal', 'nope'], deps)).toBe(2);
      void world;
      void err;
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a git subdirectory to its worktree root', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      const gitDeps = {
        ...deps,
        cwd: join(root, 'packages', 'app'),
        runner: {
          run: (command: string, args: string[]) => {
            if (command === 'git') return { status: 0, stdout: `${root}\n`, stderr: '' };
            return world.run(command, args);
          },
        },
      };
      expect(await main(['workspace', 'status'], gitDeps)).toBe(0);
      expect(out.join('')).toContain(root);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('copies state volumes on migrate apply and guards the root mount', async () => {
    const { home, root, world, deps, out, err } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      world.seedLegacy();
      expect(await main(['workspace', 'migrate', '--workspace', root, '--source', 'claude-relay', '--apply'], deps)).toBe(0);
      expect(out.join('')).toContain('state volumes copied');
      expect([...world.volumes].some((name) => name.startsWith('sandbox-home-'))).toBe(true);
      expect(await main(['workspace', 'configure', '--workspace', root, '--drop-mount', root], deps)).toBe(2);
      expect(err.join('')).toMatch(/cannot drop the workspace root/);
      expect(await main(['workspace', 'register', '--root', '--json'], deps)).toBe(2);
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
      expect(await main(['claude', '--name', 'bad:name', '--workspace', root], deps)).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores per-instance credentials and isolates launch environments', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      const relay1 = join(home, 'relay1.env');
      const relay2 = join(home, 'relay2.env');
      writeFileSync(relay1, 'RELAY_URL=https://one.example\nRELAY_KEY=key-one\n', 'utf8');
      writeFileSync(relay2, 'RELAY_URL=https://two.example\nRELAY_KEY=key-two\n', 'utf8');
      expect(await main(['credentials', 'set', '--workspace', root, '--instance', 'w1', '--file', relay1], deps)).toBe(0);
      expect(await main(['credentials', 'set', '--workspace', root, '--instance', 'w2', '--file', relay2], deps)).toBe(0);
      expect(await main(['credentials', 'show', '--workspace', root, '--instance', 'w1'], deps)).toBe(0);
      expect(out.join('')).toContain('"RELAY_URL": "***"');
      expect(out.join('')).not.toContain('key-one');
      expect(await main(['credentials', 'list', '--workspace', root], deps)).toBe(0);
      expect(await main(['shell', '--workspace', root, '--name', 'w1', '--no-attach'], deps)).toBe(0);
      expect(await main(['shell', '--workspace', root, '--name', 'w2', '--no-attach'], deps)).toBe(0);
      const launches = world.calls.filter(
        (call) => call[0] === 'tmux' && call.includes('docker'),
      );
      expect(launches.length).toBeGreaterThanOrEqual(2);
      const w1launch = launches.find((call) => call.includes('RELAY_URL=https://one.example')) as string[];
      const w2launch = launches.find((call) => call.includes('RELAY_URL=https://two.example')) as string[];
      expect(w1launch).toBeDefined();
      expect(w2launch).toBeDefined();
      expect(w1launch.join(' ')).toContain('HOME=/home/agent/instances/w1');
      expect(w1launch.join(' ')).not.toContain('key-two');
      expect(w2launch.join(' ')).not.toContain('key-one');
      expect(await main(['credentials', 'clear', '--workspace', root, '--instance', 'w1'], deps)).toBe(0);
      expect(await main(['credentials', 'show', '--workspace', root, '--instance', 'w1'], deps)).toBe(0);
      expect(await main(['credentials', 'help'], deps)).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('respawns dead windows on relaunch and warns on attach to stopped work', async () => {
    const { home, root, world, deps, out, err } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--no-attach'], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      world.sessions.get(`sandbox-${id}`)?.set('codex', false);
      expect(await main(['codex', '--workspace', root, '--no-attach'], deps)).toBe(0);
      expect(out.join('')).toContain('respawned window codex');
      world.sessions.get(`sandbox-${id}`)?.set('codex', false);
      expect(await main(['doctor', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('workspace-windows');
      expect(await main(['workspace', 'stop', '--workspace', root, '--yes'], deps)).toBe(0);
      expect(await main(['workspace', 'attach', '--workspace', root, '--no-attach'], deps)).toBe(0);
      expect(err.join('')).toContain('is stopped');
      const relay = join(home, 'relay.env');
      writeFileSync(relay, 'K=a\n', 'utf8');
      expect(await main(['credentials', 'set', '--workspace', root, '--instance', 'w1', '--file', relay], deps)).toBe(0);
      const deny = { ...deps, assumeYes: false, confirm: async () => false };
      expect(await main(['credentials', 'set', '--workspace', root, '--instance', 'w1', '--file', relay], deny)).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('startup failure', () => {
  it('fails fast when the container exits instead of spamming probes', async () => {
    const { DockerRuntimeEngine } = await import('../src/engines/runtime.js');
    const { ensureReady } = await import('../src/lifecycle.js');
    const calls: string[][] = [];
    const runner = {
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (args.includes('cat')) return { status: 1, stdout: '', stderr: 'not running' };
        if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'inspect') return { status: 0, stdout: 'false|true|w-1', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const registry = emptyRegistry();
    const entry = registerWorkspace(registry, '/w', ['/w']);
    entry.image = 'img:tag';
    expect(() => ensureReady(runner, DockerRuntimeEngine, entry, { image: 'img:tag', probes: 30, probeIntervalMs: 1 })).toThrow(
      /exited during startup/,
    );
    const execProbes = calls.filter((call) => call.includes('cat')).length;
    expect(execProbes).toBeLessThan(30);
  });
});
