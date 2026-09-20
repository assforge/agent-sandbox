import { describe, expect, it } from 'vitest';

import { collectProjectHookCommands, doctorExitCode, driftChecks, hookChecks, renderDoctorJson, renderDoctorText, runDoctor, type ProbeEnv } from '../src/doctor.js';

const healthy: ProbeEnv = {
  nodeVersion: 'v22.1.0',
  pathLookup: (name) => `/usr/bin/${name}`,
  commandSucceeds: () => true,
  platform: 'darwin',
};

describe('runDoctor', () => {
  it('reports ok for a healthy host with a selected image', () => {
    const checks = runDoctor(healthy, { image: 'sha256:abc', network: 'restricted', networkExists: true, networkInternal: true, deadWindows: [] });
    expect(checks.every((check) => check.status === 'ok')).toBe(true);
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('distinguishes missing CLI, dead daemon, missing tmux and missing image', () => {
    const noDocker = runDoctor({ ...healthy, pathLookup: (name) => (name === 'docker' ? null : `/usr/bin/${name}`) }, { image: null, network: null, networkExists: false, deadWindows: [] });
    expect(noDocker.find((check) => check.id === 'runtime-cli')?.status).toBe('fail');
    const deadDaemon = runDoctor({ ...healthy, commandSucceeds: () => false }, { image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: [] });
    expect(deadDaemon.find((check) => check.id === 'container-runtime')?.status).toBe('fail');
    expect(deadDaemon.find((check) => check.id === 'container-runtime')?.summary).toMatch(/daemon is unavailable/);
    const noTmux = runDoctor({ ...healthy, pathLookup: (name) => (name === 'tmux' ? null : `/usr/bin/${name}`) }, { image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: [] });
    expect(noTmux.find((check) => check.id === 'terminal')?.remediation).toMatch(/brew install tmux/);
    const noImage = runDoctor(healthy, { image: null, network: null, networkExists: false, deadWindows: [] });
    expect(noImage.find((check) => check.id === 'workspace-image')?.status).toBe('warn');
    expect(doctorExitCode(noDocker)).toBe(1);
  });

  it('fails old or unparsable node versions', () => {
    const old = runDoctor({ ...healthy, nodeVersion: 'v18.3.0' }, { image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: [] });
    expect(old.find((check) => check.id === 'node')?.status).toBe('fail');
    const nan = runDoctor({ ...healthy, nodeVersion: 'bogus' }, { image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: [] });
    expect(nan.find((check) => check.id === 'node')?.status).toBe('fail');
    expect(doctorExitCode(old)).toBe(1);
  });

  it('gives platform-specific tmux remediation and maps warnings to exit 0', () => {
    const linux = runDoctor({ ...healthy, platform: 'linux', pathLookup: () => null }, { image: null, network: null, networkExists: false, deadWindows: [] });
    expect(linux.find((check) => check.id === 'terminal')?.remediation).toMatch(/apt-get install tmux/);
    const unknown = runDoctor({ ...healthy, platform: 'win32', pathLookup: () => null }, { image: null, network: null, networkExists: false, deadWindows: [] });
    expect(unknown.find((check) => check.id === 'terminal')?.remediation).toMatch(/package manager/);
    const warnOnly = runDoctor(healthy, { image: null, network: null, networkExists: false, deadWindows: [] });
    expect(warnOnly.every((check) => check.status !== 'fail')).toBe(true);
    expect(doctorExitCode(warnOnly)).toBe(0);
  });
  it('warns on dead roster windows', () => {
    const dead = runDoctor(healthy, { image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: ['rollout'] });
    expect(dead.find((check) => check.id === 'workspace-windows')?.status).toBe('warn');
    expect(dead.find((check) => check.id === 'workspace-windows')?.remediation).toMatch(/reopen/);
  });

  it('warns on recorded mismatch, then on floor breach, and ignores the rest', () => {
    const clean = {
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
    };
    expect(driftChecks({})).toEqual([]);
    expect(driftChecks(clean, clean)).toEqual([]);
    // No recording: only a floor breach warns.
    expect(driftChecks(clean, null)).toEqual([]);
    const drifted = driftChecks({ claude: '2.1.276', '@openai/codex': '9.9.9', 'some-future-agent': '1.0.0' }, clean);
    expect(drifted).toHaveLength(1);
    expect(drifted[0]).toMatchObject({ id: 'agent-drift-codex', status: 'warn', remediation: 'Run: sandbox workspace upgrade to rebuild, or re-activate the intended image' });
    expect(drifted[0]?.summary).toMatch(/codex runs 9\.9\.9.*recorded 0\.155\.1/);
    const ancient = driftChecks({ '@openai/codex': '0.1.0' }, null);
    expect(ancient).toHaveLength(1);
    expect(ancient[0]?.summary).toMatch(/below the supported minimum/);
    const wired = runDoctor(healthy, { image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: [], runningVersions: { claude: '9.9.9' }, recordedVersions: { claude: '2.1.276' } });
    expect(wired.find((check) => check.id === 'agent-drift-claude')?.status).toBe('warn');
    expect(doctorExitCode(wired)).toBe(0);
    const unrecorded = runDoctor(healthy, { image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: [] });
    expect(unrecorded.some((check) => check.id.startsWith('agent-drift'))).toBe(false);
  });

  it('collects hook and MCP server commands from project configs', () => {
    const files: Record<string, string> = {
      '/w/.claude/settings.json': JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ command: 'code-review-graph status --fast' }] }], Stop: 'not-an-array' },
      }),
      '/w/.claude/settings.local.json': 'broken{',
      '/w/.mcp.json': JSON.stringify({ mcpServers: { graph: { command: 'code-review-graph' }, ctx7: { command: 'npx -y ctx7' } } }),
    };
    expect(collectProjectHookCommands((path) => files[path] ?? null, '/w')).toEqual(['code-review-graph', 'npx']);
    expect(collectProjectHookCommands(() => null, '/w')).toEqual([]);
    expect(hookChecks([])).toEqual([]);
    const warned = hookChecks(['code-review-graph']);
    expect(warned[0]).toMatchObject({ id: 'workspace-hooks', status: 'warn' });
    expect(warned[0]?.summary).toMatch(/code-review-graph/);
    const wired = runDoctor(healthy, { image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: [], unresolvedHookCommands: ['code-review-graph'] });
    expect(wired.find((check) => check.id === 'workspace-hooks')?.status).toBe('warn');
    expect(doctorExitCode(wired)).toBe(0);
  });

  it('probes the selected runtime and flags experimental engines', () => {
    const apple = runDoctor(
      { ...healthy, runtime: { display: 'Apple Container', binary: 'container', args: ['system', 'status'], verified: false } },
      { image: null, network: null, networkExists: false, deadWindows: [] },
    );
    expect(apple.find((check) => check.id === 'runtime-cli')?.summary).toMatch(/Apple Container CLI/);
    expect(apple.find((check) => check.id === 'runtime-maturity')?.status).toBe('warn');
    const docker = runDoctor(healthy, { image: null, network: null, networkExists: false, deadWindows: [] });
    expect(docker.find((check) => check.id === 'runtime-maturity')).toBeUndefined();
  });

  it('reports network posture from the live flag, not the workspace policy', () => {
    const posture = (overrides: Partial<{ network: 'open' | 'restricted'; networkExists: boolean; networkInternal: boolean | null }>) => {
      const found = runDoctor(healthy, {
        image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: [], ...overrides,
      });
      return found.find((check) => check.id === 'workspace-network');
    };
    // A measurement that agrees with the policy.
    expect(posture({ networkInternal: true })?.status).toBe('ok');
    // The policy is a record of intent. Restricted on paper but still an
    // ordinary bridge is exactly the state the old check called isolated.
    expect(posture({ networkInternal: false })?.status).toBe('warn');
    expect(posture({ networkInternal: false })?.summary).toMatch(/flips on the next start/);
    // No measurement must never be reported as isolation.
    expect(posture({})?.status).toBe('warn');
    expect(posture({})?.summary).toMatch(/Cannot determine/);
    expect(posture({ networkInternal: null })?.status).toBe('warn');
    // A live internal network under an open policy is still isolated.
    expect(posture({ network: 'open', networkInternal: true })?.status).toBe('ok');
    expect(posture({ network: 'open', networkInternal: false })?.status).toBe('warn');
    expect(posture({ network: 'open', networkInternal: false })?.remediation).toMatch(/--network restricted/);
    const missing = runDoctor(healthy, { image: 'sha256:abc', network: 'open', networkExists: false, deadWindows: [] });
    expect(missing.find((check) => check.id === 'workspace-network')?.status).toBe('fail');
    expect(doctorExitCode(missing)).toBe(1);
    const scopedOut = runDoctor(healthy, { image: null, network: null, networkExists: false, deadWindows: [] });
    expect(scopedOut.find((check) => check.id === 'workspace-network')).toBeUndefined();
  });
  it('renders grouped English text without arrow glyphs', () => {
    const text = renderDoctorText(runDoctor({ ...healthy, commandSucceeds: () => false }, { image: null, network: null, networkExists: false, deadWindows: [] }));
    expect(text).toContain('[FAIL]');
    expect(text).toContain('[WARN]');
    expect(text).not.toMatch(/->|→/);
    const parsed = JSON.parse(renderDoctorJson(runDoctor(healthy, { image: null, network: null, networkExists: false, deadWindows: [] }))) as { checks: unknown[] };
    expect(parsed.checks.length).toBeGreaterThan(0);
  });
});
