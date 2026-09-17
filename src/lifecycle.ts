import { checkReadiness, checkRestarted, configurationFingerprint, freshGeneration } from './readiness.js';
import {
  containerState,
  createContainer,
  readReadyJson,
  startContainer,
  stopContainer,
  type CommandRunner,
} from './docker.js';
import type { WorkspaceEntry } from './registry.js';

export const CONTAINER_WORKDIR = '/home/agent/work';

export interface EnsureOptions {
  image: string;
  probes?: number;
  probeIntervalMs?: number;
}

/**
 * Bring the workspace container to verified readiness. A fresh container
 * must present the current generation token and fingerprint; a restarted
 * one must present the current fingerprint with a fresh start timestamp
 * (the entrypoint rewrites ready.json on every start). Foreign name
 * owners fail without mutation. A failed startup keeps data but never
 * reports ready and never launches an agent.
 */
export function ensureReady(
  runner: CommandRunner,
  entry: WorkspaceEntry,
  options: EnsureOptions,
): { generation: string; fingerprint: string } {
  const state = containerState(runner, entry.container, entry.id);
  if (state === 'foreign') {
    throw new Error(`container name is owned by another setup: ${entry.container}; refusing to mutate`);
  }
  const generation = freshGeneration();
  const fingerprint = configurationFingerprint([entry.root, entry.image ?? '', options.image, ...entry.mounts]);
  const attempts = options.probes ?? 30;
  const interval = options.probeIntervalMs ?? 1000;
  if (state === 'absent') {
    createContainer(runner, entry, {
      image: options.image,
      workdir: CONTAINER_WORKDIR,
      mounts: entry.mounts.length > 0 ? entry.mounts : [entry.root],
      homeVolume: entry.homeVolume,
      generation,
      fingerprint,
    });
    for (let i = 0; i < attempts; i += 1) {
      const observed = readReadyJson(runner, entry.container);
      if (checkReadiness({ generation, fingerprint }, observed, true)) {
        return { generation, fingerprint };
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, interval);
    }
    throw new Error(`container ${entry.container} did not reach readiness; launch no agent`);
  }
  const startEpoch = Math.floor(Date.now() / 1000);
  startContainer(runner, entry.container);
  for (let i = 0; i < attempts; i += 1) {
    const observed = readReadyJson(runner, entry.container);
    if (checkRestarted(observed, fingerprint, startEpoch)) {
      return { generation, fingerprint };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, interval);
  }
  throw new Error(`container ${entry.container} did not reach readiness; launch no agent`);
}

export function stopWorkspace(runner: CommandRunner, entry: WorkspaceEntry): void {
  const state = containerState(runner, entry.container, entry.id);
  if (state === 'absent' || state === 'foreign') return;
  if (state === 'running') stopContainer(runner, entry.container);
}
