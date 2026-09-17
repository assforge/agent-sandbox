import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
    platform: 'darwin',
    nodeVersion: 'v22.0.0',
    pathLookup: (name) => `/usr/bin/${name}`,
    commandSucceeds: () => true,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...overrides,
  };
}

describe('main', () => {
  it('serves help and version without touching the environment', () => {
    const help = deps();
    expect(main(['--help'], help)).toBe(0);
    expect(help.out.join('')).toContain('sandbox doctor');
    const version = deps();
    expect(main(['--version'], version)).toBe(0);
    expect(version.out.join('')).toMatch(/sandbox \d+\.\d+\.\d+/);
  });

  it('formats usage errors with exit code 2', () => {
    const d = deps();
    expect(main(['frobnicate'], d)).toBe(2);
    expect(d.err.join('')).toMatch(/unknown command/);
  });

  it('runs doctor against the resolved workspace registry', () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-main-'));
    try {
      const d = deps({ homeDir: home, cwd: join(home, 'proj') });
      expect(main(['doctor'], d)).toBe(0);
      expect(d.out.join('')).toContain('[WARN]');
      const registry = emptyRegistry();
      saveRegistry(join(home, '.sandbox', 'registry.json'), registry);
      const d2 = deps({ homeDir: home, cwd: join(home, 'proj') });
      expect(main(['doctor', '--json'], d2)).toBe(0);
      expect(JSON.parse(d2.out.join('')) as unknown).toHaveProperty('checks');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails closed with exit 2 on a corrupt registry', () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-main-'));
    try {
      writeFileSync(join(home, 'registry.json'), '{broken', 'utf8');
      const nested = join(home, '.sandbox');
      mkdirSync(nested, { recursive: true });
      renameSync(join(home, 'registry.json'), join(nested, 'registry.json'));
      const d = deps({ homeDir: home });
      expect(main(['doctor'], d)).toBe(2);
      expect(d.err.join('')).toMatch(/cannot read registry/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('routes resource stubs and agent launch to preview errors', () => {
    expect(main(['workspace', 'list'], deps())).toBe(1);
    expect(main(['workspace', 'help'], deps())).toBe(0);
    expect(main(['agent', 'list'], deps())).toBe(1);
    expect(main(['agent', 'help'], deps())).toBe(0);
    expect(main(['image', 'list'], deps())).toBe(1);
    expect(main(['image', 'help'], deps())).toBe(0);
    expect(main(['claude'], deps())).toBe(1);
    expect(main([], deps())).toBe(1);
    expect(main(['shell'], deps())).toBe(1);
  });
});
