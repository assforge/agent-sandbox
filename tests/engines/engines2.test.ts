import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RUNTIME, DEFAULT_TERMINAL, loadHostConfig, saveHostConfig } from '../../src/hostconfig.js';
import { loadUserCatalog } from '../../src/engines/agent.js';
import { AppleContainerRuntimeEngine } from '../../src/engines/apple.js';
import type { RunResult } from '../../src/docker.js';

function fakeRunner(routes: Record<string, RunResult>): { runner: { run: (command: string, args: string[]) => RunResult }; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        for (const [prefix, result] of Object.entries(routes)) {
          const [cmd, ...rest] = prefix.split(' ');
          if (command === cmd && rest.every((part, index) => args[index] === part)) return result;
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };
}

describe('host config', () => {
  it('defaults to docker and round-trips the selection', () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-hostcfg-'));
    try {
      expect(loadHostConfig(home)).toEqual({ runtime: DEFAULT_RUNTIME, terminal: DEFAULT_TERMINAL });
      saveHostConfig(home, { runtime: 'apple', terminal: 'herder' });
      expect(loadHostConfig(home)).toEqual({ runtime: 'apple', terminal: 'herder' });
      writeFileSync(join(home, '.agent.sandbox', 'config.json'), '{broken', 'utf8');
      expect(() => loadHostConfig(home)).toThrow(/cannot read host config/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('user catalog', () => {
  it('merges user JSON entries under built-ins', () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-usercat-'));
    try {
      const dir = join(home, '.agent.sandbox', 'engines');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'kiro.json'), JSON.stringify([{ name: 'kiro', statePaths: ['.kiro'], launch: ['kiro'], npmPackage: null, minimumVersion: '9.9.9' }]), 'utf8');
      const entries = loadUserCatalog(home);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe('kiro');
      writeFileSync(join(dir, 'bad.json'), '{nope', 'utf8');
      expect(() => loadUserCatalog(home)).toThrow(/bad\.json/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('apple engine vectors', () => {  it('builds container-shaped argv from verified flags', () => {
    const { runner, calls } = fakeRunner({});
    const spec = AppleContainerRuntimeEngine.execVector('c1', {
      workdir: '/w',
      argv: ['bash'],
      user: 'agent',
      tty: true,
      env: { A: 'b c', HOME: '/home/agent/instances/w1' },
    });
    expect(spec).toEqual({
      command: 'container',
      args: ['exec', '-i', '-t', '-u', 'agent', '-e', 'A=b c', '-e', 'HOME=/home/agent/instances/w1', '-w', '/w', 'c1', 'bash'],
    });
    void runner;
    expect(calls).toHaveLength(0);
    expect(AppleContainerRuntimeEngine.verified).toBe(true);
    expect(AppleContainerRuntimeEngine.doctorProbes).toEqual({ binary: 'container', args: ['system', 'status'] });
  });

  it('detects presence, ownership, and liveness without schema knowledge', () => {
    const item = { id: 'abc', name: 'sandbox-w', image: 'img' };
    const labels = '{"Config":{"Labels":{"sandbox.managed":"true","sandbox.workspace":"w","sandbox.runtime":"apple"}}}';
    const { runner } = fakeRunner({
      'container list': { status: 0, stdout: JSON.stringify([item]), stderr: '' },
      'container inspect': { status: 0, stdout: labels, stderr: '' },
      'container exec': { status: 0, stdout: '', stderr: '' },
    });
    expect(AppleContainerRuntimeEngine.containerState(runner, 'sandbox-w', 'w')).toBe('running');
    expect(AppleContainerRuntimeEngine.containerRuntime(runner, 'sandbox-w')).toBe('apple');
  });

  it('fails closed on missing labels and unknown shapes', () => {
    const { runner } = fakeRunner({
      'container list': { status: 0, stdout: JSON.stringify([{ name: 'other' }]), stderr: '' },
    });
    expect(AppleContainerRuntimeEngine.containerState(runner, 'sandbox-w', 'w')).toBe('absent');
    const foreign = fakeRunner({
      'container list': { status: 0, stdout: JSON.stringify([{ name: 'sandbox-w' }]), stderr: '' },
      'container inspect': { status: 0, stdout: '{"Labels":{"sandbox.managed":"true","sandbox.workspace":"w","sandbox.runtime":"docker"}}', stderr: '' },
    });
    expect(AppleContainerRuntimeEngine.containerState(foreign.runner, 'sandbox-w', 'w')).toBe('foreign');
    const broken = fakeRunner({
      'container list': { status: 0, stdout: 'not json', stderr: '' },
    });
    expect(() => AppleContainerRuntimeEngine.containerState(broken.runner, 'sandbox-w', 'w')).toThrow(/cannot parse/);
    const nonet = fakeRunner({
      'container network': { status: 0, stdout: '{"mode":"bridged"}', stderr: '' },
    });
    expect(() => AppleContainerRuntimeEngine.networkInternal(nonet.runner, 'n')).toThrow(/unknown network mode/);
    const nat = fakeRunner({
      'container network': { status: 0, stdout: '{"configuration":{"mode":"nat"}}', stderr: '' },
    });
    expect(AppleContainerRuntimeEngine.networkInternal(nat.runner, 'n')).toBe(false);
    const hostOnly = fakeRunner({
      'container network': { status: 0, stdout: '{"configuration":{"mode" : "hostOnly"}}', stderr: '' },
    });
    expect(AppleContainerRuntimeEngine.networkInternal(hostOnly.runner, 'n')).toBe(true);
  });
});

describe('apple engine operations', () => {
  const labels = (runtime: string): string =>
    `{"Config":{"Labels":{"sandbox.managed":"true","sandbox.workspace":"w","sandbox.runtime":"${runtime}"}}}`;

  function stateRunner(): { runner: { run: (command: string, args: string[]) => RunResult }; calls: string[][] } {
    return fakeRunner({
      'container list': { status: 0, stdout: JSON.stringify([{ id: 'c1', name: 'sandbox-w' }]), stderr: '' },
      'container inspect': { status: 0, stdout: labels('apple'), stderr: '' },
      'container exec': { status: 0, stdout: '', stderr: '' },
    });
  }

  it('creates volumes, networks, and containers with labels', () => {
    const { runner, calls } = fakeRunner({
      'container volume': { status: 0, stdout: '[]', stderr: '' },
      'container network': { status: 0, stdout: '[]', stderr: '' },
    });
    AppleContainerRuntimeEngine.ensureVolume(runner, 'vol-1', 'w');
    expect(calls.some((call) => call.includes('volume') && call.includes('create'))).toBe(true);
    AppleContainerRuntimeEngine.ensureNetwork(runner, 'net-1', 'w', true);
    const create = calls.find((call) => call.includes('network') && call.includes('create')) as string[];
    expect(create).toContain('--internal');
    expect(AppleContainerRuntimeEngine.volumeExists(runner, 'vol-1')).toBe(false);
    expect(AppleContainerRuntimeEngine.networkExists(runner, 'net-1')).toBe(false);
    expect(AppleContainerRuntimeEngine.listVolumes(runner)).toEqual([]);
    expect(AppleContainerRuntimeEngine.listContainers(runner)).toEqual([]);
  });

  it('starts, stops, removes, copies, logs, and builds', () => {
    const { runner, calls } = fakeRunner({
      'container image': { status: 0, stdout: JSON.stringify([{ name: 'img:tag', digest: 'sha256:abc123def456' }]), stderr: '' },
      'container inspect': { status: 0, stdout: '{"image":"img:tag sha256:abc123def456"}', stderr: '' },
      'container list': { status: 0, stdout: JSON.stringify([{ name: 'sandbox-w', labels: 'sandbox.managed=true' }]), stderr: '' },
    });
    const entry = { id: 'w', container: 'sandbox-w', root: '/w' };
    expect(() => AppleContainerRuntimeEngine.createContainer(runner, entry, {
      image: 'img:tag', workdir: '/work', mounts: ['/w', '/extra'], homeVolume: 'vol-1',
      network: 'net-1', runtimeName: 'apple', generation: 'g', fingerprint: 'f',
    })).not.toThrow();
    const run = calls.find((call) => call[1] === 'run' && call.includes('--name'));
    expect(run).toContain('--cap-drop');
    expect(run).toContain('sandbox.runtime=apple');
    AppleContainerRuntimeEngine.startContainer(runner, 'sandbox-w');
    AppleContainerRuntimeEngine.stopContainer(runner, 'sandbox-w');
    AppleContainerRuntimeEngine.removeContainer(runner, 'sandbox-w');
    AppleContainerRuntimeEngine.copyVolume(runner, 'a', 'b', 'w');
    expect(AppleContainerRuntimeEngine.imageExists(runner, 'img:tag')).toBe(true);
    expect(AppleContainerRuntimeEngine.referenceImageId(runner, 'img:tag')).toBe('sha256:abc123def456');
    expect(AppleContainerRuntimeEngine.containerImageId(runner, 'sandbox-w')).toBe('sha256:abc123def456');
    AppleContainerRuntimeEngine.buildImage(runner, { contextDir: '/ctx', tag: 't', buildArgs: { A: 'b' } });
    AppleContainerRuntimeEngine.runOneShot(runner, 'img:tag', { K: 'v' }, ['sh']);
    AppleContainerRuntimeEngine.copyFromContainer(runner, 'c', '/p', '/h');
    AppleContainerRuntimeEngine.copyToContainer(runner, 'c', '/h', '/p');
    AppleContainerRuntimeEngine.containerLogs(runner, 'c', '10');
    expect(AppleContainerRuntimeEngine.listManagedContainers(runner)).toEqual(['sandbox-w']);
  });

  it('fails every mutating op closed with the engine name in the message', () => {
    const { runner } = fakeRunner({
      'container volume': { status: 1, stdout: '', stderr: 'nope' },
      'container network': { status: 1, stdout: '', stderr: 'nope' },
      'container start': { status: 1, stdout: '', stderr: 'nope' },
      'container stop': { status: 1, stdout: '', stderr: 'nope' },
      'container delete': { status: 1, stdout: '', stderr: 'nope' },
      'container run': { status: 1, stdout: '', stderr: 'nope' },
      'container build': { status: 1, stdout: '', stderr: 'nope' },
      'container copy': { status: 1, stdout: '', stderr: 'nope' },
    });
    expect(() => AppleContainerRuntimeEngine.ensureVolume(runner, 'v', 'w')).toThrow(/apple runtime/);
    expect(() => AppleContainerRuntimeEngine.ensureNetwork(runner, 'n', 'w', false)).toThrow(/apple runtime/);
    expect(() => AppleContainerRuntimeEngine.startContainer(runner, 'c')).toThrow(/apple runtime/);
    expect(() => AppleContainerRuntimeEngine.stopContainer(runner, 'c')).toThrow(/apple runtime/);
    expect(() => AppleContainerRuntimeEngine.removeContainer(runner, 'c')).toThrow(/apple runtime/);
    expect(() => AppleContainerRuntimeEngine.copyVolume(runner, 'a', 'b', 'w')).toThrow(/apple runtime/);
    expect(() => AppleContainerRuntimeEngine.buildImage(runner, { contextDir: '/c', tag: 't', buildArgs: {} })).toThrow(/apple runtime/);
    expect(() => AppleContainerRuntimeEngine.copyFromContainer(runner, 'c', '/p', '/h')).toThrow(/apple runtime/);
    expect(() => AppleContainerRuntimeEngine.copyToContainer(runner, 'c', '/h', '/p')).toThrow(/apple runtime/);
  });

  it('reads readiness and exec vectors like docker', () => {
    const { runner } = stateRunner();
    expect(AppleContainerRuntimeEngine.readReadyJson(runner, 'sandbox-w')).toBeNull();
    const ready = fakeRunner({
      'container exec': { status: 0, stdout: '{"generation":"g","fingerprint":"f","started_at":7}', stderr: '' },
    });
    expect(AppleContainerRuntimeEngine.readReadyJson(ready.runner, 'c')).toEqual({ generation: 'g', fingerprint: 'f', startedAt: 7 });
    const spec = AppleContainerRuntimeEngine.execVector('c', { workdir: '/w', argv: ['ls'] });
    expect(spec.command).toBe('container');
    expect(spec.args).toContain('-t');
  });
});

describe('apple volume ownership', () => {
  it('hands the home tree to the agent user before unprivileged startup', async () => {
    const { AppleContainerRuntimeEngine: Apple } = await import('../../src/engines/apple.js');
    const calls: string[][] = [];
    const runner = {
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (args.includes('chown')) return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'volume' && args[1] === 'ls') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'image' && args[1] === 'list') {
          return { status: 0, stdout: JSON.stringify([{ name: 'img:tag' }]), stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    Apple.createContainer(runner, { id: 'w', container: 'sandbox-w', root: '/w' }, {
      image: 'img:tag', workdir: '/work', mounts: ['/w'], homeVolume: 'vol-1',
      network: 'net-1', runtimeName: 'apple', generation: 'g', fingerprint: 'f',
    });
    const bootstrap = calls.find((call) => call.some((part) => part.includes('chown')));
    expect(bootstrap).toBeDefined();
    expect(bootstrap as string[]).toContain('--user');
    expect(bootstrap as string[]).toContain('root');
  });
});

describe('apple resource names', () => {
  it('prefers structural names over label-value shadows', async () => {
    const { AppleContainerRuntimeEngine: Apple } = await import('../../src/engines/apple.js');
    const runner = {
      run: (command: string, args: string[]) => {
        void command;
        void args;
        return {
          status: 0,
          stdout: JSON.stringify([{ configuration: { name: 'sandbox-home-w', labels: { 'sandbox.workspace': 'sandbox-w' } } }]),
          stderr: '',
        };
      },
    };
    expect(Apple.listVolumes(runner)).toEqual(['sandbox-home-w']);
  });
});
