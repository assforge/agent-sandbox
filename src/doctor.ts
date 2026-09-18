import { BUILTIN_CATALOG } from './engines/agent.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  group: string;
  status: CheckStatus;
  summary: string;
  remediation?: string;
}

export interface ProbeEnv {
  nodeVersion: string;
  pathLookup: (name: string) => string | null;
  commandSucceeds: (command: string, args: string[]) => boolean;
  platform: NodeJS.Platform;
  /** Container runtime under test. Defaults to Docker when omitted. */
  runtime?: { display: string; binary: string; args: string[]; verified: boolean };
  /** Terminal engine under test. Defaults to tmux when omitted. */
  terminal?: { display: string; binary: string; installHint: string };
}

function hintInstallTmux(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS installation command: brew install tmux';
  if (platform === 'linux') return 'Debian/Ubuntu installation command: sudo apt-get install tmux';
  return 'Install tmux with your platform package manager, then run this check again';
}

export interface WorkspacePosture {
  image: string | null;
  /** Null when no workspace is in scope: the network check is skipped. */
  network: 'open' | 'restricted' | null;
  networkExists: boolean;
  /** Roster windows with no live pane. Empty when unscopable. */
  deadWindows: string[];
  /** Agent versions inside the running container. Null skips the drift check. */
  runningVersions?: Record<string, string> | null;
}

/**
 * Warn for running agent binaries that drifted from their pinned versions
 * (self-updaters move on their own). Unknown agents are ignored; the check
 * is local-only and never touches the network.
 */
export function driftChecks(running: Record<string, string>): DoctorCheck[] {
  const pinned = new Map<string, { name: string; version: string }>();
  for (const entry of BUILTIN_CATALOG) {
    if (!entry.pinnedVersion) continue;
    pinned.set(entry.name, { name: entry.name, version: entry.pinnedVersion });
    if (entry.npmPackage) pinned.set(entry.npmPackage, { name: entry.name, version: entry.pinnedVersion });
  }
  const checks: DoctorCheck[] = [];
  for (const [key, version] of Object.entries(running)) {
    const want = pinned.get(key);
    if (!want || version === want.version) continue;
    checks.push({
      id: `agent-drift-${want.name}`,
      group: 'Workspace',
      status: 'warn',
      summary: `${want.name} runs ${version} but the pinned version is ${want.version}`,
      remediation: 'Run: sandbox workspace upgrade',
    });
  }
  return checks;
}

export function runDoctor(env: ProbeEnv, posture: WorkspacePosture): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const runtime = env.runtime ?? { display: 'Docker', binary: 'docker', args: ['info'], verified: true };
  const major = Number(env.nodeVersion.replace(/^v/, '').split('.')[0]);
  checks.push({
    id: 'node',
    group: 'Toolchain',
    status: Number.isNaN(major) || major < 20 ? 'fail' : 'ok',
    summary: Number.isNaN(major) || major < 20 ? `Node.js ${env.nodeVersion} is below the required major version 20` : `Node.js ${env.nodeVersion} meets the required major version 20`,
    remediation: Number.isNaN(major) || major < 20 ? 'Install Node.js 20 or newer from https://nodejs.org' : undefined,
  });

  const runtimeBin = env.pathLookup(runtime.binary);
  if (!runtimeBin) {
    checks.push({
      id: 'runtime-cli',
      group: 'Container runtime',
      status: 'fail',
      summary: `${runtime.display} CLI (${runtime.binary}) was not found on PATH`,
      remediation: runtime.binary === 'docker'
        ? 'Install Docker from https://docs.docker.com/get-docker, then run this check again'
        : `Install the ${runtime.display} CLI, then run this check again`,
    });
  } else {
    checks.push({ id: 'runtime-cli', group: 'Container runtime', status: 'ok', summary: `${runtime.display} CLI found at ${runtimeBin}` });
    const daemonUp = env.commandSucceeds(runtime.binary, runtime.args);
    checks.push({
      id: 'container-runtime',
      group: 'Container runtime',
      status: daemonUp ? 'ok' : 'fail',
      summary: daemonUp ? 'Container runtime answered the probe' : `${runtime.display} is installed, but the daemon is unavailable`,
      remediation: daemonUp ? undefined : 'Start your configured container runtime and run this check again',
    });
  }
  if (!runtime.verified) {
    checks.push({
      id: 'runtime-maturity',
      group: 'Container runtime',
      status: 'warn',
      summary: `${runtime.display} engine is experimental: live verification pending`,
    });
  }

  const terminal = env.terminal ?? { display: 'tmux', binary: 'tmux', installHint: hintInstallTmux(env.platform) };
  const tmuxBin = env.pathLookup(terminal.binary);
  checks.push({
    id: 'terminal',
    group: 'Terminal',
    status: tmuxBin ? 'ok' : 'fail',
    summary: tmuxBin ? `${terminal.display} found at ${tmuxBin}` : `${terminal.display} was not found on PATH`,
    remediation: tmuxBin ? undefined : terminal.installHint,
  });

  checks.push({
    id: 'workspace-image',
    group: 'Workspace',
    status: posture.image ? 'ok' : 'warn',
    summary: posture.image ? `Selected image digest ${posture.image}` : 'No image has been selected for this workspace',
    remediation: posture.image ? undefined : 'Run: sandbox image build',
  });
  if (posture.network === null) {
    return checks;
  }  if (!posture.networkExists) {
    checks.push({
      id: 'workspace-network',
      group: 'Workspace',
      status: 'fail',
      summary: 'The workspace network does not exist; start the workspace to create it',
      remediation: 'Run: sandbox workspace start',
    });
  } else if (posture.network === 'restricted') {
    checks.push({
      id: 'workspace-network',
      group: 'Workspace',
      status: 'ok',
      summary: 'Egress is restricted to the workspace network (no external route)',
    });
  } else {
    checks.push({
      id: 'workspace-network',
      group: 'Workspace',
      status: 'warn',
      summary: 'Egress is unrestricted on the workspace network',
      remediation: 'Run: sandbox workspace configure --network restricted',
    });
  }
  if (posture.deadWindows.length > 0) {
    checks.push({
      id: 'workspace-windows',
      group: 'Workspace',
      status: 'warn',
      summary: `Dead windows with no live pane: ${posture.deadWindows.join(', ')}`,
      remediation: 'Run: sandbox workspace reopen',
    });
  }
  if (posture.runningVersions) {
    checks.push(...driftChecks(posture.runningVersions));
  }
  return checks;
}

export function doctorExitCode(checks: DoctorCheck[]): 0 | 1 {  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}

export function renderDoctorText(checks: DoctorCheck[]): string {
  const lines = ['Doctor summary (run sandbox doctor --json for structured output):'];
  const order: CheckStatus[] = ['ok', 'fail', 'warn'];
  const label: Record<CheckStatus, string> = { ok: 'OK', fail: 'FAIL', warn: 'WARN' };
  for (const status of order) {
    for (const check of checks.filter((item) => item.status === status)) {
      lines.push(`[${label[status]}] ${check.group}: ${check.id}`);
      lines.push(`    ${check.summary}`);
      if (check.remediation) lines.push(`    ${check.remediation}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderDoctorJson(checks: DoctorCheck[]): string {
  return `${JSON.stringify({ checks }, null, 2)}\n`;
}
