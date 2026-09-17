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
  imageExists,
  listManagedContainers,
  networkInternal,
  readReadyJson,
  referenceImageId,
  removeContainer,
  startContainer,
  stopContainer,
  type CommandRunner,
  type ContainerState,
  type CreateOptions,
} from '../docker.js';

export interface RuntimeCapabilities {
  labels: boolean;
  internalNetworks: boolean;
  capDrop: boolean;
  vectorExec: boolean;
}

export interface RuntimeEngine {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;
  containerState: (runner: CommandRunner, container: string, workspaceId: string) => ContainerState;
  ensureVolume: (runner: CommandRunner, volume: string, workspaceId: string) => void;
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
}

export const DOCKER_CAPABILITIES: RuntimeCapabilities = {
  labels: true,
  internalNetworks: true,
  capDrop: true,
  vectorExec: true,
};

export const DockerRuntimeEngine: RuntimeEngine = {
  name: 'docker',
  capabilities: DOCKER_CAPABILITIES,
  containerState,
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
};

export const RUNTIME_ENGINES: Record<string, RuntimeEngine> = {
  docker: DockerRuntimeEngine,
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
