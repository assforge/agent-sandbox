import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { agentDefinition, outdatedAgents } from '../src/agent.js';
import { redactedConfig, rejectForbiddenMount, validateRegistryShape } from '../src/config.js';
import { emptyRegistry, registerWorkspace } from '../src/registry.js';
import { buildCandidate, recordActivation } from '../src/image.js';
import { approveMigration, dryRunMigration } from '../src/migrate.js';
import { checkReadiness, configurationFingerprint, freshGeneration } from '../src/readiness.js';
import { agentHelp, imageHelp, topHelp, workspaceHelp } from '../src/help.js';

describe('agents', () => {
  it('pins exact npm versions and rejects unsupported agents', () => {
    expect(agentDefinition('codex').pinnedVersion).toBe('0.154.0');
    expect(() => agentDefinition('grok')).toThrow(/no verified linux install channel/);
    expect(() => agentDefinition('nope')).toThrow(/unknown agent/);
  });

  it('inspects outdated versions through the runner', () => {
    const entries = outdatedAgents({
      installedVersion: (pkg) => (pkg === 'opencode-ai' ? '1.18.0' : null),
      latestVersion: () => '9.9.9',
    });
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ agent: 'opencode', pinned: '1.18.31' });
  });
});

describe('config', () => {
  it('rejects root and HOME mounts and redacts secrets', () => {
    expect(rejectForbiddenMount('/')).toMatch(/root/);
    expect(rejectForbiddenMount(homedir())).toMatch(/HOME/);
    expect(rejectForbiddenMount(`${homedir()}/work`)).toBeNull();
    const registry = emptyRegistry();
    const entry = registerWorkspace(registry, '/w', ['/w']);
    expect(JSON.stringify(redactedConfig(entry))).not.toMatch(/token|secret|key/i);
    expect(validateRegistryShape({ version: 1, workspaces: {} })).toEqual([]);
    expect(validateRegistryShape({ version: 2 }).length).toBeGreaterThan(0);
  });
});

describe('image lifecycle', () => {
  it('builds a candidate with pinned args and verifies versions', () => {
    const seen: string[] = [];
    const result = buildCandidate(
      {
        buildImage: (plan) => {
          seen.push(plan.tag);
          expect(plan.buildArgs['CODEX_VERSION']).toBe('0.154.0');
          expect(plan.buildArgs['OPENCODE_VERSION']).toBe('1.18.31');
          return plan.tag;
        },
        inspectBinaryVersions: () => ({
          'opencode-ai': '1.18.31',
          '@openai/codex': '0.154.0',
          '@github/copilot': '1.0.85',
        }),
        verifyCandidate: () => true,
      },
      '/ctx',
      'sandbox:candidate',
    );
    expect(result.tag).toBe('sandbox:candidate');
    expect(seen).toEqual(['sandbox:candidate']);
    expect(recordActivation('old', 'new')).toEqual({ previous: 'old', current: 'new' });
  });

  it('fails the candidate on version mismatch or failed verification', () => {
    const runner = {
      buildImage: (plan: { tag: string }) => plan.tag,
      inspectBinaryVersions: () => ({}),
      verifyCandidate: () => true,
    };
    expect(() => buildCandidate(runner, '/ctx', 't')).toThrow(/expected/);
  });
});

describe('migration', () => {
  it('dry-runs without touching legacy resources or secrets', () => {
    const plan = dryRunMigration(
      [
        { kind: 'container', name: 'pedantic_snyder' },
        { kind: 'volume', name: 'claude-relay-config' },
        { kind: 'volume', name: 'unknown-vol' },
      ],
      'microsb-abc123',
    );
    expect(plan.mappings).toHaveLength(2);
    expect(JSON.stringify(plan)).not.toMatch(/token|secret/i);
    expect(approveMigration(plan, false)).toMatch(/dry-run/);
    expect(approveMigration(plan, true)).toMatch(/quiescing/);
  });
});

describe('readiness', () => {
  it('accepts only the current generation and fingerprint', () => {
    const generation = freshGeneration();
    const fingerprint = configurationFingerprint(['a', 'b']);
    const expected = { generation, fingerprint };
    expect(checkReadiness(expected, { generation, fingerprint }, true)).toBe(true);
    expect(checkReadiness(expected, { generation: 'old', fingerprint }, true)).toBe(false);
    expect(checkReadiness(expected, null, true)).toBe(false);
    expect(checkReadiness(expected, { generation, fingerprint }, false)).toBe(false);
  });
});

describe('help', () => {
  it('is English and free of arrow glyphs', () => {
    for (const text of [topHelp(), agentHelp(), workspaceHelp(), imageHelp()]) {
      expect(text).not.toMatch(/→/);
      expect(text).toMatch(/sandbox/);
    }
  });
});
