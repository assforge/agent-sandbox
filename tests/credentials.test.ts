import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertInstanceName,
  clearCredentials,
  listCredentialInstances,
  loadCredentials,
  parseEnvFile,
  redactEnv,
  setCredentials,
} from '../src/credentials.js';

describe('parseEnvFile', () => {
  it('parses KEY=VALUE lines and ignores comments and blanks', () => {
    expect(parseEnvFile('# relay one\nANTHROPIC_BASE_URL=https://a.example\nTOKEN=x=y\n\n')).toEqual({
      ANTHROPIC_BASE_URL: 'https://a.example',
      TOKEN: 'x=y',
    });
  });

  it('rejects malformed lines and keys', () => {
    expect(() => parseEnvFile('NOEQUALS')).toThrow(/line 1/);
    expect(() => parseEnvFile('9BAD=x')).toThrow(/line 1/);
    expect(() => assertInstanceName('a:b')).toThrow(/invalid instance name/);
  });
});

describe('credential store', () => {
  it('stores with owner-only permissions and never reveals values', () => {
    const home = mkdtempSync(join(tmpdir(), 'sandbox-cred-'));
    try {
      const keys = setCredentials(home, 'w-abc', 'w1', 'ANTHROPIC_BASE_URL=https://a.example\nANTHROPIC_AUTH_TOKEN=secret-1\n');
      expect(keys).toEqual(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
      const stored = join(home, '.agent.sandbox', 'w-abc', 'instances', 'w1.env');
      expect(statSync(stored).mode & 0o777).toBe(0o600);
      expect(loadCredentials(home, 'w-abc', 'w1')).toEqual({
        ANTHROPIC_BASE_URL: 'https://a.example',
        ANTHROPIC_AUTH_TOKEN: 'secret-1',
      });
      expect(loadCredentials(home, 'w-abc', 'w2')).toBeNull();
      expect(redactEnv(loadCredentials(home, 'w-abc', 'w1') as Record<string, string>)).toEqual({
        ANTHROPIC_BASE_URL: '***',
        ANTHROPIC_AUTH_TOKEN: '***',
      });
      expect(listCredentialInstances(home, 'w-abc')).toEqual(['w1']);
      expect(clearCredentials(home, 'w-abc', 'w1')).toBe(true);
      expect(clearCredentials(home, 'w-abc', 'w1')).toBe(false);
      expect(listCredentialInstances(home, 'w-abc')).toEqual([]);
      expect(listCredentialInstances(home, 'missing')).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
