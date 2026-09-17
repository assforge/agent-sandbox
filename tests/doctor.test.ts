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

  it('renders grouped English text without arrow glyphs', () => {
    const text = renderDoctorText(runDoctor({ ...healthy, commandSucceeds: () => false }, null));
    expect(text).toContain('[FAIL]');
    expect(text).toContain('[WARN]');
    expect(text).not.toMatch(/->|→/);
    const parsed = JSON.parse(renderDoctorJson(runDoctor(healthy, null))) as { checks: unknown[] };
    expect(parsed.checks.length).toBeGreaterThan(0);
  });
});
