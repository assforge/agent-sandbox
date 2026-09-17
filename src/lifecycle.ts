import { checkReadiness, checkRestarted, configurationFingerprint, freshGeneration } from './readiness.js';
import { networkName, sameImageId, type CommandRunner } from './docker.js';
import type { RuntimeEngine } from './engines/runtime.js';
import type { WorkspaceEntry } from './registry.js';

export const CONTAINER_WORKDIR = '/home/agent/work';
export const INSTANCE_HOME_BASE = '/home/agent/instances';

/** Per-instance HOME directory inside the container. */
export function instanceHome(instance: string): string {
  return `${INSTANCE_HOME_BASE}/${instance}`;
}

/** Create the instance HOME before launch so agents land in owned state. */
export function ensureInstanceHome(runner: CommandRunner, container: string, instance: string): void {
  const created = runner.run('docker', ['exec', '-u', 'agent', container, 'mkdir', '-p', instanceHome(instance)]);
  if (created.status !== 0) {
    throw new Error(`cannot prepare instance home for ${instance}: ${created.stderr.trim()}`);
  }
}

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
 *
 * The runtime engine carries every container operation: this function
 * never names docker directly, so a second runtime plugs in without
 * touching orchestration.
 */
export function ensureReady(
  runner: CommandRunner,
  runtime: RuntimeEngine,
  entry: WorkspaceEntry,
  options: EnsureOptions,
): { generation: string; fingerprint: string } {
  let state = runtime.containerState(runner, entry.container, entry.id);
  if (state === 'foreign') {
    throw new Error(`container name is owned by another setup: ${entry.container}; refusing to mutate`);
  }
  const generation = freshGeneration();
  const network = networkName(entry.id);
  const fingerprint = configurationFingerprint([entry.root, entry.image ?? '', options.image, entry.network, ...entry.mounts]);
  const attempts = options.probes ?? 30;
  const interval = options.probeIntervalMs ?? 1000;
  if (state !== 'absent') {
    // A policy switch orphans the attached container: it must go before
    // the network itself can be recreated. The switch was confirmed at
    // configure time and disclosed as a recreate-on-next-start.
    const internal = runtime.networkInternal(runner, network);
    if (internal !== null && internal !== (entry.network === 'restricted')) {
      runtime.removeContainer(runner, entry.container);
      state = 'absent';
    }
  }
  runtime.ensureNetwork(runner, network, entry.id, entry.network === 'restricted');
  if (state !== 'absent') {
    // Cut over by recreating when the image or the network attachment no
    // longer matches the running container.
    const runningId = runtime.containerImageId(runner, entry.container);
    const desiredId = runtime.referenceImageId(runner, options.image);
    const attached = runtime.containerNetworks(runner, entry.container);
    if ((runningId && desiredId && !sameImageId(runningId, desiredId)) || !attached.includes(network)) {
      runtime.removeContainer(runner, entry.container);
      state = 'absent';
    }
  }
  if (state === 'absent') {
    runtime.createContainer(runner, entry, {
      image: options.image,
      workdir: CONTAINER_WORKDIR,
      mounts: entry.mounts.length > 0 ? entry.mounts : [entry.root],
      homeVolume: entry.homeVolume,
      network,
      generation,
      fingerprint,
    });
    for (let i = 0; i < attempts; i += 1) {
      const observed = runtime.readReadyJson(runner, entry.container);
      if (checkReadiness({ generation, fingerprint }, observed, true)) {
        return { generation, fingerprint };
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, interval);
    }
    throw new Error(`container ${entry.container} did not reach readiness; launch no agent`);
  }
  // A running container with the current fingerprint is already ready:
  // only a stopped container must prove a fresh start via its timestamp.
  // The generation token guards creation; after that, the fingerprint
  // binds the container to the current config, and only the entrypoint
  // (rerun on every real start) can write a matching fresh file.
  const wasStopped = state === 'stopped';
  const startEpoch = Math.floor(Date.now() / 1000);
  runtime.startContainer(runner, entry.container);
  for (let i = 0; i < attempts; i += 1) {
    const observed = runtime.readReadyJson(runner, entry.container);
    if (!observed || observed.fingerprint !== fingerprint) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, interval);
      continue;
    }
    if (!wasStopped || checkRestarted(observed, fingerprint, startEpoch)) {
      return { generation, fingerprint };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, interval);
  }
  throw new Error(`container ${entry.container} did not reach readiness; launch no agent`);
}

export function stopWorkspace(runner: CommandRunner, runtime: RuntimeEngine, entry: WorkspaceEntry): void {
  const state = runtime.containerState(runner, entry.container, entry.id);
  if (state === 'absent' || state === 'foreign') return;
  if (state === 'running') runtime.stopContainer(runner, entry.container);
}
