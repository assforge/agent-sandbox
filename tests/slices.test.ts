import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { agentEngine, agentEngines, BUILTIN_CATALOG, loadAgentCatalog, outdatedEngines } from '../src/engines/agent.js';
import { SUPPORTED_AGENTS } from '../src/cli.js';
import { FORK_STATE_DIRS } from '../src/lifecycle.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { normalizeLexical, redactedConfig, rejectForbiddenMount } from '../src/config.js';
import { sameImageId } from '../src/docker.js';
import { emptyRegistry, registerWorkspace } from '../src/registry.js';
import { activateImage, buildCandidate, compareVersions, engineProbeKeys, formatVersionReceipt, parseInspectedVersions, recordActivation, rollbackImage, versionAtLeast } from '../src/image.js';
import { acquireLock } from '../src/lock.js';
import { assertWindowName } from '../src/terminal.js';
import { dryRunMigration } from '../src/migrate.js';
import { checkReadiness, configurationFingerprint, freshGeneration } from '../src/readiness.js';
import { agentHelp, describeAction, imageHelp, topHelp, workspaceHelp } from '../src/help.js';

describe('agents', () => {
  const engines = agentEngines();

  it('floors npm versions and resolves the native engines', () => {
    expect(agentEngine(engines, 'codex').installSpec()).toMatchObject({ npmPackage: '@openai/codex', minimumVersion: '0.155.1' });
    expect(agentEngine(engines, 'pi').installSpec()).toMatchObject({ npmPackage: '@earendil-works/pi-coding-agent', minimumVersion: '0.85.1' });
    expect(agentEngine(engines, 'pi').launch).toEqual(['pi']);
    expect(agentEngine(engines, 'grok').installSpec()).toMatchObject({ npmPackage: null, minimumVersion: '1.0.34' });
    expect(agentEngine(engines, 'grok').launch).toEqual(['grok']);
    expect(agentEngine(engines, 'agy').installSpec()).toMatchObject({ npmPackage: null, minimumVersion: '1.2.7' });
    expect(agentEngine(engines, 'qwen').installSpec()).toMatchObject({ npmPackage: '@qwen-code/qwen-code', minimumVersion: '0.24.1' });
    expect(agentEngine(engines, 'kimi').installSpec()).toMatchObject({ npmPackage: '@moonshot-ai/kimi-code', minimumVersion: '2.0.2' });
    expect(agentEngine(engines, 'mimo').installSpec()).toMatchObject({ npmPackage: '@mimo-ai/cli', minimumVersion: '0.1.14' });
    expect(agentEngine(engines, 'auggie').installSpec()).toMatchObject({ npmPackage: '@augmentcode/auggie', minimumVersion: '0.36.0' });
    expect(agentEngine(engines, 'cursor').installSpec()).toMatchObject({ npmPackage: null, minimumVersion: '2026.09.10' });
    expect(agentEngine(engines, 'cursor').launch).toEqual(['cursor-agent', '--disable-auto-update']);
    expect(agentEngine(engines, 'devin').installSpec()).toMatchObject({ npmPackage: null, minimumVersion: '3000.10.31' });
    expect(agentEngine(engines, 'kiro').installSpec()).toMatchObject({ npmPackage: null, minimumVersion: '2.22.1' });
    expect(agentEngine(engines, 'aider').installSpec()).toMatchObject({ npmPackage: null, minimumVersion: '0.86.2' });
    expect(agentEngine(engines, 'aider').launch).toEqual(['aider']);
    expect(agentEngine(engines, 'goose').installSpec()).toMatchObject({ npmPackage: null, minimumVersion: '1.51.0' });
    expect(agentEngine(engines, 'goose').launch).toEqual(['goose']);
    expect(agentEngine(engines, 'kiro').launch).toEqual(['kiro-cli']);
    expect(agentEngine(engines, 'qwen').launch).toEqual(['qwen']);
    expect(agentEngine(engines, 'agy').launch).toEqual(['agy']);
    expect(() => agentEngine(engines, 'nope')).toThrow(/unknown agent/);
  });

  it('inspects outdated versions through the runner', () => {
    const entries = outdatedEngines({
      installedVersion: (pkg) => (pkg === 'opencode-ai' ? '1.18.0' : null),
      latestVersion: () => '9.9.9',
      fetchText: () => '9.9.9',
    }, engines.values());
    expect(entries).toHaveLength(16);
    expect(entries[0]).toMatchObject({ agent: 'claude', npmPackage: null, installed: null, minimum: '2.1.276', latest: '9.9.9' });
    expect(entries[1]).toMatchObject({ agent: 'opencode', minimum: '1.18.31' });
    expect(entries[4]).toMatchObject({ agent: 'pi', npmPackage: '@earendil-works/pi-coding-agent', minimum: '0.85.1' });
    expect(entries[5]).toMatchObject({ agent: 'grok', npmPackage: null, minimum: '1.0.34', latest: '9.9.9' });
    expect(entries[6]).toMatchObject({ agent: 'agy', npmPackage: null, installed: null, minimum: '1.2.7', latest: null });
    expect(entries[7]).toMatchObject({ agent: 'qwen', npmPackage: '@qwen-code/qwen-code', minimum: '0.24.1' });
    expect(entries[8]).toMatchObject({ agent: 'kimi', npmPackage: '@moonshot-ai/kimi-code', minimum: '2.0.2' });
    expect(entries[9]).toMatchObject({ agent: 'mimo', npmPackage: '@mimo-ai/cli', minimum: '0.1.14' });
    expect(entries[10]).toMatchObject({ agent: 'auggie', npmPackage: '@augmentcode/auggie', minimum: '0.36.0' });
    expect(entries[11]).toMatchObject({ agent: 'cursor', npmPackage: null, minimum: '2026.09.10', latest: null });
    expect(entries[12]).toMatchObject({ agent: 'devin', npmPackage: null, minimum: '3000.10.31', latest: null });
    expect(entries[13]).toMatchObject({ agent: 'kiro', npmPackage: null, minimum: '2.22.1', latest: null });
    expect(entries[14]).toMatchObject({ agent: 'aider', npmPackage: null, minimum: '0.86.2', latest: null });
    expect(entries[15]).toMatchObject({ agent: 'goose', npmPackage: null, minimum: '1.51.0', latest: null });
    const nullLatest = outdatedEngines({ installedVersion: () => null, latestVersion: () => null, fetchText: () => null }, engines.values());
    expect(nullLatest.every((entry) => entry.latest === null)).toBe(true);
    // A feed that gains a suffix still resolves to the leading version.
    const suffixed = outdatedEngines(
      { installedVersion: () => null, latestVersion: () => null, fetchText: () => '1.0.34 (stable)\n' },
      engines.values(),
    );
    expect(suffixed.find((entry) => entry.agent === 'grok')?.latest).toBe('1.0.34');
  });

  it('adds another agent through data alone', () => {
    const extended = agentEngines([{ name: 'nova', statePaths: ['.nova'], launch: ['nova'], npmPackage: null, minimumVersion: '9.9.9', latestEndpoint: null }]);
    expect(agentEngine(extended, 'nova').launch).toEqual(['nova']);
    expect(agentEngine(extended, 'codex').installSpec().minimumVersion).toBe('0.155.1');
  });

  it('keeps catalog names, shortcuts, and fork seeds in agreement', () => {
    for (const entry of BUILTIN_CATALOG) {
      expect(SUPPORTED_AGENTS as readonly string[]).toContain(entry.name);
      expect(agentEngine(engines, entry.name).launch).toEqual(entry.launch);
      for (const state of entry.statePaths) {
        const covered = FORK_STATE_DIRS.some((dir) => state === dir || state.startsWith(`${dir}/`));
        expect(covered, `${entry.name}: ${state}`).toBe(true);
      }
    }
  });

  it('accepts grok and agy in user catalogs and still rejects unknown names', () => {
    const grok = { name: 'grok', statePaths: ['.grok'], launch: ['grok'], npmPackage: null, minimumVersion: '1.0.0', latestEndpoint: null };
    // Formerly unsupported names now load like any other engine.
    expect(loadAgentCatalog([grok])).toHaveLength(1);
    expect(loadAgentCatalog([{ ...grok, name: 'agy' }])).toHaveLength(1);
    // A supported extra agent is still accepted.
    expect(loadAgentCatalog([{ ...grok, name: 'nova' }])).toHaveLength(1);
    // Unknown names still fail closed at lookup.
    expect(() => agentEngine(engines, 'nope')).toThrow(/unknown agent/);
  });
});

describe('sameImageId', () => {
  it('matches full digests against short ids without recreating every run', () => {
    expect(sameImageId('sha256:b0739da01b28bc99524e1c451ec33e0f8d4bdbb06d37e41766aed4ffc06bdb99', 'b0739da01b28')).toBe(true);
    expect(sameImageId('sha256:abc', 'sha256:abc')).toBe(true);
    expect(sameImageId('sha256:abc', 'sha256:def')).toBe(false);
    expect(sameImageId(null, 'abc')).toBe(false);
    expect(sameImageId('abc', null)).toBe(false);
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
  });

  it('normalizes lexical spellings before policy checks', () => {
    expect(normalizeLexical('/Users/a/../')).toBe('/Users');
    expect(normalizeLexical('//Users//a/./work')).toBe('/Users/a/work');
    expect(normalizeLexical('/')).toBe('/');
    expect(rejectForbiddenMount('/./')).toMatch(/root/);
    expect(rejectForbiddenMount(`${homedir()}/sub/..`)).toMatch(/HOME/);
  });

  it('rejects every ancestor of HOME and of the sandbox state directory', () => {
    // Binding an ancestor hands over HOME without ever naming it: `/Users` and
    // `/home` expose SSH keys, the registry and every other dotfile.
    expect(rejectForbiddenMount('/Users', '/Users/x')).toMatch(/HOME/);
    expect(rejectForbiddenMount('/Users/', '/Users/x')).toMatch(/HOME/);
    expect(rejectForbiddenMount('/home', '/home/x')).toMatch(/HOME/);
    // The registry lives under HOME, so naming it directly must fail too.
    expect(rejectForbiddenMount('/Users/x/.agent.sandbox', '/Users/x')).toMatch(/sandbox state/);
    // Paths containing neither are still mountable, including a child of HOME.
    expect(rejectForbiddenMount('/opt/data', '/Users/x')).toBeNull();
    expect(rejectForbiddenMount('/Users/x/work', '/Users/x')).toBeNull();
    // But a child of the state directory is a registry or credential file
    // by another name: mounting it would do directly what the ancestor
    // rule exists to prevent.
    expect(rejectForbiddenMount('/Users/x/.agent.sandbox/registry.json', '/Users/x')).toMatch(/sandbox state/);
    expect(rejectForbiddenMount('/Users/x/.agent.sandbox/w/instances/a.env', '/Users/x')).toMatch(/inside/);
  });

  it('redacts instance lists without dropping entries', () => {
    const registry = emptyRegistry();
    const entry = registerWorkspace(registry, '/w', []);
    entry.instances.push({ name: 'rollout', kind: 'claude', window: 'rollout' });
    const redacted = redactedConfig(entry) as { instances: unknown[] };
    expect(redacted.instances).toHaveLength(1);
  });
});

describe('image lifecycle', () => {
  it('builds a candidate with latest-first args and verifies floors', () => {
    const seen: Array<Record<string, string>> = [];
    const inspect = {
      claude: '2.1.278',
      'opencode-ai': '1.18.31',
      '@openai/codex': '9.9.9',
      '@github/copilot': '1.0.86',
      '@earendil-works/pi-coding-agent': '0.85.1',
      grok: '9.9.9',
      agy: '1.2.7',
      '@qwen-code/qwen-code': '0.24.1',
      '@moonshot-ai/kimi-code': '2.0.2',
      '@mimo-ai/cli': '0.1.14',
      '@augmentcode/auggie': '0.36.0',
      cursor: '2026.09.18',
      devin: '3000.10.31',
      kiro: '2.22.1',
      aider: '0.86.2',
      goose: '1.51.0',
    };
    const result = buildCandidate(
      {
        buildImage: (plan: { tag: string; buildArgs: Record<string, string> }) => {
          seen.push(plan.buildArgs);
          // Latest-first: no version args unless the caller overrides one.
          expect(plan.buildArgs).toEqual({});
          return plan.tag;
        },
        inspectBinaryVersions: () => inspect,
        verifyCandidate: () => true,
      },
      '/ctx',
      'sandbox:candidate',
      agentEngines().values(),
    );
    expect(result.tag).toBe('sandbox:candidate');
    // Newer-than-floor versions pass and come back as the build receipt.
    expect(result.versions).toMatchObject(inspect);
    const overridden = buildCandidate(
      {
        buildImage: (plan: { tag: string; buildArgs: Record<string, string> }) => plan.tag,
        inspectBinaryVersions: () => inspect,
        verifyCandidate: () => true,
      },
      '/ctx',
      'sandbox:override',
      agentEngines().values(),
      { '@openai/codex': '0.155.1' },
    );
    expect(overridden.tag).toBe('sandbox:override');
  });

  it('passes overrides through as build args', () => {
    const seen: Array<Record<string, string>> = [];
    buildCandidate(
      {
        buildImage: (plan: { tag: string; buildArgs: Record<string, string> }) => {
          seen.push(plan.buildArgs);
          return plan.tag;
        },
        inspectBinaryVersions: () => ({
          claude: '2.1.276',
          'opencode-ai': '1.18.31',
          '@openai/codex': '0.155.1',
          '@github/copilot': '1.0.86',
          '@earendil-works/pi-coding-agent': '0.85.1',
          grok: '1.0.34',
          agy: '1.2.7',
          '@qwen-code/qwen-code': '0.24.1',
          '@moonshot-ai/kimi-code': '2.0.2',
          '@mimo-ai/cli': '0.1.14',
          '@augmentcode/auggie': '0.36.0',
          cursor: '2026.09.18',
          devin: '3000.10.31',
          kiro: '2.22.1',
          aider: '0.86.2',
          goose: '1.51.0',
        }),
        verifyCandidate: () => true,
      },
      '/ctx',
      'sandbox:candidate',
      agentEngines().values(),
      { '@openai/codex': '0.155.1', claude: '2.1.276' },
    );
    expect(seen[0]).toMatchObject({ CODEX_VERSION: '0.155.1', CLAUDE_VERSION: '2.1.276' });
  });

  it('fails the candidate on a missing version, a floor breach, or failed verification', () => {
    const runner = {
      buildImage: (plan: { tag: string }) => plan.tag,
      inspectBinaryVersions: () => ({}),
      verifyCandidate: () => true,
    };
    expect(() => buildCandidate(runner, '/ctx', 't', agentEngines().values())).toThrow(/no version/);
    expect(() =>
      buildCandidate({ ...runner, inspectBinaryVersions: () => ({ claude: '2.1.276', 'opencode-ai': '0.0.0' }) }, '/ctx', 't', agentEngines().values()),
    ).toThrow(/below minimum/);
  });

  it('fails the candidate when independent verification rejects it', () => {
    expect(() =>
      buildCandidate(
        {
          buildImage: (plan: { tag: string }) => plan.tag,
          inspectBinaryVersions: () => ({
            claude: '2.1.276',
            'opencode-ai': '1.18.31',
            '@openai/codex': '0.155.1',
            '@github/copilot': '1.0.86',
            '@earendil-works/pi-coding-agent': '0.85.1',
            grok: '1.0.34',
            agy: '1.2.7',
            '@qwen-code/qwen-code': '0.24.1',
            '@moonshot-ai/kimi-code': '2.0.2',
            '@mimo-ai/cli': '0.1.14',
            '@augmentcode/auggie': '0.36.0',
            cursor: '2026.09.18',
            devin: '3000.10.31',
            kiro: '2.22.1',
            aider: '0.86.2',
            goose: '1.51.0',
          }),
          verifyCandidate: () => false,
        },
        '/ctx',
        't',
        agentEngines().values(),
      ),
    ).toThrow(/failed verification/);
  });

  it('parses the sixteen-engine keyed probe', () => {
    const versions = parseInspectedVersions(
      'claude=2.1.276 (Claude Code)\nopencode-ai=1.18.31\n@openai/codex=codex-cli 0.155.1\n@github/copilot=GitHub Copilot CLI 1.0.86.\n@earendil-works/pi-coding-agent=0.85.1\n0.85.1-unkeyed-stray\ngrok=grok 1.0.34 (3736acbc8658) [stable]\nagy=1.2.7\n@qwen-code/qwen-code=0.24.1\n@moonshot-ai/kimi-code=2.0.2\n@mimo-ai/cli=0.1.14\n@augmentcode/auggie=0.36.0 (commit 7c61e5bb)\ncursor=2026.09.18-9a7762b\ndevin=devin 3000.10.31 (b98cc431)\nkiro=kiro-cli 2.22.1\naider=0.86.2\ngoose=1.51.0\nRun \'copilot update\' to check for updates.\n',
      engineProbeKeys(agentEngines().values()),
    );
    expect(versions).toMatchObject({
      claude: '2.1.276',
      'opencode-ai': '1.18.31',
      '@openai/codex': '0.155.1',
      '@github/copilot': '1.0.86',
      '@earendil-works/pi-coding-agent': '0.85.1',
      grok: '1.0.34',
      agy: '1.2.7',
      '@qwen-code/qwen-code': '0.24.1',
      '@moonshot-ai/kimi-code': '2.0.2',
      '@mimo-ai/cli': '0.1.14',
      '@augmentcode/auggie': '0.36.0',
      cursor: '2026.09.18',
      devin: '3000.10.31',
      kiro: '2.22.1',
      aider: '0.86.2',
      goose: '1.51.0',
    });
    expect(versions).not.toHaveProperty('0.85.1-unkeyed-stray');
  });

  it('tolerates missing and unknown keys without misattribution', () => {
    // No kiro line and an unknown key: the rest still parse to themselves.
    const versions = parseInspectedVersions(
      'claude=2.1.276\n@openai/codex=codex-cli 0.155.1\nfrobnicate=nope\n',
      engineProbeKeys(agentEngines().values()),
    );
    expect(versions).toMatchObject({ claude: '2.1.276', '@openai/codex': '0.155.1' });
    expect(versions).not.toHaveProperty('kiro');
    expect(versions).not.toHaveProperty('frobnicate');
    // A duplicated allowed key keeps the first report.
    const duped = parseInspectedVersions(
      'claude=2.1.276\nclaude=9.9.9\n',
      engineProbeKeys(agentEngines().values()),
    );
    expect(duped['claude']).toBe('2.1.276');
  });

  it('strips an optional cursor-agent prefix before the calver', () => {
    const versions = parseInspectedVersions(
      'cursor=cursor-agent 2026.09.18-9a7762b\n',
      engineProbeKeys(agentEngines().values()),
    );
    expect(versions['cursor']).toBe('2026.09.18');
  });

  it('strips the aider prefix before the version', () => {
    const versions = parseInspectedVersions(
      'aider=aider 0.86.2\n',
      engineProbeKeys(agentEngines().values()),
    );
    expect(versions['aider']).toBe('0.86.2');
  });

  it('sends no version args by default and floors the native claude agent', () => {
    const seenArgs: Record<string, string>[] = [];
    buildCandidate(
      {
        buildImage: (plan: { tag: string; buildArgs: Record<string, string> }) => {
          seenArgs.push(plan.buildArgs);
          return plan.tag;
        },
        inspectBinaryVersions: () => ({
          claude: '9.9.9',
          'opencode-ai': '1.18.31',
          '@openai/codex': '0.155.1',
          '@github/copilot': '1.0.86',
          '@earendil-works/pi-coding-agent': '0.85.1',
          grok: '1.0.34',
          agy: '1.2.7',
          '@qwen-code/qwen-code': '0.24.1',
          '@moonshot-ai/kimi-code': '2.0.2',
          '@mimo-ai/cli': '0.1.14',
          '@augmentcode/auggie': '0.36.0',
          cursor: '2026.09.18',
          devin: '3000.10.31',
          kiro: '2.22.1',
          aider: '0.86.2',
          goose: '1.51.0',
        }),
        verifyCandidate: () => true,
      },
      '/ctx',
      't',
      agentEngines().values(),
    );
    expect(seenArgs[0]).toEqual({});
  });

  it('compares versions numerically and fails closed on garbage', () => {
    expect(compareVersions('1.18.31', '1.18.31')).toBe(0);
    expect(compareVersions('0.155.1', '0.154.0')).toBe(1);
    expect(compareVersions('1.0.86', '1.0.9')).toBe(1);
    expect(compareVersions('0x10.0.0', '16.0.0')).toBeNull();
    expect(versionAtLeast('0x10.0.0', '1.0.0')).toBe(false);
    expect(compareVersions('2.1.276', '2.1.278')).toBe(-1);
    expect(compareVersions('1.0', '1.0.0')).toBeNull();
    expect(compareVersions('latest', '1.0.0')).toBeNull();
    expect(versionAtLeast('0.155.1', '0.155.1')).toBe(true);
    expect(versionAtLeast('9.9.9', '0.155.1')).toBe(true);
    expect(versionAtLeast('0.154.0', '0.155.1')).toBe(false);
    expect(versionAtLeast('???', '0.155.1')).toBe(false);
    expect(formatVersionReceipt({ a: '1.0.0', b: '2.0.0' })).toBe('a@1.0.0, b@2.0.0');
  });

  it('activates explicitly and rolls back without reversing data', () => {
    const registry = emptyRegistry();
    const entry = registerWorkspace(registry, '/w', []);
    expect(recordActivation('old', 'new')).toEqual({ previous: 'old', current: 'new' });
    expect(() => rollbackImage(entry)).toThrow(/no previous image/);
    expect(activateImage(entry, 'sha256:new')).toEqual({ previous: null, current: 'sha256:new' });
    expect(entry.image).toBe('sha256:new');
    expect(entry.agentVersions).toBeUndefined();
    expect(activateImage(entry, 'sha256:newer', { claude: '2.1.278' })).toEqual({ previous: 'sha256:new', current: 'sha256:newer' });
    expect(entry.agentVersions).toEqual({ claude: '2.1.278' });
    // A cutover the probe could not refresh clears the stale recording
    // instead of pointing at another image's versions.
    expect(activateImage(entry, 'sha256:newest')).toEqual({ previous: 'sha256:newer', current: 'sha256:newest' });
    expect(entry.agentVersions).toBeUndefined();
    expect(rollbackImage(entry, { claude: '2.1.277' })).toEqual({ previous: 'sha256:newest', current: 'sha256:newer' });
    expect(entry.agentVersions).toEqual({ claude: '2.1.277' });
    expect(rollbackImage(entry)).toEqual({ previous: 'sha256:newer', current: 'sha256:newest' });
    expect(entry.agentVersions).toBeUndefined();
    expect(entry.image).toBe('sha256:newest');
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
  });

  it('maps empty inventories and non-state volumes', () => {
    const empty = dryRunMigration([], 'w-abc');
    expect(empty).toEqual({ source: 'claude-relay', mappings: [] });
    const mixed = dryRunMigration(
      [
        { kind: 'volume', name: 'claude-relay-m2' },
        { kind: 'session', name: 'old-session' },
      ],
      'w-abc',
    );
    expect(mixed.mappings).toHaveLength(1);
    expect(mixed.mappings[0]?.copiesState).toBe(false);
  });
});

describe('readiness', () => {
  it('accepts only the current generation and fingerprint', () => {
    const generation = freshGeneration();
    const fingerprint = configurationFingerprint(['a', 'b']);
    const expected = { generation, fingerprint };
    expect(checkReadiness(expected, { generation, fingerprint }, true)).toBe(true);
    expect(checkReadiness(expected, { generation: 'old', fingerprint }, true)).toBe(false);
    expect(checkReadiness(expected, { generation, fingerprint: 'stale' }, true)).toBe(false);
    expect(checkReadiness(expected, null, true)).toBe(false);
    expect(checkReadiness(expected, { generation, fingerprint }, false)).toBe(false);
  });
});

describe('locks and backups', () => {
  it('serializes holders and releases idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-lock-'));
    try {
      const first = acquireLock(dir, 'w-abc', 1000);
      expect(() => acquireLock(dir, 'w-abc', 150)).toThrow(/timed out/);
      first.release();
      first.release();
      const second = acquireLock(dir, 'w-abc', 1000);
      second.release();
      expect(readdirSync(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reclaims a lock left by a dead holder', () => {    const dir = mkdtempSync(join(tmpdir(), 'sandbox-lock-'));
    try {
      writeFileSync(join(dir, 'w-abc.lock'), '999999999\n', 'utf8');
      const handle = acquireLock(dir, 'w-abc', 2000);
      handle.release();
      expect(readdirSync(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses traversing or relative lock directories', () => {
    expect(() => acquireLock('/tmp/safe/../../evil', 'w', 100)).toThrow(/refused lock directory/);
    expect(() => acquireLock('relative/dir', 'w', 100)).toThrow(/refused lock directory/);
    expect(() => acquireLock('/tmp/safe', '../evil', 100)).toThrow(/refused lock identity/);
    expect(() => acquireLock('/tmp/safe', '', 100)).toThrow(/refused lock identity/);
  });

  it('validates window names against tmux target syntax', () => {
    expect(() => assertWindowName('rollout')).not.toThrow();
    expect(() => assertWindowName('sdk.stg-2')).not.toThrow();
    expect(() => assertWindowName('a:b')).toThrow(/invalid instance name/);
    expect(() => assertWindowName('')).toThrow(/invalid instance name/);
    expect(() => assertWindowName('-lead')).toThrow(/invalid instance name/);
  });

  it('backs up and restores through the runner, recreating lost entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-backup-'));
    try {
      const calls: string[] = [];
      const runner = {
        copyFromContainer: (container: string, from: string, to: string) => {
          calls.push(`from:${container}:${from}:${to}`);
        },
        copyToContainer: (container: string, from: string, to: string) => {
          calls.push(`to:${container}:${from}:${to}`);
        },
      };
      const registry = emptyRegistry();
      const entry = registerWorkspace(registry, '/w', []);
      entry.image = 'sha256:one';
      entry.instances.push({ name: 'w1', kind: 'codex', window: 'w1', homeMode: 'fork' });
      entry.forks.push('w1');
      const out = join(dir, 'backup');
      const receipt = backupWorkspace(runner, entry, out);
      expect(receipt).toMatchObject({ workspace: entry.id, copiedState: true });
      expect(existsSync(join(out, 'workspace.json'))).toBe(true);
      delete registry.workspaces[entry.id];
      const restored = restoreWorkspace(runner, registry, out, dir);
      expect(restored.id).toBe(entry.id);
      expect(restored.image).toBe('sha256:one');
      expect(restored.root).toBe('/w');
      expect(restored.instances).toEqual([{ name: 'w1', kind: 'codex', window: 'w1', homeMode: 'fork' }]);
      expect(restored.forks).toEqual(['w1']);
      expect(registry.workspaces[entry.id]).toBe(restored);
      expect(calls).toHaveLength(2);
      // The trailing `/.` is load-bearing, not cosmetic: without it the
      // runtime nests the source directory inside the destination and a
      // restore reproduces `/home/agent/home/agent/...`.
      expect(calls[0]).toBe(`from:${entry.container}:/home/agent/.:${join(out, 'home')}`);
      expect(calls[1]).toBe(`to:${entry.container}:${join(out, 'home')}/.:/home/agent`);
      expect(() => restoreWorkspace(runner, emptyRegistry(), join(dir, 'missing'), dir)).toThrow(/missing or invalid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects tampered backups with unsafe names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-backup-'));
    try {
      const out = join(dir, 'evil');
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, 'workspace.json'),
        JSON.stringify({ id: '../evil', root: '/w', container: 'c', session: 's', homeVolume: 'v', mounts: ['/w'] }),
        'utf8',
      );
      expect(() => restoreWorkspace({ copyFromContainer: () => {}, copyToContainer: () => {} }, emptyRegistry(), out, dir)).toThrow(/unsafe id/);
      // A fork name later reaches fork pruning, so the restore boundary
      // enforces the shared safe-name charset there as well.
      const sneaky = join(dir, 'sneaky');
      mkdirSync(sneaky, { recursive: true });
      writeFileSync(
        join(sneaky, 'workspace.json'),
        JSON.stringify({ id: 'w', root: '/w', container: 'c', session: 's', homeVolume: 'v', mounts: ['/w'], forks: ['../evil'] }),
        'utf8',
      );
      expect(() => restoreWorkspace({ copyFromContainer: () => {}, copyToContainer: () => {} }, emptyRegistry(), sneaky, dir)).toThrow(/unsafe forks/);
      // An instance name reaches homes and credential files, so the
      // restore boundary enforces the charset there too: otherwise the
      // entry would save fine and brick on the next load, claim set.
      const traversal = join(dir, 'traversal');
      mkdirSync(traversal, { recursive: true });
      writeFileSync(
        join(traversal, 'workspace.json'),
        JSON.stringify({ id: 'w', root: '/w', container: 'c', session: 's', homeVolume: 'v', mounts: [], forks: [], instances: [{ name: '../evil', kind: 'k', window: 'w' }] }),
        'utf8',
      );
      expect(() => restoreWorkspace({ copyFromContainer: () => {}, copyToContainer: () => {} }, emptyRegistry(), traversal, dir)).toThrow(/unsafe instance name/);
      for (const [field, value] of [['kind', 'k k'], ['window', 's:w']] as const) {
        const odd = join(dir, `odd-${field}`);
        mkdirSync(odd, { recursive: true });
        writeFileSync(
          join(odd, 'workspace.json'),
          JSON.stringify({ id: 'w', root: '/w', container: 'c', session: 's', homeVolume: 'v', mounts: [], forks: [], instances: [{ name: 'w', kind: 'k', window: 'w', [field]: value }] }),
          'utf8',
        );
        expect(() => restoreWorkspace({ copyFromContainer: () => {}, copyToContainer: () => {} }, emptyRegistry(), odd, dir), field).toThrow(/unsafe instance/);
      }
      // Versions ride along when clean, so a restore keeps its drift
      // baseline; garbage fails like the load boundary, and a bad
      // network is refused instead of coerced to open.
      const versioned = join(dir, 'versioned');
      mkdirSync(versioned, { recursive: true });
      writeFileSync(
        join(versioned, 'workspace.json'),
        JSON.stringify({ id: 'w', root: '/w', container: 'c', session: 's', homeVolume: 'v', mounts: [], forks: [], agentVersions: { claude: '2.1.276' } }),
        'utf8',
      );
      const restored = restoreWorkspace({ copyFromContainer: () => {}, copyToContainer: () => {} }, emptyRegistry(), versioned, dir);
      expect(restored.agentVersions).toEqual({ claude: '2.1.276' });
      const badVersions = join(dir, 'badversions');
      mkdirSync(badVersions, { recursive: true });
      writeFileSync(
        join(badVersions, 'workspace.json'),
        JSON.stringify({ id: 'w', root: '/w', container: 'c', session: 's', homeVolume: 'v', mounts: [], forks: [], agentVersions: { claude: 42 } }),
        'utf8',
      );
      expect(() => restoreWorkspace({ copyFromContainer: () => {}, copyToContainer: () => {} }, emptyRegistry(), badVersions, dir)).toThrow(/invalid agentVersions/);
      const badNetwork = join(dir, 'badnetwork');
      mkdirSync(badNetwork, { recursive: true });
      writeFileSync(
        join(badNetwork, 'workspace.json'),
        JSON.stringify({ id: 'w', root: '/w', container: 'c', session: 's', homeVolume: 'v', mounts: [], forks: [], network: 'wide' }),
        'utf8',
      );
      expect(() => restoreWorkspace({ copyFromContainer: () => {}, copyToContainer: () => {} }, emptyRegistry(), badNetwork, dir)).toThrow(/invalid network/);
      // A hand-edited manifest must not smuggle in a mount that
      // registration would refuse; the failure lands before any claim.
      // homeDir is passed canonical, as production passes os.homedir().
      const home = realpathSync(dir);
      const exposed = join(dir, 'exposed');
      mkdirSync(exposed, { recursive: true });
      writeFileSync(
        join(exposed, 'workspace.json'),
        JSON.stringify({ id: 'w', root: '/w', container: 'c', session: 's', homeVolume: 'v', mounts: [home], forks: [] }),
        'utf8',
      );
      expect(() => restoreWorkspace({ copyFromContainer: () => {}, copyToContainer: () => {} }, emptyRegistry(), exposed, home)).toThrow(/refused path/);
      // Same guard for a rewritten root: pointing it at the state
      // directory would bind host state on the next start.
      const rooted = join(dir, 'rooted');
      mkdirSync(rooted, { recursive: true });
      writeFileSync(
        join(rooted, 'workspace.json'),
        JSON.stringify({ id: 'w', root: join(home, '.agent.sandbox', 'stolen'), container: 'c', session: 's', homeVolume: 'v', mounts: [], forks: [] }),
        'utf8',
      );
      expect(() => restoreWorkspace({ copyFromContainer: () => {}, copyToContainer: () => {} }, emptyRegistry(), rooted, home)).toThrow(/refused root/);
      // Symlinked-home parity with registration: a missing path spelled
      // through the link must get the same verdict `vettedMount` gives.
      const link = join(dir, 'link-home');
      symlinkSync(home, link);
      const ghost = join(dir, 'ghost');
      mkdirSync(ghost, { recursive: true });
      writeFileSync(
        join(ghost, 'workspace.json'),
        JSON.stringify({ id: 'w', root: '/w', container: 'c', session: 's', homeVolume: 'v', mounts: [join(link, '.agent.sandbox', 'ghost')], forks: [] }),
        'utf8',
      );
      expect(() => restoreWorkspace({ copyFromContainer: () => {}, copyToContainer: () => {} }, emptyRegistry(), ghost, link)).toThrow(/refused path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores the vetted canonical root and mounts on restore', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-restore-'));
    try {
      const home = realpathSync(dir);
      const target = join(dir, 'target');
      mkdirSync(target, { recursive: true });
      // A symlink root pointing at an allowed directory restores, but the
      // entry keeps the realpath: a link swapped between restore and start
      // must not redirect the next bind.
      const linkRoot = join(dir, 'linkroot');
      symlinkSync(target, linkRoot);
      const input = join(dir, 'input');
      mkdirSync(input, { recursive: true });
      writeFileSync(
        join(input, 'workspace.json'),
        JSON.stringify({ id: 'w', root: linkRoot, container: 'c', session: 's', homeVolume: 'v', mounts: [linkRoot], forks: [] }),
        'utf8',
      );
      const entry = restoreWorkspace({ copyFromContainer: () => {}, copyToContainer: () => {} }, emptyRegistry(), input, home);
      expect(entry.root).toBe(realpathSync(target));
      expect(entry.mounts).toEqual([realpathSync(target)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('help', () => {
  it('is English and free of arrow glyphs', () => {
    for (const text of [topHelp(), agentHelp(), workspaceHelp(), imageHelp()]) {
      expect(text).not.toMatch(/→/);
      expect(text).toMatch(/sandbox/);
    }
  });

  it('documents every top-level command and resource action', () => {
    const top = topHelp();
    for (const token of [
      'Usage: sandbox [OPTIONS] COMMAND',
      'Commands:',
      'Link a workspace root',
      'Unlink a workspace root, keep all data',
      'Upgrade this CLI in place',
      'Manage workspace environments',
      'sandbox COMMAND --help',
      'Read-only diagnostics',
    ]) {
      expect(top).toContain(token);
    }
    expect(agentHelp()).toContain('claude, opencode');
    for (const name of SUPPORTED_AGENTS) {
      expect(top).toContain(name);
    }
    expect(workspaceHelp()).toContain('  attach       Reconnect to the terminal session');
    expect(imageHelp()).toContain('does not reverse a data migration');
    expect(describeAction('workspace', 'restart')).toContain('Usage: sandbox workspace restart');
    expect(describeAction('workspace', 'upgrade')).toContain('sandbox workspace upgrade [agent|all]');
    expect(describeAction('workspace', 'register')).toContain('Usage: sandbox workspace link');
    expect(describeAction('workspace', 'prune')).toContain('Usage: sandbox workspace prune');
    expect(describeAction('image', 'activate')).toContain('Usage: sandbox image activate');
    expect(describeAction('workspace', 'nope')).toBeNull();
  });
});
