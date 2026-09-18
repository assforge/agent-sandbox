import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { main, type MainDeps } from '../src/bin/sandbox.js';
import { emptyRegistry, saveRegistry } from '../src/registry.js';

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
    expect(help.out.join('')).toContain('sandbox doctor');
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
      saveRegistry(join(home, '.sandbox', 'registry.json'), registry);
      const d2 = deps({ homeDir: home, cwd: join(home, 'proj') });
      expect(await main(['doctor', '--json'], d2)).toBe(0);
      expect(JSON.parse(d2.out.join('')) as unknown).toHaveProperty('checks');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails closed with exit 2 on a corrupt registry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-main-'));
    try {
      writeFileSync(join(home, 'registry.json'), '{broken', 'utf8');
      const nested = join(home, '.sandbox');
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
