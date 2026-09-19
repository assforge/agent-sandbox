import { checkReadiness, checkRestarted, configurationFingerprint, freshGeneration } from './readiness.js';
import { type CommandRunner } from './docker.js';
import { networkName } from './registry.js';
import { requireCapabilities, sameImageId } from './engines/runtime.js';
import type { RuntimeEngine } from './engines/runtime.js';
import type { WorkspaceEntry } from './registry.js';

export const INSTANCE_HOME_BASE = '/home/agent/instances';

/** Workspace home shared by instances in shared mode. */
export const SHARED_HOME = '/home/agent';

/** Agent state directories forked on first launch (caches excluded). */
export const FORK_STATE_DIRS = ['.claude', '.codex', '.copilot', '.config', '.pi'];

/** Per-instance HOME directory inside the container. */
export function instanceHome(instance: string): string {
  return `${INSTANCE_HOME_BASE}/${instance}`;
}

/** HOME for an instance under its mode. Absent mode means shared. */
export function homeDirForInstance(instance: string, homeMode?: string): string {
  if (homeMode !== undefined && homeMode !== 'shared') return instanceHome(instance);
  return SHARED_HOME;
}

/**
 * Create the instance HOME before launch so agents land in owned state.
 * In fork mode the agent state directories are cloned once from the
 * shared home when the instance has none yet; shared mode needs nothing.
 */
export function ensureInstanceHome(
  runner: CommandRunner,
  runtime: RuntimeEngine,
  container: string,
  instance: string,
  homeMode?: string,
): void {
  if (homeMode === undefined || homeMode === 'shared') return;
  const home = instanceHome(instance);
  const mkdir = runtime.execVector(container, { workdir: SHARED_HOME, argv: ['mkdir', '-p', home], user: 'agent', tty: false });
  const made = runner.run(mkdir.command, mkdir.args);
  if (made.status !== 0) {
    throw new Error(`cannot prepare instance home for ${instance}: ${made.stderr.trim()}`);
  }
  if (homeMode === 'fork') {
    const seed = runtime.execVector(container, {
      workdir: SHARED_HOME,
        argv: ['sh', '-c', FORK_STATE_DIRS.map((dir) => `[ -e "${home}/${dir}" ] || { mkdir -p "${home}/${dir}" && cp -a "${SHARED_HOME}/${dir}/." "${home}/${dir}/" 2>/dev/null || true; }`).join('; ')],
      user: 'agent',
      tty: false,
    });
    const seeded = runner.run(seed.command, seed.args);
    if (seeded.status !== 0) {
      throw new Error(`cannot seed instance home for ${instance}: ${seeded.stderr.trim()}`);
    }
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
    // A container owned by another runtime is cut over, not adopted: the
    // runtime switch was confirmed at configure time as recreate-on-start.
    // Anything else foreign is refused without mutation.
    const ownerRuntime = runtime.containerRuntime(runner, entry.container);
    if (ownerRuntime === null || ownerRuntime === runtime.name) {
      throw new Error(`container name is owned by another setup: ${entry.container}; refusing to mutate`);
    }
    runtime.removeContainer(runner, entry.container);
    state = 'absent';
  }
  requireCapabilities(runtime, entry.network === 'restricted');
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
    // Cut over by recreating when the running container no longer matches
    // the configuration it must report. Runtime switches are already
    // refused as foreign by containerState, so image, network, and
    // fingerprint drift recreate here. ready.json is the container's own
    // record of what it was created with, and `entry.mounts` feeds the
    // fingerprint above -- so a mount change recreates instead of leaving
    // a container whose environment the readiness loop below can never
    // match. A container that predates the fingerprint reads as unknown
    // and is left alone, which is the previous behaviour.
    const runningId = runtime.containerImageId(runner, entry.container);
    const desiredId = runtime.referenceImageId(runner, options.image);
    const attached = runtime.containerNetworks(runner, entry.container);
    const recorded = runtime.readReadyJson(runner, entry.container)?.fingerprint;
    if (
      (runningId && desiredId && !sameImageId(runningId, desiredId)) ||
      !attached.includes(network) ||
      (recorded !== undefined && recorded !== fingerprint)
    ) {
      runtime.removeContainer(runner, entry.container);
      state = 'absent';
    }
  }
  function create(): void {
    runtime.createContainer(runner, entry, {
      image: options.image,
      mounts: entry.mounts.length > 0 ? entry.mounts : [entry.root],
      homeVolume: entry.homeVolume,
      network,
      runtimeName: runtime.name,
      generation,
      fingerprint,
    });
  }
  if (state === 'absent') {
    create();
    for (let i = 0; i < attempts; i += 1) {
      const observed = runtime.readReadyJson(runner, entry.container);
      if (checkReadiness({ generation, fingerprint }, observed, true)) {
        return { generation, fingerprint };
      }
      if (!observed && runtime.containerState(runner, entry.container, entry.id) !== 'running') {
        throw new Error(
          `container ${entry.container} exited during startup; inspect it with: sandbox workspace logs`,
        );
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
  let recreated = false;
  for (let i = 0; i < attempts; i += 1) {
    const observed = runtime.readReadyJson(runner, entry.container);
    if (!observed) {
      if (runtime.containerState(runner, entry.container, entry.id) !== 'running') {
        throw new Error(
          `container ${entry.container} exited during startup; inspect it with: sandbox workspace logs`,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, interval);
      continue;
    }
    if (observed.fingerprint !== fingerprint) {
      // A stopped container cannot be exec'd, so drift that happened while
      // it was down is only visible now that it runs again: recreate once
      // instead of waiting out the probes on a file that can never match.
      if (!recreated) {
        recreated = true;
        runtime.removeContainer(runner, entry.container);
        create();
        i = -1;
        continue;
      }
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
