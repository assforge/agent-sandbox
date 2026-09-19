import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { migrateHomeDir, homeMovePending, sandboxDir, SANDBOX_DIR_NAME } from '../src/paths.js';

describe('sandbox home directory', () => {
  it('groups host state under the .agent.* family', () => {
    expect(SANDBOX_DIR_NAME).toBe('.agent.sandbox');
    expect(sandboxDir('/home/u')).toBe(join('/home/u', '.agent.sandbox'));
  });

  it('moves the legacy directory once', () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-paths-'));
    try {
      mkdirSync(join(home, '.sandbox'));
      writeFileSync(join(home, '.sandbox', 'registry.json'), '{}', 'utf8');
      expect(migrateHomeDir(home)).toBe(true);
      expect(existsSync(join(home, '.agent.sandbox', 'registry.json'))).toBe(true);
      expect(existsSync(join(home, '.sandbox'))).toBe(false);
      expect(migrateHomeDir(home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does nothing without a legacy directory and never merges', () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-paths-'));
    try {
      expect(migrateHomeDir(home)).toBe(false);
      mkdirSync(join(home, '.agent.sandbox'));
      writeFileSync(join(home, '.agent.sandbox', 'config.json'), '{}', 'utf8');
      mkdirSync(join(home, '.sandbox'));
      writeFileSync(join(home, '.sandbox', 'registry.json'), '{}', 'utf8');
      expect(migrateHomeDir(home)).toBe(false);
      expect(existsSync(join(home, '.sandbox', 'registry.json'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports a pending move without performing it', () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-paths-'));
    try {
      // Nothing on disk: nothing pending.
      expect(homeMovePending(home)).toBe(false);
      // Legacy only: pending, and the probe must not move it. doctor calls
      // this on every run and is read-only by contract.
      mkdirSync(join(home, '.sandbox'));
      writeFileSync(join(home, '.sandbox', 'registry.json'), '{}', 'utf8');
      expect(homeMovePending(home)).toBe(true);
      expect(existsSync(join(home, '.sandbox', 'registry.json'))).toBe(true);
      expect(existsSync(join(home, '.agent.sandbox'))).toBe(false);
      // Both present: the move is refused (never merges), so nothing is pending.
      mkdirSync(join(home, '.agent.sandbox'));
      expect(homeMovePending(home)).toBe(false);
      // New only: already moved.
      rmSync(join(home, '.sandbox'), { recursive: true, force: true });
      expect(homeMovePending(home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
