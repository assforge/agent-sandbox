import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { agentEngine, agentEngines, loadAgentCatalog, outdatedEngines } from '../src/engines/agent.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { normalizeLexical, redactedConfig, rejectForbiddenMount } from '../src/config.js';
import { sameImageId } from '../src/docker.js';
import { emptyRegistry, registerWorkspace } from '../src/registry.js';
import { activateImage, buildCandidate, recordActivation, rollbackImage } from '../src/image.js';
import { acquireLock } from '../src/lock.js';
import { assertWindowName } from '../src/terminal.js';
import { dryRunMigration } from '../src/migrate.js';
import { checkReadiness, configurationFingerprint, freshGeneration } from '../src/readiness.js';
import { agentHelp, describeAction, imageHelp, topHelp, workspaceHelp } from '../src/help.js';

describe('agents', () => {
  const engines = agentEngines();

  it('pins exact npm versions and rejects unsupported agents', () => {
    expect(agentEngine(engines, 'codex').installSpec()).toMatchObject({ npmPackage: '@openai/codex', pinnedVersion: '0.154.0' });
    expect(() => agentEngine(engines, 'grok')).toThrow(/no verified linux install channel/);
    expect(() => agentEngine(engines, 'nope')).toThrow(/unknown agent/);
  });

  it('inspects outdated versions through the runner', () => {
    const entries = outdatedEngines({
      installedVersion: (pkg) => (pkg === 'opencode-ai' ? '1.18.0' : null),
      latestVersion: () => '9.9.9',
      fetchText: () => '9.9.9',
    }, engines.values());
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ agent: 'claude', npmPackage: null, installed: null, pinned: '2.1.276', latest: '9.9.9' });
    expect(entries[1]).toMatchObject({ agent: 'opencode', pinned: '1.18.31' });
    expect(() => agentEngine(engines, 'agy')).toThrow(/no verified linux install channel/);
    const nullLatest = outdatedEngines({ installedVersion: () => null, latestVersion: () => null, fetchText: () => null }, engines.values());
    expect(nullLatest.every((entry) => entry.latest === null)).toBe(true);
  });

  it('adds a fifth agent through data alone', () => {
    const extended = agentEngines([{ name: 'kiro', statePaths: ['.kiro'], launch: ['kiro'], npmPackage: null, pinnedVersion: '9.9.9', latestEndpoint: null }]);
    expect(agentEngine(extended, 'kiro').launch).toEqual(['kiro']);
    expect(agentEngine(extended, 'codex').installSpec().pinnedVersion).toBe('0.154.0');
  });

  it('refuses an unsupported agent however it reaches the registry', () => {
    const grok = { name: 'grok', statePaths: ['.grok'], launch: ['grok'], npmPackage: null, pinnedVersion: '1.0.0', latestEndpoint: null };
    // A user catalog document declaring grok/agy fails closed at load.
    expect(() => loadAgentCatalog([grok])).toThrow(/not supported in containers/);
    expect(() => loadAgentCatalog([{ ...grok, name: 'agy' }])).toThrow(/not supported in containers/);
    // A supported extra agent is still accepted.
    expect(loadAgentCatalog([{ ...grok, name: 'kiro' }])).toHaveLength(1);
    // And the guard is unconditional: even when the lookup would succeed, it
    // throws. This is the case a user catalog used to create.
    const forged = new Map(engines);
    forged.set('grok', engines.get('codex') as NonNullable<ReturnType<typeof engines.get>>);
    expect(() => agentEngine(forged, 'grok')).toThrow(/no verified linux install channel/);
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
          claude: '2.1.276',
          'opencode-ai': '1.18.31',
          '@openai/codex': '0.154.0',
          '@github/copilot': '1.0.85',
        }),
        verifyCandidate: () => true,
      },
      '/ctx',
      'sandbox:candidate',
      agentEngines().values(),
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
    expect(() => buildCandidate(runner, '/ctx', 't', agentEngines().values())).toThrow(/expected/);
    expect(() =>
      buildCandidate({ ...runner, inspectBinaryVersions: () => ({ claude: '2.1.276', 'opencode-ai': '0.0.0' }) }, '/ctx', 't', agentEngines().values()),
    ).toThrow(/0\.0\.0/);
  });

  it('fails the candidate when independent verification rejects it', () => {
    expect(() =>
      buildCandidate(
        {
          buildImage: (plan: { tag: string }) => plan.tag,
          inspectBinaryVersions: () => ({
            claude: '2.1.276',
            'opencode-ai': '1.18.31',
            '@openai/codex': '0.154.0',
            '@github/copilot': '1.0.85',
          }),
          verifyCandidate: () => false,
        },
        '/ctx',
        't',
        agentEngines().values(),
      ),
    ).toThrow(/failed verification/);
  });

  it('includes the native claude agent in build args and expected versions', () => {
    const seenArgs: Record<string, string>[] = [];
    buildCandidate(
      {
        buildImage: (plan: { tag: string; buildArgs: Record<string, string> }) => {
          seenArgs.push(plan.buildArgs);
          return plan.tag;
        },
        inspectBinaryVersions: () => ({
          claude: '2.1.276',
          'opencode-ai': '1.18.31',
          '@openai/codex': '0.154.0',
          '@github/copilot': '1.0.85',
        }),
        verifyCandidate: () => true,
      },
      '/ctx',
      't',
      agentEngines().values(),
    );
    expect(seenArgs[0]).toMatchObject({ CLAUDE_VERSION: '2.1.276' });
  });

  it('activates explicitly and rolls back without reversing data', () => {
    const registry = emptyRegistry();
    const entry = registerWorkspace(registry, '/w', []);
    expect(() => rollbackImage(entry)).toThrow(/no previous image/);
    expect(activateImage(entry, 'sha256:new')).toEqual({ previous: null, current: 'sha256:new' });
    expect(entry.image).toBe('sha256:new');
    expect(activateImage(entry, 'sha256:newer')).toEqual({ previous: 'sha256:new', current: 'sha256:newer' });
    expect(rollbackImage(entry)).toEqual({ previous: 'sha256:newer', current: 'sha256:new' });
    expect(entry.image).toBe('sha256:new');
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
