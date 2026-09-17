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
    const checks = runDoctor(healthy, 'sha256:abc');
    expect(checks.every((check) => check.status === 'ok')).toBe(true);
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('distinguishes missing CLI, dead daemon, missing tmux and missing image', () => {
    const noDocker = runDoctor({ ...healthy, pathLookup: (name) => (name === 'docker' ? null : `/usr/bin/${name}`) }, null);
    expect(noDocker.find((check) => check.id === 'docker-cli')?.status).toBe('fail');
    const deadDaemon = runDoctor({ ...healthy, commandSucceeds: () => false }, 'sha256:abc');
    expect(deadDaemon.find((check) => check.id === 'container-runtime')?.status).toBe('fail');
    expect(deadDaemon.find((check) => check.id === 'container-runtime')?.summary).toMatch(/daemon is unavailable/);
    const noTmux = runDoctor({ ...healthy, pathLookup: (name) => (name === 'tmux' ? null : `/usr/bin/${name}`) }, 'sha256:abc');
    expect(noTmux.find((check) => check.id === 'tmux')?.remediation).toMatch(/brew install tmux/);
    const noImage = runDoctor(healthy, null);
    expect(noImage.find((check) => check.id === 'workspace-image')?.status).toBe('warn');
    expect(doctorExitCode(noDocker)).toBe(1);
  });

  it('fails old or unparsable node versions', () => {
    const old = runDoctor({ ...healthy, nodeVersion: 'v18.3.0' }, 'sha256:abc');
    expect(old.find((check) => check.id === 'node')?.status).toBe('fail');
    const nan = runDoctor({ ...healthy, nodeVersion: 'bogus' }, 'sha256:abc');
    expect(nan.find((check) => check.id === 'node')?.status).toBe('fail');
    expect(doctorExitCode(old)).toBe(1);
  });

  it('gives platform-specific tmux remediation and maps warnings to exit 0', () => {
    const linux = runDoctor({ ...healthy, platform: 'linux', pathLookup: () => null }, null);
    expect(linux.find((check) => check.id === 'tmux')?.remediation).toMatch(/apt-get install tmux/);
    const unknown = runDoctor({ ...healthy, platform: 'win32', pathLookup: () => null }, null);
    expect(unknown.find((check) => check.id === 'tmux')?.remediation).toMatch(/package manager/);
    const warnOnly = runDoctor(healthy, null);
    expect(warnOnly.every((check) => check.status !== 'fail')).toBe(true);
    expect(doctorExitCode(warnOnly)).toBe(0);
  });
  it('renders grouped English text without arrow glyphs', () => {
    const text = renderDoctorText(runDoctor({ ...healthy, commandSucceeds: () => false }, null));
    expect(text).toContain('[FAIL]');
    expect(text).toContain('[WARN]');
    expect(text).not.toMatch(/->|→/);
    const parsed = JSON.parse(renderDoctorJson(runDoctor(healthy, null))) as { checks: unknown[] };
    expect(parsed.checks.length).toBeGreaterThan(0);
  });
});
