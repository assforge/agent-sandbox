import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { main, type MainDeps } from '../src/bin/sandbox.js';
import { containerState } from '../src/docker.js';
import type { RunResult } from '../src/docker.js';
import { lockPath } from '../src/lock.js';
import { emptyRegistry, loadRegistry, registerWorkspace, saveRegistry } from '../src/registry.js';

/** Scripted docker+tmux world. Captures env from docker run; serves ready.json accordingly. */
class FakeWorld {
  calls: string[][] = [];
  containers = new Map<string, { running: boolean; owner: string; generation: string; fingerprint: string; startedAt: number; imageId: string; network: string }>();
  volumes = new Set<string>();
  networks = new Map<string, boolean>();
  sessions = new Map<string, Map<string, boolean>>();
  hiddenSessions = new Set<string>();
  listWindowsCalls = 0;
  reviveAfterListWindows = 0;
  revive: { session: string; window: string } | null = null;
  images = new Set<string>(['sandbox-workspace:current']);
  failBuild = false;
  lastBuildArgs: Record<string, string> = {};
  curlText = '2.1.277\n';
  grokText = '1.0.34\n';
  execVersions: string | null = null;
  /** When true, list-windows answers with a failure instead of a listing. */
  windowListingFails = false;
  /** When set, kill-window fails with this detail instead of closing. */
  killWindowFails: string | null = null;

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
    if (command === 'curl') {
      const url = args[args.length - 1];
      if (typeof url === 'string' && url.includes('x.ai')) return { status: 0, stdout: this.grokText, stderr: '' };
      return { status: 0, stdout: this.curlText, stderr: '' };
    }
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
          stdout: `claude=${arg('CLAUDE_VERSION', '2.1.276')} (Claude Code)\nopencode-ai=${arg('OPENCODE_VERSION', '1.18.31')}\n@openai/codex=codex-cli ${arg('CODEX_VERSION', '0.155.1')}\n@github/copilot=GitHub Copilot CLI ${arg('COPILOT_VERSION', '1.0.86')}.\n@earendil-works/pi-coding-agent=${arg('PI_VERSION', '0.85.1')}\ngrok=grok ${arg('GROK_VERSION', '1.0.34')} (abc) [stable]\nagy=${arg('AGY_VERSION', '1.2.7')}\n@qwen-code/qwen-code=${arg('QWEN_VERSION', '0.24.1')}\n@moonshot-ai/kimi-code=${arg('KIMI_VERSION', '2.0.2')}\n@mimo-ai/cli=${arg('MIMO_VERSION', '0.1.14')}\n@augmentcode/auggie=${arg('AUGGIE_VERSION', '0.36.0')} (commit abc)\ncursor=2026.09.18-9a7762b\ndevin=devin 3000.10.31 (b98cc431)\nkiro=kiro-cli 2.22.1\n`,
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
    if (verb === 'exec' && rest.some((arg) => typeof arg === 'string' && arg.includes('claude --version'))) {
      return {
        status: 0,
        stdout: this.execVersions ?? 'claude=2.1.276 (Claude Code)\nopencode-ai=1.18.31\n@openai/codex=codex-cli 0.155.1\n@github/copilot=GitHub Copilot CLI 1.0.86.\n@earendil-works/pi-coding-agent=0.85.1\ngrok=grok 1.0.34 (abc) [stable]\nagy=1.2.7\n@qwen-code/qwen-code=0.24.1\n@moonshot-ai/kimi-code=2.0.2\n@mimo-ai/cli=0.1.14\n@augmentcode/auggie=0.36.0 (commit abc)\ncursor=2026.09.18-9a7762b\ndevin=devin 3000.10.31 (b98cc431)\nkiro=kiro-cli 2.22.1\n',
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
      const tagIndex = args.indexOf('-t');
      if (tagIndex >= 0 && typeof args[tagIndex + 1] === 'string') {
        this.images.add(args[tagIndex + 1] as string);
      }
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
    if (args[0] === 'kill-session') {
      this.sessions.delete(args[args.indexOf('-t') + 1] as string);
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
      this.listWindowsCalls += 1;
      if (this.windowListingFails) return { status: 1, stdout: '', stderr: 'no server running' };
      if (this.revive && this.listWindowsCalls > this.reviveAfterListWindows) {
        this.sessions.get(this.revive.session)?.set(this.revive.window, true);
      }
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
      const names = [...this.sessions.keys()].filter((name) => !this.hiddenSessions.has(name));
      return { status: 0, stdout: names.join('\n'), stderr: '' };
    }
    if (args[0] === 'kill-window') {
      const target = args[args.indexOf('-t') + 1] as string;
      const [session, window] = target.split(':');
      if (this.killWindowFails !== null) {
        return { status: 1, stdout: '', stderr: this.killWindowFails };
      }
      this.sessions.get(session as string)?.delete(window as string);
      return { status: 0, stdout: '', stderr: '' };
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
      const floors: Record<string, string> = {
        'opencode-ai': '1.18.31',
        '@openai/codex': '0.155.1',
        '@github/copilot': '1.0.86',
        '@earendil-works/pi-coding-agent': '0.85.1',
        '@qwen-code/qwen-code': '0.24.1',
        '@moonshot-ai/kimi-code': '2.0.2',
        '@mimo-ai/cli': '0.1.14',
        '@augmentcode/auggie': '0.36.0',
      };
      return { status: 0, stdout: `${floors[args[1] as string] ?? '9.9.9'}\n`, stderr: '' };
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
      const afterRegister = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(afterRegister.workspaces)[0] as string;
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      expect(world.containers.get(`sandbox-${id}`)?.running).toBe(true);
      expect(await main(['claude', '--name', 'rollout', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('created window rollout (claude)');
      expect(await main(['workspace', 'status', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('rollout(claude:shared)');
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
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
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
      out.length = 0;
      // agy has no latest feed: an explicit single still rebuilds bare latest-first.
      expect(await main(['agent', 'upgrade', 'agy'], deps)).toBe(0);
      expect(out.join('')).toContain('Activate explicitly');
      expect(await main(['agent', 'upgrade', 'all'], deps)).toBe(0);
      expect(out.join('')).toContain('claude: minimum 2.1.276, latest 2.1.277');
      expect(await main(['agent', 'upgrade', 'nope'], deps)).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restarts with a single confirmation and resolves the workspace from cwd', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      let confirms = 0;
      const counting = { ...deps, cwd: root, confirm: async () => { confirms += 1; return true; } };
      expect(await main(['workspace', 'register', '--root', root], counting)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current'], counting)).toBe(0);
      expect(await main(['workspace', 'start'], counting)).toBe(0);
      expect(await main(['codex', '--no-attach'], counting)).toBe(0);
      expect(await main(['workspace', 'restart'], counting)).toBe(0);
      expect(confirms).toBe(1);
      expect(out.join('')).toContain('restarted');
      const created = world.calls.find((call) => call[0] === 'docker' && call[1] === 'run' && call[2] === '-d');
      const volumes = (created ?? []).filter((arg, index) => (created as string[])[index - 1] === '-v');
      expect(volumes.some((volume) => {
        const [source, target] = String(volume).split(':');
        return source === target && (source ?? '').includes('sandbox-root-');
      })).toBe(true);
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      expect(world.containers.get(`sandbox-${id}`)?.running).toBe(true);
      expect(await main(['workspace', 'status'], counting)).toBe(0);
      expect(out.join('')).toContain(id);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('upgrades drifted agents in one confirmed step and skips current ones', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      let confirms = 0;
      const counting = { ...deps, confirm: async () => { confirms += 1; return true; } };
      expect(await main(['workspace', 'register', '--root', root], counting)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], counting)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], counting)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--no-attach'], counting)).toBe(0);
      expect(await main(['workspace', 'upgrade', '--workspace', root], counting)).toBe(0);
      expect(confirms).toBe(1);
      expect(out.join('')).toContain('claude: minimum 2.1.276, latest 2.1.277');
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      const upgraded = registry.workspaces[id]?.image ?? '';
      expect(upgraded.startsWith('sandbox-workspace:upgrade-')).toBe(true);
      expect(world.containers.get(`sandbox-${id}`)?.running).toBe(true);
      world.curlText = '2.1.277\n';
      expect(await main(['workspace', 'upgrade', '--workspace', root], counting)).toBe(0);
      expect(out.join('')).toContain('already at its latest version');
      expect(confirms).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rebuilds when the recording predates an engine', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      const counting = { ...deps, confirm: async () => true };
      expect(await main(['workspace', 'register', '--root', root], counting)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], counting)).toBe(0);
      out.length = 0;
      // Simulate an image recorded before cursor existed: hold every other
      // latest at its recorded value so only the missing key can trigger.
      world.curlText = '2.1.276\n';
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      const entry = registry.workspaces[id];
      if (!entry?.agentVersions) throw new Error('expected a recording from activate');
      delete entry.agentVersions['cursor'];
      saveRegistry(join(home, '.agent.sandbox', 'registry.json'), registry);
      expect(await main(['workspace', 'upgrade', '--workspace', root], counting)).toBe(0);
      expect(out.join('')).toContain('upgraded to sandbox-workspace:upgrade-');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns on agent version drift inside running containers', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      expect(await main(['doctor', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).not.toContain('agent-drift');
      world.execVersions = 'claude=2.1.276 (Claude Code)\nopencode-ai=1.18.31\n@openai/codex=codex-cli 9.9.9\n@github/copilot=GitHub Copilot CLI 1.0.86.\n@earendil-works/pi-coding-agent=0.85.1\ngrok=grok 1.0.34 (abc) [stable]\nagy=1.2.7\n@qwen-code/qwen-code=0.24.1\n@moonshot-ai/kimi-code=2.0.2\n@mimo-ai/cli=0.1.14\n@augmentcode/auggie=0.36.0 (commit abc)\ncursor=2026.09.18-9a7762b\ndevin=devin 3000.10.31 (b98cc431)\nkiro=kiro-cli 2.22.1\n';
      expect(await main(['doctor', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('agent-drift-codex');
      expect(out.join('')).toContain('sandbox workspace upgrade');
      const probe = world.calls.find((call) => call.some((arg) => typeof arg === 'string' && arg.includes('claude --version')));
      expect(probe).not.toContain('-t');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('mounts and unmounts extra paths with the root guard shared', async () => {
    const { home, root, deps, out } = setup();
    try {
      const extra = mkdtempSync(join(tmpdir(), 'sandbox-mnt-'));
      try {
        expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
        expect(await main(['workspace', 'mount', extra, '--workspace', root], deps)).toBe(0);
        expect(out.join('')).toContain('applies on next start');
        expect(await main(['workspace', 'mount', extra, '--workspace', root], deps)).toBe(0);
        expect(out.join('')).toContain('already present');
        expect(await main(['workspace', 'unmount', extra, '--workspace', root], deps)).toBe(0);
        expect(await main(['workspace', 'unmount', root, '--workspace', root], deps)).toBe(2);
        const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
        const id = Object.keys(registry.workspaces)[0] as string;
        expect(registry.workspaces[id]?.mounts).not.toContain(extra);
      } finally {
        rmSync(extra, { recursive: true, force: true });
      }
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
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      const net = `sandbox-net-${id}`;
      expect(world.networks.has(net)).toBe(true);
      const createCall = world.calls.find((call) => call.includes('network') && call.includes('create'));
      expect(createCall).toContain('--internal');
      const runCall = world.calls.find((call) => call[0] === 'docker' && call[1] === 'run' && call.includes('--cap-drop'));
      expect(runCall).toContain('--cap-drop');
      expect(runCall).toContain(net);
      const repairCall = world.calls.find((call) => call[0] === 'docker' && call.includes('chown'));
      expect(repairCall).toEqual(expect.arrayContaining(['run', '--rm', '--user', 'root', '--entrypoint', 'chown']));
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
      expect(out.join('')).toContain('codex(codex:shared)');
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
      expect(await main(['link'], cwdDeps)).toBe(0);
      expect(out.join('')).toContain('registered');
      expect(loadRegistry(join(home, '.agent.sandbox', 'registry.json')).workspaces).not.toEqual({});
      expect(await main(['link', join(home, 'no-such-dir')], cwdDeps)).toBe(2);
      expect(await main(['register'], cwdDeps)).toBe(2);
      expect(await main(['add'], cwdDeps)).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('unregisters only after confirmation and keeps data resources', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      expect(await main(['unlink', root], deps)).toBe(1);
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      const deny = { ...deps, assumeYes: false, confirm: async () => false };
      expect(await main(['unlink', root], deny)).toBe(1);
      expect(await main(['unlink', root], deps)).toBe(0);
      expect(out.join('')).toContain('unregistered');
      expect(loadRegistry(join(home, '.agent.sandbox', 'registry.json')).workspaces).toEqual({});
      expect(world.volumes.size).toBeGreaterThan(0);
      expect(world.containers.size).toBe(0);
      expect(await main(['workspace', 'unregister', '--workspace', root], deps)).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prunes stopped containers and keeps everything else', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      let confirms = 0;
      const counting = { ...deps, confirm: async () => { confirms += 1; return true; } };
      expect(await main(['workspace', 'register', '--root', root], counting)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], counting)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], counting)).toBe(0);
      expect(await main(['workspace', 'prune', '--workspace', root], counting)).toBe(0);
      expect(out.join('')).toContain('no stopped workspace containers');
      expect(confirms).toBe(0);
      expect(await main(['workspace', 'stop', '--workspace', root], counting)).toBe(0);
      expect(await main(['workspace', 'prune', '--workspace', root], counting)).toBe(0);
      expect(confirms).toBe(1);
      expect(out.join('')).toContain('pruned sandbox-');
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      expect(registry.workspaces[id]).toBeDefined();
      expect(world.containers.has(`sandbox-${id}`)).toBe(false);
      expect([...world.volumes].some((name) => name.startsWith('sandbox-home-'))).toBe(true);
      const deny = { ...counting, confirm: async () => false };
      expect(await main(['workspace', 'start', '--workspace', root], deny)).toBe(0);
      expect(await main(['workspace', 'stop', '--workspace', root], deny)).toBe(0);
      expect(await main(['workspace', 'prune', '--workspace', root], deny)).toBe(1);
      expect(world.containers.has(`sandbox-${id}`)).toBe(true);
      const root2 = mkdtempSync(join(tmpdir(), 'sandbox-root2-'));
      try {
        expect(await main(['workspace', 'register', '--root', root2], counting)).toBe(0);
        expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root2], counting)).toBe(0);
        expect(await main(['workspace', 'start', '--workspace', root2], counting)).toBe(0);
        expect(await main(['workspace', 'stop', '--workspace', root2], counting)).toBe(0);
        expect(await main(['workspace', 'stop', '--workspace', root], counting)).toBe(0);
        expect(await main(['workspace', 'prune', '--all'], counting)).toBe(0);
        expect(world.containers.size).toBe(0);
      } finally {
        rmSync(root2, { recursive: true, force: true });
      }
      const outside = { ...counting, cwd: home };
      expect(await main(['workspace', 'prune'], outside)).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs instances in shared, fork, and fresh homes with close and fork prune', async () => {
    const { home, root, world, deps, out, err } = setup();
    try {
      let confirms = 0;
      const counting = { ...deps, confirm: async () => { confirms += 1; return true; } };
      const deny = { ...deps, confirm: async () => false };
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--no-attach'], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--name', 'w1', '--home', 'fork', '--no-attach'], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--name', 'w2', '--home', 'fresh', '--no-attach'], deps)).toBe(0);
      const launches = world.calls.filter((call) => call[0] === 'tmux' && call.includes('docker'));
      const homeOf = (window: string): string => {
        const found = launches.find((call) => call[call.indexOf('-n') + 1] === window) ?? [];
        const env = (found as string[]).find((arg) => arg.startsWith('HOME='));
        return env ?? '';
      };
      expect(homeOf('codex')).toBe('HOME=/home/agent');
      expect(homeOf('w1')).toBe('HOME=/home/agent/instances/w1');
      expect(homeOf('w2')).toBe('HOME=/home/agent/instances/w2');
      const seeds = world.calls.filter((call) => call.some((arg) => typeof arg === 'string' && arg.includes('cp -a')));
      expect(seeds.length).toBe(1);
      expect(JSON.stringify(seeds[0])).toMatch(/\.grok/);
      expect(JSON.stringify(seeds[0])).toMatch(/\.gemini/);
      expect(JSON.stringify(seeds[0])).toMatch(/\.kimi-code/);
      expect(JSON.stringify(seeds[0])).toMatch(/\.augment/);
      expect(JSON.stringify(seeds[0])).toMatch(/\.local\/share\/mimocode/);
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      expect(registry.workspaces[id]?.forks).toEqual(['w1']);
      expect(await main(['workspace', 'status', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('codex(codex:shared)');
      expect(await main(['workspace', 'close', 'nope', '--workspace', root], deps)).toBe(1);
      expect(await main(['workspace', 'close', 'w1', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('closed instance w1');
      expect(loadRegistry(join(home, '.agent.sandbox', 'registry.json')).workspaces[id]?.instances.map((i) => i.name)).not.toContain('w1');
      expect(world.sessions.get(`sandbox-${id}`)?.has('w1')).toBe(false);
      expect(await main(['workspace', 'prune', '--forks', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('pruned forks');
      expect(loadRegistry(join(home, '.agent.sandbox', 'registry.json')).workspaces[id]?.forks).toEqual([]);
      const rmCall = world.calls.find((call) => call.some((arg) => typeof arg === 'string' && arg.includes('rm -rf')));
      expect(rmCall).toContain(`sandbox-home-${id}:/v`);
      expect(await main(['workspace', 'prune', '--forks', '--workspace', root], deps)).toBe(0);
      expect(out.join('')).toContain('no orphan fork state');
      const names = (): string[] => loadRegistry(join(home, '.agent.sandbox', 'registry.json')).workspaces[id]?.instances.map((item) => item.name) ?? [];
      expect(names()).toEqual(expect.arrayContaining(['codex', 'w2']));
      expect(await main(['workspace', 'close', 'codex', '--workspace', root], deny)).toBe(1);
      expect(err.join('')).toContain('close cancelled');
      expect(names()).toContain('codex');
      expect(world.sessions.get(`sandbox-${id}`)?.has('codex')).toBe(true);
      const liveBefore = confirms;
      expect(await main(['workspace', 'close', 'codex', '--workspace', root], counting)).toBe(0);
      expect(confirms).toBe(liveBefore + 1);
      expect(names()).not.toContain('codex');
      expect(world.sessions.get(`sandbox-${id}`)?.has('codex')).toBe(false);
      world.sessions.get(`sandbox-${id}`)?.delete('w2');
      const before = confirms;
      expect(await main(['workspace', 'close', 'w2', '--workspace', root], counting)).toBe(0);
      expect(confirms).toBe(before);
      expect(out.join('')).toContain('closed instance w2');
      expect(names()).not.toContain('w2');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips a fork that goes live while prune is confirming', async () => {
    const { home, root, world, deps, out, err } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--name', 'w1', '--home', 'fork', '--no-attach'], deps)).toBe(0);
      expect(await main(['workspace', 'close', 'w1', '--workspace', root], deps)).toBe(0);
      const registryPath = join(home, '.agent.sandbox', 'registry.json');
      const id = Object.keys(loadRegistry(registryPath).workspaces)[0] as string;
      expect(loadRegistry(registryPath).workspaces[id]?.forks).toEqual(['w1']);
      // Reopen w1 while the prune prompt is on screen. Victims were chosen
      // before the prompt; the in-lock re-check must skip the live fork
      // instead of deleting a directory that is back in use.
      const racing = {
        ...deps,
        confirm: async () => {
          const live = loadRegistry(registryPath);
          const entry = live.workspaces[id];
          if (entry && !entry.instances.some((item) => item.name === 'w1')) {
            entry.instances.push({ name: 'w1', kind: 'codex', window: 'w1' });
            saveRegistry(registryPath, live);
          }
          return true;
        },
      };
      expect(await main(['workspace', 'prune', '--forks', '--workspace', root], racing)).toBe(0);
      expect(err.join('')).toContain('skipped fork(s) that became live');
      expect(loadRegistry(registryPath).workspaces[id]?.forks).toEqual(['w1']);
      expect(
        world.calls.some((call) => call.some((arg) => typeof arg === 'string' && arg.includes('/v/instances/w1'))),
      ).toBe(false);
      expect(out.join('')).toContain('no forks pruned');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports honestly when fork victims vanish before deletion', async () => {
    const { home, root, world, deps, out, err } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--name', 'w1', '--home', 'fork', '--no-attach'], deps)).toBe(0);
      expect(await main(['workspace', 'close', 'w1', '--workspace', root], deps)).toBe(0);
      const registryPath = join(home, '.agent.sandbox', 'registry.json');
      const id = Object.keys(loadRegistry(registryPath).workspaces)[0] as string;
      // A concurrent prune already took the fork: by deletion time the name
      // is gone from the file, so there is nothing live to name either.
      const racing = {
        ...deps,
        confirm: async () => {
          const live = loadRegistry(registryPath);
          const entry = live.workspaces[id];
          if (entry) {
            entry.forks = entry.forks.filter((fork) => fork !== 'w1');
            saveRegistry(registryPath, live);
          }
          return true;
        },
      };
      expect(await main(['workspace', 'prune', '--forks', '--workspace', root], racing)).toBe(0);
      expect(out.join('')).toContain('nothing remained eligible');
      expect(out.join('')).not.toContain('became live');
      expect(err.join('')).not.toContain('skipped fork');
      expect(
        world.calls.some((call) => call.some((arg) => typeof arg === 'string' && arg.includes('/v/instances/w1'))),
      ).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still confirms close when list-sessions omits a live window', async () => {    const { home, root, world, deps } = setup();
    try {
      let confirms = 0;
      const counting = { ...deps, confirm: async () => { confirms += 1; return true; } };
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--no-attach'], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      world.hiddenSessions.add(`sandbox-${id}`);
      expect(await main(['workspace', 'close', 'codex', '--workspace', root], counting)).toBe(0);
      expect(confirms).toBe(1);
      expect(loadRegistry(join(home, '.agent.sandbox', 'registry.json')).workspaces[id]?.instances.map((item) => item.name)).not.toContain('codex');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('aborts an unconfirmed close if the window reappears under the lock', async () => {
    const { home, root, world, deps, err } = setup();
    try {
      let confirms = 0;
      const counting = { ...deps, confirm: async () => { confirms += 1; return true; } };
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--name', 'w2', '--no-attach'], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      const session = `sandbox-${id}`;
      world.sessions.get(session)?.delete('w2');
      world.reviveAfterListWindows = 1;
      world.revive = { session, window: 'w2' };
      expect(await main(['workspace', 'close', 'w2', '--workspace', root], counting)).toBe(1);
      expect(confirms).toBe(0);
      expect(err.join('')).toContain('became live');
      expect(loadRegistry(join(home, '.agent.sandbox', 'registry.json')).workspaces[id]?.instances.map((item) => item.name)).toContain('w2');
      expect(world.sessions.get(session)?.has('w2')).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to close when the window listing itself fails', async () => {
    const { home, root, world, deps, err } = setup();
    try {
      let confirms = 0;
      const counting = { ...deps, confirm: async () => { confirms += 1; return true; } };
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--no-attach'], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      const session = `sandbox-${id}`;
      world.windowListingFails = true;
      const before = world.calls.length;
      // An unreadable listing must not read as "the window is gone": that
      // answer skipped the prompt and a later probe killed it unconfirmed.
      await expect(main(['workspace', 'close', 'codex', '--workspace', root], counting)).rejects.toThrow(
        /cannot list tmux windows/,
      );
      expect(err.join('')).not.toContain('closed instance');
      expect(confirms).toBe(0);
      expect(world.calls.slice(before).some((call) => call.includes('kill-window'))).toBe(false);
      expect(world.sessions.get(session)?.has('codex')).toBe(true);
      expect(loadRegistry(join(home, '.agent.sandbox', 'registry.json')).workspaces[id]?.instances.map((item) => item.name)).toContain('codex');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still closes when tmux reports the window already gone', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      let confirms = 0;
      const counting = { ...deps, confirm: async () => { confirms += 1; return true; } };
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--no-attach'], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      // The window was listed, so the prompt still happens; the close then
      // loses the race to something else and must not be reported as failed.
      world.killWindowFails = "can't find window: codex";
      expect(await main(['workspace', 'close', 'codex', '--workspace', root], counting)).toBe(0);
      expect(confirms).toBe(1);
      expect(out.join('')).toContain('closed instance codex');
      expect(loadRegistry(join(home, '.agent.sandbox', 'registry.json')).workspaces[id]?.instances.map((item) => item.name)).not.toContain('codex');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the close fails for any other reason', async () => {
    const { home, root, world, deps } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--no-attach'], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      world.killWindowFails = 'permission denied';
      await expect(main(['workspace', 'close', 'codex', '--workspace', root], deps)).rejects.toThrow(
        /cannot close tmux window/,
      );
      // The registry keeps the instance: a close that did not happen is
      // never reported as one.
      expect(loadRegistry(join(home, '.agent.sandbox', 'registry.json')).workspaces[id]?.instances.map((item) => item.name)).toContain('codex');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recreates the container when a fingerprinted input changes', async () => {
    const { home, root, world, deps } = setup();
    const extra = mkdtempSync(join(tmpdir(), 'sandbox-mount-'));
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--no-attach'], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      const container = `sandbox-${id}`;
      const first = world.containers.get(container)?.fingerprint ?? '';
      expect(first).not.toBe('');
      // A start that changes nothing must not recreate, or every start
      // would destroy the running agents.
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      expect(world.containers.get(container)?.fingerprint).toBe(first);
      expect(await main(['workspace', 'configure', '--workspace', root, '--add-mount', extra], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      // The container that is running must report the configuration it was
      // created with: leaving the old one up makes the readiness loop wait
      // for a fingerprint that container can never produce.
      expect(world.containers.get(container)?.fingerprint).not.toBe(first);
      expect(world.containers.get(container)?.running).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(extra, { recursive: true, force: true });
    }
  });

  it('recreates a stopped container whose fingerprint drifted instead of timing out', async () => {
    const { home, root, world, deps, out } = setup();
    const extra = mkdtempSync(join(tmpdir(), 'sandbox-mount-'));
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      const container = `sandbox-${id}`;
      const first = world.containers.get(container)?.fingerprint ?? '';
      expect(first).not.toBe('');
      expect(await main(['workspace', 'stop', '--workspace', root], deps)).toBe(0);
      expect(world.containers.get(container)?.running).toBe(false);
      // Drift while down is invisible: a stopped container cannot be exec'd,
      // so the pre-start check reads nothing and lets it through.
      expect(await main(['workspace', 'configure', '--workspace', root, '--add-mount', extra], deps)).toBe(0);
      const rmsBefore = world.calls.filter((call) => call[0] === 'docker' && call[1] === 'rm').length;
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      // The first fingerprint seen after start cannot match, so the stale
      // container is recreated once instead of waited out until timeout.
      expect(out.join('')).toContain('ready');
      expect(world.containers.get(container)?.fingerprint).not.toBe(first);
      expect(world.containers.get(container)?.running).toBe(true);
      expect(world.calls.filter((call) => call[0] === 'docker' && call[1] === 'rm').length).toBe(rmsBefore + 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(extra, { recursive: true, force: true });
    }
  });

  it('probes the workspace network through the workspace runtime, not docker', async () => {
    const { home, root, world, deps } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['workspace', 'configure', '--workspace', root, '--runtime', 'apple'], deps)).toBe(0);
      const appleDeps = {
        ...deps,
        runner: {
          run: (command: string, args: string[]) => {
            // Delegate first so the call is recorded on the shared log, then
            // override the answer for the apple CLI.
            const recorded = world.run(command, args);
            if (command !== 'container') return recorded;
            // Well-formed but degenerate: enough for the apple engine to
            // answer, and an unknown network mode so its networkInternal
            // fails closed. Doctor must survive that, not crash on it.
            if (args[0] === 'list' || (args[0] === 'network' && args[1] === 'list')) {
              return { status: 0, stdout: '[]', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        },
      };
      world.calls.length = 0;
      expect(await main(['doctor'], appleDeps)).toBe(1);
      // The literal docker probe reported on a runtime this workspace does
      // not use, and never reached the apple engine's own probe.
      expect(world.calls.filter((call) => call[0] === 'docker' && call[1] === 'network' && call[2] === 'ls')).toEqual([]);
      expect(world.calls.some((call) => call[0] === 'container' && call[1] === 'network')).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retires the previous terminal engine when the terminal switches', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--no-attach'], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      const container = `sandbox-${id}`;
      const session = `sandbox-${id}`;
      expect(world.sessions.get(session)?.has('codex')).toBe(true);
      world.calls.length = 0;
      expect(await main(['workspace', 'configure', '--workspace', root, '--terminal', 'herder'], deps)).toBe(0);
      // The windows belong to the engine that made them, and the plan now
      // says so instead of only promising to recreate them later.
      expect(out.join('')).toContain('kills the old session');
      expect(world.calls.some((call) => call.includes('kill-session'))).toBe(true);
      expect(world.sessions.has(session)).toBe(false);
      // A terminal switch touches neither the container nor the runtime.
      expect(world.containers.get(container)?.running).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retires the previous container and session when the runtime switches', async () => {
    const { home, root, world, deps, out } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['codex', '--workspace', root, '--no-attach'], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      const container = `sandbox-${id}`;
      const session = `sandbox-${id}`;
      expect(world.containers.get(container)?.running).toBe(true);
      world.calls.length = 0;
      expect(await main(['workspace', 'configure', '--workspace', root, '--runtime', 'apple'], deps)).toBe(0);
      expect(out.join('')).toContain('stops and removes the old container');
      // The old container is owned by the old runtime: leaving it up makes
      // it unreachable, because the new engine reads it as foreign.
      expect(world.containers.has(container)).toBe(false);
      expect(world.calls.some((call) => call[0] === 'docker' && call.includes('stop'))).toBe(true);
      expect(world.calls.some((call) => call[0] === 'docker' && call.includes('rm'))).toBe(true);
      // The windows embed the old runtime's binary, so they go too.
      expect(world.sessions.has(session)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds the workspace lock while retiring the previous engine', async () => {
    const { home, root, world, deps } = setup();
    try {
      expect(await main(['workspace', 'register', '--root', root], deps)).toBe(0);
      expect(await main(['image', 'activate', 'sandbox-workspace:current', '--workspace', root], deps)).toBe(0);
      expect(await main(['workspace', 'start', '--workspace', root], deps)).toBe(0);
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
      const id = Object.keys(registry.workspaces)[0] as string;
      // Without the lock a concurrent start holding it could have its
      // container yanked mid-flight by this retirement.
      let lockedDuringRemove: boolean | null = null;
      const spying = {
        ...deps,
        runner: {
          run: (command: string, args: string[]) => {
            if (command === 'docker' && args[0] === 'rm') {
              lockedDuringRemove = existsSync(lockPath(join(home, 'locks'), id));
            }
            return world.run(command, args);
          },
        },
      };
      expect(await main(['workspace', 'configure', '--workspace', root, '--runtime', 'apple'], spying)).toBe(0);
      expect(lockedDuringRemove).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('selects runtimes and records per-workspace overrides', async () => {    const { home, root, world, deps, out, err } = setup();
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
      expect(await main(['shell', '--workspace', root, '--name', 'w1', '--home', 'fresh', '--no-attach'], deps)).toBe(0);
      expect(await main(['shell', '--workspace', root, '--name', 'w2', '--home', 'fresh', '--no-attach'], deps)).toBe(0);
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
      const registry = loadRegistry(join(home, '.agent.sandbox', 'registry.json'));
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
