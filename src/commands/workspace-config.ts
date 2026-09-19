import { acquireLock } from '../lock.js';
import { CliError, type MainDeps } from './deps.js';
import { resolveAndEnsure, selectRuntime, selectTerminal, withRegistry } from './lookup.js';
import { type Registry } from '../registry.js';
import { RUNTIME_ENGINES } from '../engines/runtime.js';
import { TERMINAL_ENGINES } from '../engines/terminal.js';
import { redactedConfig } from '../config.js';
import { defaultCanonicalize } from '../resolve.js';
import { UsageError } from '../cli.js';
import { dropMountFromEntry, vettedMount } from './mounts.js';
import { takeRestOption } from './ui.js';
export async function workspaceConfigure(deps: MainDeps, registry: Registry, rest: string[], workspace: string | undefined): Promise<number> {
  const entry = await resolveAndEnsure(deps, registry, workspace);
  const addMount = takeRestOption(rest, ['--add-mount']);
  const dropMount = takeRestOption(rest, ['--drop-mount']);
  const network = takeRestOption(rest, ['--network']);
  if (network !== undefined && network !== 'open' && network !== 'restricted') {
    throw new UsageError('workspace configure --network must be open or restricted');
  }
  const runtime = takeRestOption(rest, ['--runtime']);
  if (runtime !== undefined && !RUNTIME_ENGINES[runtime]) {
    throw new UsageError(`workspace configure --runtime must be one of: ${Object.keys(RUNTIME_ENGINES).join(', ')}`);
  }
  const terminal = takeRestOption(rest, ['--terminal']);
  if (terminal !== undefined && !TERMINAL_ENGINES[terminal]) {
    throw new UsageError(`workspace configure --terminal must be one of: ${Object.keys(TERMINAL_ENGINES).join(', ')}`);
  }
  if (!addMount && !dropMount && network === undefined && runtime === undefined && terminal === undefined) {
    deps.stdout(`${JSON.stringify(redactedConfig(entry), null, 2)}\n`);
    return 0;
  }
  if (addMount) {
    const canonical = vettedMount(deps, addMount);
    deps.stdout(`plan: add mount ${canonical} to ${entry.id}\n`);
  }
  if (dropMount) deps.stdout(`plan: drop mount ${dropMount} from ${entry.id}\n`);
  if (network !== undefined && network !== entry.network) {
    deps.stdout(`plan: switch network ${entry.network} -> ${network} (recreates the container on next start)\n`);
  }
  if (runtime !== undefined && runtime !== entry.runtime) {
    deps.stdout(`plan: switch runtime ${entry.runtime} -> ${runtime} (stops and removes the old container and kills the session; both are recreated on next start)\n`);
  }
  if (terminal !== undefined && terminal !== entry.terminal) {
    deps.stdout(`plan: switch terminal ${entry.terminal} -> ${terminal} (kills the old session; windows are recreated on next start)\n`);
  }
  const approved = await deps.confirm('apply these changes?');
  if (!approved) throw new CliError('configure cancelled; nothing was changed', 1);
  // A switch migrates nothing, so the previous engine's resources are
  // retired here. The container is owned by the old runtime -- the new
  // one would refuse it as foreign, leaving it unreachable by the CLI --
  // and a window's launch command embeds the old runtime's binary, so a
  // runtime switch invalidates the windows even when the terminal engine
  // does not change. Retiring before the save keeps a failed retirement
  // from recording a switch that never happened.
  //
  // The retirement runs under the workspace lock: without it a
  // concurrent start or launch holding the same lock could have its
  // container yanked mid-flight by this command.
  const handle = acquireLock(deps.lockDir, entry.id);
  try {
    const previousRt = selectRuntime(deps, entry);
    const previousTerm = selectTerminal(deps, entry);
    const runtimeChanges = runtime !== undefined && runtime !== entry.runtime;
    const terminalChanges = terminal !== undefined && terminal !== entry.terminal;
    if (runtimeChanges || terminalChanges) {
      if (runtimeChanges) {
        const state = previousRt.containerState(deps.runner, entry.container, entry.id);
        if (state === 'running') previousRt.stopContainer(deps.runner, entry.container);
        if (state === 'running' || state === 'stopped') previousRt.removeContainer(deps.runner, entry.container);
      }
      if (previousTerm.sessionAlive(deps.runner, entry.session)) previousTerm.killSession(deps.runner, entry.session);
    }
    withRegistry(deps, (live) => {
      const target = live.workspaces[entry.id];
      if (!target) throw new CliError(`workspace is not registered: ${entry.root}`, 1);
      if (addMount) {
        const canonical = defaultCanonicalize(addMount);
        if (!target.mounts.includes(canonical)) target.mounts.push(canonical);
      }
      if (network !== undefined) target.network = network;
      if (runtime !== undefined) target.runtime = runtime;
      if (terminal !== undefined) target.terminal = terminal;
      if (dropMount) dropMountFromEntry(target, dropMount);
    });
  } finally {
    handle.release();
  }
  return 0;
}
export async function workspaceMount(deps: MainDeps, registry: Registry, rest: string[], workspace: string | undefined): Promise<number> {
  const path = rest[0];
  if (!path) throw new UsageError('workspace mount requires <path>');
  const entry = await resolveAndEnsure(deps, registry, workspace);
  const canonical = vettedMount(deps, path);
  if (entry.mounts.includes(canonical)) {
    deps.stdout(`mount ${canonical} is already present on ${entry.id}\n`);
    return 0;
  }
  const approved = await deps.confirm(`add mount ${canonical} to ${entry.id}? Applies on next start.`);
  if (!approved) throw new CliError('mount cancelled; nothing was changed', 1);
  withRegistry(deps, (live) => {
    const target = live.workspaces[entry.id];
    if (!target) throw new CliError(`workspace is not registered: ${entry.root}`, 1);
    if (!target.mounts.includes(canonical)) target.mounts.push(canonical);
  });
  deps.stdout(`mount ${canonical} added to ${entry.id}; applies on next start\n`);
  return 0;
}
export async function workspaceUnmount(deps: MainDeps, registry: Registry, rest: string[], workspace: string | undefined): Promise<number> {
  const path = rest[0];
  if (!path) throw new UsageError('workspace unmount requires <path>');
  const entry = await resolveAndEnsure(deps, registry, workspace);
  // Validated before the prompt so an invalid drop never reaches it. This touches the
  // discarded phase-1 snapshot; the authoritative mutation is the transaction below.
  dropMountFromEntry(entry, path);
  const approved = await deps.confirm(`drop mount ${path} from ${entry.id}? Applies on next start.`);
  if (!approved) throw new CliError('unmount cancelled; nothing was changed', 1);
  withRegistry(deps, (live) => {
    const target = live.workspaces[entry.id];
    if (!target) throw new CliError(`workspace is not registered: ${entry.root}`, 1);
    dropMountFromEntry(target, path);
  });
  deps.stdout(`mount ${path} dropped from ${entry.id}; applies on next start\n`);
  return 0;
}
