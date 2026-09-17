import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RUNTIME, loadHostConfig, saveHostConfig } from '../../src/hostconfig.js';
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
      expect(loadHostConfig(home)).toEqual({ runtime: DEFAULT_RUNTIME });
      saveHostConfig(home, { runtime: 'apple' });
      expect(loadHostConfig(home)).toEqual({ runtime: 'apple' });
      writeFileSync(join(home, '.sandbox', 'config.json'), '{broken', 'utf8');
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
      const dir = join(home, '.sandbox', 'engines');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'kiro.json'), JSON.stringify([{ name: 'kiro', statePaths: ['.kiro'], launch: ['kiro'], npmPackage: null, pinnedVersion: null }]), 'utf8');
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

describe('apple engine vectors', () => {
  it('builds container-shaped argv from verified flags', () => {
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
    expect(AppleContainerRuntimeEngine.verified).toBe(false);
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
      'container network': { status: 0, stdout: '{"name":"n"}', stderr: '' },
    });
    expect(() => AppleContainerRuntimeEngine.networkInternal(nonet.runner, 'n')).toThrow(/unverified output shape/);
  });
});
