import { describe, expect, it } from 'vitest';

import { doctorExitCode, driftChecks, renderDoctorJson, renderDoctorText, runDoctor, type ProbeEnv } from '../src/doctor.js';

const healthy: ProbeEnv = {
  nodeVersion: 'v22.1.0',
  pathLookup: (name) => `/usr/bin/${name}`,
  commandSucceeds: () => true,
  platform: 'darwin',
};

describe('runDoctor', () => {
  it('reports ok for a healthy host with a selected image', () => {
    const checks = runDoctor(healthy, { image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: [] });
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

  it('warns when running agents drift from pinned versions and ignores the rest', () => {
    expect(driftChecks({})).toEqual([]);
    expect(driftChecks({ claude: '2.1.276', 'opencode-ai': '1.18.31', '@openai/codex': '0.154.0', '@github/copilot': '1.0.85' })).toEqual([]);
    const drifted = driftChecks({ claude: '2.1.276', '@openai/codex': '9.9.9', 'some-future-agent': '1.0.0' });
    expect(drifted).toHaveLength(1);
    expect(drifted[0]).toMatchObject({ id: 'agent-drift-codex', status: 'warn', remediation: 'Run: sandbox workspace upgrade' });
    expect(drifted[0]?.summary).toMatch(/codex runs 9\.9\.9/);
    const wired = runDoctor(healthy, { image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: [], runningVersions: { claude: '9.9.9' } });
    expect(wired.find((check) => check.id === 'agent-drift-claude')?.status).toBe('warn');
    expect(doctorExitCode(wired)).toBe(0);
    const clean = runDoctor(healthy, { image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: [] });
    expect(clean.some((check) => check.id.startsWith('agent-drift'))).toBe(false);
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

  it('reports network posture per workspace policy', () => {
    const restricted = runDoctor(healthy, { image: 'sha256:abc', network: 'restricted', networkExists: true, deadWindows: [] });
    expect(restricted.find((check) => check.id === 'workspace-network')?.status).toBe('ok');
    const open = runDoctor(healthy, { image: 'sha256:abc', network: 'open', networkExists: true, deadWindows: [] });
    expect(open.find((check) => check.id === 'workspace-network')?.status).toBe('warn');
    expect(open.find((check) => check.id === 'workspace-network')?.remediation).toMatch(/--network restricted/);
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
