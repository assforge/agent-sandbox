/**
 * RuntimeEngine seam (D8). Container, image, volume, and network
 * operations behind one interface plus an explicit capability set, so a
 * runtime that lacks a required capability fails closed instead of
 * silently downgrading.
 */
import {
  containerImageId,
  containerNetworks,
  containerState,
  createContainer,
  ensureNetwork,
  ensureVolume,
  escapeFilterRegex,
  imageExists,
  listManagedContainers,
  listWorkspaceImages,
  networkInternal,
  readReadyJson,
  referenceImageId,
  removeContainer,
  removeImage,
  sameImageId,
  startContainer,
  stopContainer,
  type CommandRunner,
  type ContainerState,
  type CreateOptions,
} from '../docker.js';

export type { CreateOptions };

export interface RuntimeCapabilities {
  labels: boolean;
  internalNetworks: boolean;
  capDrop: boolean;
  vectorExec: boolean;
}

import type { ExecSpec } from './types.js';
import type { RunResult } from '../docker.js';

export interface ExecVectorOptions {
  workdir: string;
  argv: string[];
  user?: string;
  tty?: boolean;
  env?: Record<string, string>;
}

export interface ImageBuildRequest {
  contextDir: string;
  tag: string;
  buildArgs: Record<string, string>;
}

/** Extra mounts for one-shot helpers that operate on volumes, not the workspace container. */
export interface OneShotOptions {
  mounts?: { source: string; target: string }[];
}

export interface RuntimeEngine {
  readonly name: string;
  /** False until a full live lifecycle has verified the mapping. Surfaced by doctor. */
  readonly verified: boolean;
  readonly capabilities: RuntimeCapabilities;
  readonly doctorProbes: { binary: string; args: string[] };
  readonly displayName: string;
  execVector: (container: string, options: ExecVectorOptions) => ExecSpec;
  containerState: (runner: CommandRunner, container: string, workspaceId: string) => ContainerState;
  /** Runtime name recorded on the container, or null when unreadable. */
  containerRuntime: (runner: CommandRunner, container: string) => string | null;
  volumeExists: (runner: CommandRunner, volume: string) => boolean;  ensureVolume: (runner: CommandRunner, volume: string, workspaceId: string) => void;
  ensureNetwork: (runner: CommandRunner, network: string, workspaceId: string, restricted: boolean) => void;
  containerNetworks: (runner: CommandRunner, container: string) => string[];
  networkInternal: (runner: CommandRunner, network: string) => boolean | null;
  createContainer: (
    runner: CommandRunner,
    entry: { id: string; container: string; root: string },
    options: CreateOptions,
  ) => void;
  startContainer: (runner: CommandRunner, container: string) => void;
  stopContainer: (runner: CommandRunner, container: string) => void;
  removeContainer: (runner: CommandRunner, container: string) => void;
  containerImageId: (runner: CommandRunner, container: string) => string | null;
  referenceImageId: (runner: CommandRunner, image: string) => string | null;
  readReadyJson: (
    runner: CommandRunner,
    container: string,
  ) => { generation: string; fingerprint: string; startedAt: number } | null;
  imageExists: (runner: CommandRunner, image: string) => boolean;
  listManagedContainers: (runner: CommandRunner) => string[];
  /** Local workspace images (repository prefix). Empty when undeterminable. */
  listWorkspaceImages: (runner: CommandRunner) => string[];
  /** Remove one local image. Throws on failure; the caller reports it. */
  removeImage: (runner: CommandRunner, image: string) => void;
  listContainers: (runner: CommandRunner) => string[];
  listVolumes: (runner: CommandRunner) => string[];
  networkExists: (runner: CommandRunner, network: string) => boolean;
  copyVolume: (runner: CommandRunner, source: string, destination: string, workspaceId: string) => void;
  buildImage: (runner: CommandRunner, request: ImageBuildRequest) => string;
  runOneShot: (runner: CommandRunner, image: string, env: Record<string, string>, argv: string[], options?: OneShotOptions) => RunResult;
  copyFromContainer: (runner: CommandRunner, container: string, containerPath: string, hostDir: string) => void;
  copyToContainer: (runner: CommandRunner, container: string, hostDir: string, containerPath: string) => void;
  containerLogs: (runner: CommandRunner, container: string, tail: string) => RunResult;
}

export const DOCKER_CAPABILITIES: RuntimeCapabilities = {
  labels: true,
  internalNetworks: true,
  capDrop: true,
  vectorExec: true,
};

export const DockerRuntimeEngine: RuntimeEngine = {
  name: 'docker',
  verified: true,
  capabilities: DOCKER_CAPABILITIES,
  doctorProbes: { binary: 'docker', args: ['info'] },
  displayName: 'Docker',
  volumeExists: (runner, volume) => {
    const listed = runner.run('docker', ['volume', 'ls', '--filter', `name=^${escapeFilterRegex(volume)}$`, '--format', '{{.Name}}']);
    if (listed.status !== 0) return false;
    return listed.stdout.split('\n').map((line) => line.trim()).includes(volume);
  },
  execVector: (container, options) => {
    const args = ['exec', '-i'];
    if (options.tty !== false) args.push('-t');
    args.push('-u', options.user ?? 'agent');
    for (const [key, value] of Object.entries(options.env ?? {})) args.push('-e', `${key}=${value}`);
    args.push('-w', options.workdir, container, ...options.argv);
    return { command: 'docker', args };
  },
  containerState,
  containerRuntime: (runner, container) => {
    const probed = runner.run('docker', ['inspect', '--format', '{{index .Config.Labels "sandbox.runtime"}}', container]);
    if (probed.status !== 0) return null;
    const value = probed.stdout.trim();
    return value === '<no value>' || value.length === 0 ? null : value;
  },
  ensureVolume,
  ensureNetwork,
  containerNetworks,
  networkInternal,
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
  containerImageId,
  referenceImageId,
  readReadyJson,
  imageExists,
  listManagedContainers,
  listWorkspaceImages,
  removeImage,
  listContainers: (runner) => {
    const listed = runner.run('docker', ['ps', '-a', '--format', '{{.Names}}']);
    if (listed.status !== 0) return [];
    return listed.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  },
  listVolumes: (runner) => {
    const listed = runner.run('docker', ['volume', 'ls', '--format', '{{.Name}}']);
    if (listed.status !== 0) return [];
    return listed.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  },
  networkExists: (runner, network) => {
    const listed = runner.run('docker', ['network', 'ls', '--filter', `name=^${escapeFilterRegex(network)}$`, '--format', '{{.Name}}']);
    return listed.status === 0 && listed.stdout.split('\n').map((line) => line.trim()).includes(network);
  },
  copyVolume: (runner, source, destination, workspaceId) => {
    ensureVolume(runner, destination, workspaceId);
    const result = runner.run('docker', [
      'run', '--rm',
      '-v', `${source}:/from:ro`,
      '-v', `${destination}:/to`,
      'alpine', 'sh', '-c', 'cp -a /from/. /to/',
    ]);
    if (result.status !== 0) throw new Error(`volume copy failed: ${result.stderr.trim()}`);
  },
  buildImage: (runner, request) => {
    const args = ['build', '-f', `${request.contextDir}/Dockerfile`];
    for (const [key, value] of Object.entries(request.buildArgs)) args.push('--build-arg', `${key}=${value}`);
    args.push('-t', request.tag, request.contextDir);
    const result = runner.run('docker', args);
    if (result.status !== 0) {
      const tail = result.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0).slice(-15).join('\n');
      const detail = [result.stderr.trim(), tail].filter((part) => part.length > 0).join('\n');
      throw new Error(`image build failed:\n${detail}`);
    }
    return request.tag;
  },
  runOneShot: (runner, image, env, argv, options) => {
    const args = ['run', '--rm'];
    for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
    for (const mount of options?.mounts ?? []) args.push('-v', `${mount.source}:${mount.target}`);
    args.push(image, ...argv);
    return runner.run('docker', args);
  },
  copyFromContainer: (runner, container, containerPath, hostDir) => {
    const result = runner.run('docker', ['cp', `${container}:${containerPath}`, hostDir]);
    if (result.status !== 0) throw new Error(`backup copy failed: ${result.stderr.trim()}`);
  },
  copyToContainer: (runner, container, hostDir, containerPath) => {
    const result = runner.run('docker', ['cp', hostDir, `${container}:${containerPath}`]);
    if (result.status !== 0) throw new Error(`restore copy failed: ${result.stderr.trim()}`);
  },
  containerLogs: (runner, container, tail) => runner.run('docker', ['logs', '--tail', tail, container]),
};

export { sameImageId };

import { AppleContainerRuntimeEngine } from './apple.js';

export const RUNTIME_ENGINES: Record<string, RuntimeEngine> = {
  docker: DockerRuntimeEngine,
  apple: AppleContainerRuntimeEngine,
};

export function runtimeEngine(name: string): RuntimeEngine {
  const found = RUNTIME_ENGINES[name];
  if (!found) throw new Error(`unknown runtime engine: ${name}`);
  return found;
}

/** Fail closed when the workspace needs more than the runtime provides. */
export function requireCapabilities(engine: RuntimeEngine, needsInternalNetwork: boolean): void {
  if (needsInternalNetwork && !engine.capabilities.internalNetworks) {
    throw new Error(
      `runtime engine ${engine.name} cannot provide restricted networks; choose a capable runtime or open policy`,
    );
  }
}
