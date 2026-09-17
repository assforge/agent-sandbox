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
  const probed = runner.run('docker', ['inspect', '--format', '{{.State.Running}}|{{index .Config.Labels "sandbox.managed"}}|{{index .Config.Labels "sandbox.workspace"}}', container]);
  if (probed.status !== 0) return 'absent';
  const [running, managed, owner] = probed.stdout.trim().split('|');
  if (managed !== 'true' || owner !== workspaceIdValue) return 'foreign';
  return running === 'true' ? 'running' : 'stopped';
}

export function volumeExists(runner: CommandRunner, volume: string): boolean {
  const listed = runner.run('docker', ['volume', 'ls', '--filter', `name=^${escapeFilterRegex(volume)}$`, '--format', '{{.Name}}']);
  if (listed.status !== 0) return false;
  return listed.stdout.split('\n').map((line) => line.trim()).includes(volume);
}

export function ensureVolume(runner: CommandRunner, volume: string, workspaceIdValue: string): void {
  if (volumeExists(runner, volume)) return;
  const created = runner.run('docker', ['volume', 'create', '--label', MANAGED_LABEL, '--label', workspaceLabel(workspaceIdValue), volume]);
  if (created.status !== 0) {
    throw new Error(`cannot create volume ${volume}: ${created.stderr.trim()}`);
  }
}

export interface CreateOptions {
  image: string;
  workdir: string;
  mounts: string[];
  homeVolume: string;
  generation: string;
  fingerprint: string;
}

export function createContainer(runner: CommandRunner, entry: { id: string; container: string; root: string }, options: CreateOptions): void {
  ensureVolume(runner, options.homeVolume, entry.id);
  const args = [
    'run', '-d', '--pull', 'never', '--name', entry.container,
    '--label', MANAGED_LABEL, '--label', workspaceLabel(entry.id),
    '-v', `${entry.root}:${options.workdir}:rw`,
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
