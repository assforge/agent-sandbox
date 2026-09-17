import { describe, expect, it } from 'vitest';

import { doctorExitCode, renderDoctorJson, renderDoctorText, runDoctor, type ProbeEnv } from '../src/doctor.js';

const healthy: ProbeEnv = {
  nodeVersion: 'v22.1.0',
  pathLookup: (name) => `/usr/bin/${name}`,
  commandSucceeds: () => true,
  platform: 'darwin',
};

describe('runDoctor', () => {
  it('reports ok for a healthy host with a selected image', () => {
    const checks = runDoctor(healthy, { image: 'sha256:abc', network: 'restricted', networkExists: true });
    expect(checks.every((check) => check.status === 'ok')).toBe(true);
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('distinguishes missing CLI, dead daemon, missing tmux and missing image', () => {
    const noDocker = runDoctor({ ...healthy, pathLookup: (name) => (name === 'docker' ? null : `/usr/bin/${name}`) }, { image: null, network: null, networkExists: false });
    expect(noDocker.find((check) => check.id === 'docker-cli')?.status).toBe('fail');
    const deadDaemon = runDoctor({ ...healthy, commandSucceeds: () => false }, { image: 'sha256:abc', network: 'restricted', networkExists: true });
    expect(deadDaemon.find((check) => check.id === 'container-runtime')?.status).toBe('fail');
    expect(deadDaemon.find((check) => check.id === 'container-runtime')?.summary).toMatch(/daemon is unavailable/);
    const noTmux = runDoctor({ ...healthy, pathLookup: (name) => (name === 'tmux' ? null : `/usr/bin/${name}`) }, { image: 'sha256:abc', network: 'restricted', networkExists: true });
    expect(noTmux.find((check) => check.id === 'tmux')?.remediation).toMatch(/brew install tmux/);
    const noImage = runDoctor(healthy, { image: null, network: null, networkExists: false });
    expect(noImage.find((check) => check.id === 'workspace-image')?.status).toBe('warn');
    expect(doctorExitCode(noDocker)).toBe(1);
  });

  it('fails old or unparsable node versions', () => {
    const old = runDoctor({ ...healthy, nodeVersion: 'v18.3.0' }, { image: 'sha256:abc', network: 'restricted', networkExists: true });
    expect(old.find((check) => check.id === 'node')?.status).toBe('fail');
    const nan = runDoctor({ ...healthy, nodeVersion: 'bogus' }, { image: 'sha256:abc', network: 'restricted', networkExists: true });
    expect(nan.find((check) => check.id === 'node')?.status).toBe('fail');
    expect(doctorExitCode(old)).toBe(1);
  });

  it('gives platform-specific tmux remediation and maps warnings to exit 0', () => {
    const linux = runDoctor({ ...healthy, platform: 'linux', pathLookup: () => null }, { image: null, network: null, networkExists: false });
    expect(linux.find((check) => check.id === 'tmux')?.remediation).toMatch(/apt-get install tmux/);
    const unknown = runDoctor({ ...healthy, platform: 'win32', pathLookup: () => null }, { image: null, network: null, networkExists: false });
    expect(unknown.find((check) => check.id === 'tmux')?.remediation).toMatch(/package manager/);
    const warnOnly = runDoctor(healthy, { image: null, network: null, networkExists: false });
    expect(warnOnly.every((check) => check.status !== 'fail')).toBe(true);
    expect(doctorExitCode(warnOnly)).toBe(0);
  });
  it('reports network posture per workspace policy', () => {
    const restricted = runDoctor(healthy, { image: 'sha256:abc', network: 'restricted', networkExists: true });
    expect(restricted.find((check) => check.id === 'workspace-network')?.status).toBe('ok');
    const open = runDoctor(healthy, { image: 'sha256:abc', network: 'open', networkExists: true });
    expect(open.find((check) => check.id === 'workspace-network')?.status).toBe('warn');
    expect(open.find((check) => check.id === 'workspace-network')?.remediation).toMatch(/--network restricted/);
    const missing = runDoctor(healthy, { image: 'sha256:abc', network: 'open', networkExists: false });
    expect(missing.find((check) => check.id === 'workspace-network')?.status).toBe('fail');
    expect(doctorExitCode(missing)).toBe(1);
    const scopedOut = runDoctor(healthy, { image: null, network: null, networkExists: false });
    expect(scopedOut.find((check) => check.id === 'workspace-network')).toBeUndefined();
  });
  it('renders grouped English text without arrow glyphs', () => {
    const text = renderDoctorText(runDoctor({ ...healthy, commandSucceeds: () => false }, { image: null, network: null, networkExists: false }));
    expect(text).toContain('[FAIL]');
    expect(text).toContain('[WARN]');
    expect(text).not.toMatch(/->|→/);
    const parsed = JSON.parse(renderDoctorJson(runDoctor(healthy, { image: null, network: null, networkExists: false }))) as { checks: unknown[] };
    expect(parsed.checks.length).toBeGreaterThan(0);
  });
});
