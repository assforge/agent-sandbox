export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run: (command: string, args: string[]) => RunResult;
}

export type ContainerState = 'absent' | 'stopped' | 'running' | 'foreign';

export const MANAGED_LABEL = 'sandbox.managed=true';

export function workspaceLabel(workspaceIdValue: string): string {
  return `sandbox.workspace=${workspaceIdValue}`;
}

/** Moved to registry.ts (resource naming belongs to the core, not the docker dialect). */
export { networkName } from './registry.js';

/** Escape a literal name for embedding in a docker --filter regex. */
export function escapeFilterRegex(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, (char) => `\\${char}`);
}

/**
 * Inspect a container by exact name. Existence is probed with a filtered
 * list (exit 0, empty output) because `docker inspect` on a missing name
 * writes to the terminal past pipes on some runtimes. A name owned by
 * someone else (missing our labels) is foreign: the CLI fails without
 * mutation, never adopts it.
 */
export function containerState(runner: CommandRunner, container: string, workspaceIdValue: string): ContainerState {
  const listed = runner.run('docker', ['ps', '-a', '--filter', `name=^/${escapeFilterRegex(container)}$`, '--format', '{{.Names}}']);
  if (listed.status !== 0) {
    throw new Error(`cannot list containers: ${listed.stderr.trim()}`);
  }
  if (!listed.stdout.split('\n').map((line) => line.trim()).includes(container)) return 'absent';
  const probed = runner.run('docker', ['inspect', '--format', '{{.State.Running}}|{{index .Config.Labels "sandbox.managed"}}|{{index .Config.Labels "sandbox.workspace"}}|{{index .Config.Labels "sandbox.runtime"}}', container]);
  if (probed.status !== 0) return 'absent';
  const [running, managed, owner, runtime] = probed.stdout.trim().split('|');
  if (managed !== 'true' || owner !== workspaceIdValue) return 'foreign';
  if (runtime && runtime !== 'docker') return 'foreign';
  return running === 'true' ? 'running' : 'stopped';
}

export function volumeExists(runner: CommandRunner, volume: string): boolean {
  const listed = runner.run('docker', ['volume', 'ls', '--filter', `name=^${escapeFilterRegex(volume)}$`, '--format', '{{.Name}}']);
  if (listed.status !== 0) return false;
  return listed.stdout.split('\n').map((line) => line.trim()).includes(volume);
}

export function ensureVolume(runner: CommandRunner, volume: string, workspaceIdValue: string): void {  if (volumeExists(runner, volume)) return;
  const created = runner.run('docker', ['volume', 'create', '--label', MANAGED_LABEL, '--label', workspaceLabel(workspaceIdValue), volume]);
  if (created.status !== 0) {
    throw new Error(`cannot create volume ${volume}: ${created.stderr.trim()}`);
  }
}

export interface CreateOptions {
  image: string;
  mounts: string[];
  homeVolume: string;
  network: string;
  runtimeName: string;
  generation: string;
  fingerprint: string;
}

/**
 * Per-workspace bridge network. A restricted network is internal: the
 * container keeps DNS for its own name only and no route outside, which
 * holds on both Docker Desktop and Linux daemons. Open networks are
 * ordinary bridges and must be an explicit choice, never a default leak.
 * The internal flag is create-time immutable: a policy switch recreates
 * the network once no container is attached to it.
 */
export function ensureNetwork(runner: CommandRunner, network: string, workspaceIdValue: string, restricted: boolean): void {
  const listed = runner.run('docker', ['network', 'ls', '--filter', `name=^${escapeFilterRegex(network)}$`, '--format', '{{.Name}}']);
  const exists = listed.status === 0 && listed.stdout.split('\n').map((line) => line.trim()).includes(network);
  if (exists) {
    if (networkInternal(runner, network) === restricted) return;
    // The internal flag is create-time immutable. The caller removes
    // attached containers first; a refused removal means something else
    // still holds the network.
    const removed = runner.run('docker', ['network', 'rm', network]);
    if (removed.status !== 0) {
      throw new Error(
        `network ${network} has the wrong policy and is still attached; stop its containers, then retry`,
      );
    }
  }
  const args = ['network', 'create', '--label', MANAGED_LABEL, '--label', workspaceLabel(workspaceIdValue)];
  if (restricted) args.push('--internal');
  args.push(network);
  const created = runner.run('docker', args);
  if (created.status !== 0) {
    throw new Error(`cannot create network ${network}: ${created.stderr.trim()}`);
  }
}

/** Names of networks attached to a container (empty when undeterminable). */
export function containerNetworks(runner: CommandRunner, container: string): string[] {
  const probed = runner.run('docker', ['inspect', '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}', container]);
  if (probed.status !== 0) return [];
  return probed.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/** Whether a network is internal (null when undeterminable). */
export function networkInternal(runner: CommandRunner, network: string): boolean | null {
  const probed = runner.run('docker', ['network', 'inspect', '--format', '{{.Internal}}', network]);
  if (probed.status !== 0) return null;
  const value = probed.stdout.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function createContainer(runner: CommandRunner, entry: { id: string; container: string; root: string }, options: CreateOptions): void {
  ensureVolume(runner, options.homeVolume, entry.id);
  // Migrated state keeps its old numeric UID and fresh Apple volumes
  // arrive root-owned (the apple runtime repairs at the same point):
  // hand the home tree to the agent user with full capabilities before
  // the cap-dropped container starts. The entrypoint itself can never
  // do this (CAP_CHOWN is dropped).
  const owned = runner.run('docker', [
    'run', '--rm', '--user', 'root', '--entrypoint', 'chown',
    '-v', `${options.homeVolume}:/home/agent`,
    options.image, '-R', 'agent:agent', '/home/agent',
  ]);
  if (owned.status !== 0) {
    throw new Error(`cannot prepare home volume ${options.homeVolume}: ${owned.stderr.trim()}`);
  }
  const args = [
    'run', '-d', '--pull', 'never', '--cap-drop', 'ALL', '--network', options.network, '--name', entry.container,
    '--label', MANAGED_LABEL, '--label', workspaceLabel(entry.id), '--label', `sandbox.runtime=${options.runtimeName}`,
    // Same-path bind: host and container share the workspace path, so
    // absolute paths, editor links, and cwd-keyed agent state survive.
    '-v', `${entry.root}:${entry.root}:rw`,
    '-v', `${options.homeVolume}:/home/agent`,
    '-e', `SANDBOX_GENERATION=${options.generation}`,
    '-e', `SANDBOX_CONFIG_FINGERPRINT=${options.fingerprint}`,
  ];
  for (const mount of options.mounts) {
    if (mount !== entry.root) args.push('-v', `${mount}:${mount}:ro`);
  }
  args.push(options.image, 'sleep', 'infinity');
  const created = runner.run('docker', args);
  if (created.status !== 0) {
    throw new Error(`cannot create container ${entry.container}: ${created.stderr.trim()}`);
  }
}

export function startContainer(runner: CommandRunner, container: string): void {
  const started = runner.run('docker', ['start', container]);
  if (started.status !== 0) {
    throw new Error(`cannot start container ${container}: ${started.stderr.trim()}`);
  }
}

export function stopContainer(runner: CommandRunner, container: string): void {
  const stopped = runner.run('docker', ['stop', container]);
  if (stopped.status !== 0) {
    throw new Error(`cannot stop container ${container}: ${stopped.stderr.trim()}`);
  }
}

export function removeContainer(runner: CommandRunner, container: string): void {
  const removed = runner.run('docker', ['rm', '-f', container]);
  if (removed.status !== 0) {
    throw new Error(`cannot remove container ${container}: ${removed.stderr.trim()}`);
  }
}

/** Resolved image id of a container, or null when it cannot be determined. */
export function containerImageId(runner: CommandRunner, container: string): string | null {
  const probed = runner.run('docker', ['inspect', '--format', '{{.Image}}', container]);
  if (probed.status !== 0) return null;
  const id = probed.stdout.trim();
  return id || null;
}

/** Resolved image id of a local image reference, or null when absent. */
export function referenceImageId(runner: CommandRunner, image: string): string | null {
  const listed = runner.run('docker', ['images', '-q', image]);
  if (listed.status !== 0) return null;
  const id = listed.stdout.trim().split('\n').map((line) => line.trim()).filter(Boolean)[0];
  return id ?? null;
}

/**
 * Image identity comparison. `docker inspect` reports the full digest
 * (sha256:...) while `docker images -q` reports the short id; a naive
 * string comparison mismatches forever and recreates the container on
 * every invocation, killing all running agent processes.
 */
export function sameImageId(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const strip = (id: string): string => id.replace(/^sha256:/, '');
  const a = strip(left);
  const b = strip(right);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export function readReadyJson(runner: CommandRunner, container: string): { generation: string; fingerprint: string; startedAt: number } | null {
  const probed = runner.run('docker', ['exec', container, 'cat', '/tmp/sandbox-ready/ready.json']);
  if (probed.status !== 0) return null;
  try {
    const parsed = JSON.parse(probed.stdout) as { generation?: unknown; fingerprint?: unknown; started_at?: unknown };
    if (typeof parsed.generation !== 'string' || typeof parsed.fingerprint !== 'string') return null;
    return {
      generation: parsed.generation,
      fingerprint: parsed.fingerprint,
      startedAt: typeof parsed.started_at === 'number' ? parsed.started_at : 0,
    };
  } catch {
    return null;
  }
}

export function imageExists(runner: CommandRunner, image: string): boolean {
  const listed = runner.run('docker', ['images', '-q', image]);
  return listed.status === 0 && listed.stdout.trim().length > 0;
}

export function listManagedContainers(runner: CommandRunner): string[] {
  const listed = runner.run('docker', ['ps', '-a', '--filter', `label=${MANAGED_LABEL}`, '--format', '{{.Names}}']);
  if (listed.status !== 0) return [];
  return listed.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}
