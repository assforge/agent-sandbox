import { BUILTIN_CATALOG } from './engines/agent.js';
import { versionAtLeast } from './image.js';

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
  /**
   * Live internal flag of the workspace network, or null when the engine
   * cannot determine it. `network` above is the registry policy, which is
   * a record of intent and not a measurement: the check below reads this.
   */
  networkInternal?: boolean | null;
  /** Roster windows with no live pane. Empty when unscopable. */
  deadWindows: string[];
  /** Project hook commands missing inside the running container. Null skips the check. */
  unresolvedHookCommands?: string[] | null;
  /** Agent versions inside the running container. Null skips the drift check. */
  runningVersions?: Record<string, string> | null;
  /** Agent versions recorded from the image at activation. Null skips recorded comparison. */
  recordedVersions?: Record<string, string> | null;
  /**
   * The legacy home directory is still in place and the move has not run.
   * Read-only detection: doctor reports it, it never performs the move.
   */
  pendingHomeMove?: boolean;
  /**
   * An unfinished `restore`, precomputed by the caller as a state string plus the
   * backup to re-run from. Kept as text rather than as a claim so the checks stay
   * a pure function of the posture, and the wording stays with the claim itself.
   */
  pendingRestore?: { state: string; source: string } | null;
}

/**
 * First tokens of hook and MCP server commands declared in project agent
 * configs. The workspace root mounts into the container, so a hook that
 * names a host-only binary fails obscurely mid-session; doctor surfaces it
 * up front. Unparseable files are skipped: broken config is the agent's
 * problem, not doctor's.
 */
export function collectProjectHookCommands(readFile: (path: string) => string | null, root: string): string[] {
  const found: string[] = [];
  const push = (command: unknown): void => {
    if (typeof command !== 'string') return;
    const binary = command.trim().split(/\s+/, 1)[0];
    if (binary && !found.includes(binary)) found.push(binary);
  };
  for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
    let parsed: unknown = null;
    try {
      const text = readFile(`${root}/${file}`);
      if (!text) continue;
      parsed = JSON.parse(text) as unknown;
    } catch {
      continue;
    }
    const hooks = (parsed as Record<string, unknown>)['hooks'];
    if (typeof hooks !== 'object' || hooks === null) continue;
    for (const group of Object.values(hooks)) {
      if (!Array.isArray(group)) continue;
      for (const matcher of group) {
        if (typeof matcher !== 'object' || matcher === null) continue;
        const list = (matcher as Record<string, unknown>)['hooks'];
        if (!Array.isArray(list)) continue;
        for (const hook of list) {
          if (typeof hook !== 'object' || hook === null) continue;
          push((hook as Record<string, unknown>)['command']);
        }
      }
    }
  }
  try {
    const text = readFile(`${root}/.mcp.json`);
    if (text) {
      const servers = (JSON.parse(text) as Record<string, unknown>)['mcpServers'];
      if (typeof servers === 'object' && servers !== null) {
        for (const server of Object.values(servers)) {
          if (typeof server !== 'object' || server === null) continue;
          push((server as Record<string, unknown>)['command']);
        }
      }
    }
  } catch {
    // Same as above: skip, do not diagnose.
  }
  return found;
}

/**
 * Warn for project hook commands that do not resolve inside the running
 * container. Empty means everything resolved: no check, like drift.
 */
export function hookChecks(missing: string[]): DoctorCheck[] {
  if (missing.length === 0) return [];
  return [
    {
      id: 'workspace-hooks',
      group: 'Workspace',
      status: 'warn',
      summary: `Project hooks reference commands missing in the container: ${missing.join(', ')}`,
      remediation: 'Install them in the image, or scope those hooks to host-only runs',
    },
  ];
}
/**
 * Walk every catalog engine against the running probe and the activation
 * recording: mismatch warns, recorded-but-gone warns, absent-from-both
 * warns when a recording exists, and running-below-floor warns without
 * one. Unknown agents are ignored; the check is local-only and never
 * touches the network.
 */
export function driftChecks(running: Record<string, string>, recorded: Record<string, string> | null = null): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const entry of BUILTIN_CATALOG) {
    if (!entry.minimumVersion) continue;
    const key = entry.npmPackage ?? entry.name;
    const runningVersion = Object.hasOwn(running, key) ? running[key] : undefined;
    const recordedVersion = recorded ? (Object.hasOwn(recorded, key) ? recorded[key] : undefined) : undefined;
    if (runningVersion === undefined && recordedVersion === undefined) {
      // Absent from the image, not merely dormant: dormant binaries are
      // recorded at activation. Without any recording there is nothing to
      // compare against, so skip.
      if (recorded) {
        checks.push({
          id: `agent-drift-${entry.name}`,
          group: 'Workspace',
          status: 'warn',
          summary: `${entry.name} is absent from this image; upgrade to add it`,
          remediation: 'Run: sandbox workspace upgrade',
        });
      }
      continue;
    }
    if (runningVersion !== undefined && recordedVersion !== undefined && runningVersion !== recordedVersion) {
      checks.push({
        id: `agent-drift-${entry.name}`,
        group: 'Workspace',
        status: 'warn',
        summary: `${entry.name} runs ${runningVersion} but the image recorded ${recordedVersion}`,
        remediation: 'Run: sandbox workspace upgrade to rebuild, or re-activate the intended image',
      });
      continue;
    }
    if (runningVersion === undefined) {
      checks.push({
        id: `agent-drift-${entry.name}`,
        group: 'Workspace',
        status: 'warn',
        summary: `${entry.name} is recorded but not running; its binary may have been removed`,
        remediation: 'Run: sandbox workspace upgrade to rebuild',
      });
      continue;
    }
    if (recordedVersion === undefined && versionAtLeast(runningVersion, entry.minimumVersion) === false) {
      checks.push({
        id: `agent-drift-${entry.name}`,
        group: 'Workspace',
        status: 'warn',
        summary: `${entry.name} runs ${runningVersion}, below the supported minimum ${entry.minimumVersion}`,
        remediation: 'Run: sandbox workspace upgrade',
      });
    }
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

  if (posture.pendingHomeMove) {
    checks.push({
      id: 'home-dir',
      group: 'Host',
      status: 'warn',
      summary: 'Host state is still under ~/.sandbox; it moves to ~/.agent.sandbox on the next mutating command',
      remediation: 'Run: sandbox workspace list',
    });
  }

  checks.push({
    id: 'workspace-image',
    group: 'Workspace',
    status: posture.image ? 'ok' : 'warn',
    summary: posture.image ? `Selected image digest ${posture.image}` : 'No image has been selected for this workspace',
    remediation: posture.image ? undefined : 'Run: sandbox image build',
  });
  // Reported before the network block below, which returns early when no workspace is in
  // scope: a frozen workspace must be reported even when the rest cannot be probed.
  if (posture.pendingRestore) {
    checks.push({
      id: 'workspace-restore',
      group: 'Workspace',
      status: 'warn',
      summary: `A restore of this workspace did not finish (${posture.pendingRestore.state}); its home is indeterminate and every other command refuses`,
      remediation: `Run: sandbox workspace restore --input ${posture.pendingRestore.source}`,
    });
  }
  if (posture.network === null) {
    return checks;
  }
  if (!posture.networkExists) {
    checks.push({
      id: 'workspace-network',
      group: 'Workspace',
      status: 'fail',
      summary: 'The workspace network does not exist; start the workspace to create it',
      remediation: 'Run: sandbox workspace start',
    });
  } else if (posture.networkInternal === undefined || posture.networkInternal === null) {
    // The registry policy is a record of intent, not a measurement. Claiming
    // "no external route" on the strength of it is the defect this check
    // exists to prevent, so an unreadable probe reports itself as unread.
    checks.push({
      id: 'workspace-network',
      group: 'Workspace',
      status: 'warn',
      summary: 'Cannot determine whether the workspace network has an external route',
      remediation: 'Check the container runtime, then run this check again',
    });
  } else if (posture.networkInternal) {
    checks.push({
      id: 'workspace-network',
      group: 'Workspace',
      status: 'ok',
      summary: 'Egress is restricted to the workspace network (no external route)',
    });
  } else if (posture.network === 'restricted') {
    // Recorded as restricted, but the live network is still an ordinary
    // bridge: the switch has not been applied. Reporting this workspace
    // isolated while its route is open is exactly the dishonest answer.
    checks.push({
      id: 'workspace-network',
      group: 'Workspace',
      status: 'warn',
      summary: 'Policy is restricted but the live network still has an external route; it flips on the next start',
      remediation: 'Run: sandbox workspace start',
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
    checks.push(...driftChecks(posture.runningVersions, posture.recordedVersions ?? null));
  }
  if (posture.unresolvedHookCommands) {
    checks.push(...hookChecks(posture.unresolvedHookCommands));
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
