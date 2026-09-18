import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('changesets release wiring', () => {
  it('matches the restricted GitHub Packages sibling config', () => {
    const config = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8')) as {
      access: string;
      baseBranch: string;
      commit: boolean;
    };
    expect(config.access).toBe('restricted');
    expect(config.baseBranch).toBe('main');
    expect(config.commit).toBe(false);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      publishConfig: { access: string; registry: string };
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts.changeset).toBe('changeset');
    expect(pkg.scripts.version).toBe('changeset version');
    expect(pkg.scripts.release).toBe('changeset publish');
    expect(pkg.publishConfig.access).toBe('restricted');
    expect(pkg.publishConfig.registry).toBe('https://npm.pkg.github.com');
    expect(pkg.devDependencies['@changesets/cli']).toMatch(/^\^2\./);
  });
});
