import { acquireLock } from '../lock.js';
import { ensureInstanceHome, ensureReady } from '../lifecycle.js';
import { UsageError } from '../cli.js';
import { agentEngine } from '../engines/agent.js';
import type { RuntimeEngine } from '../engines/runtime.js';
import { resolveWorkspace } from '../resolve.js';
import { CliError, type MainDeps } from './deps.js';
import {
  loadRegistryOrThrow,
  requireImage,
  resolveAndEnsure,
  selectRuntime,
  selectTerminal,
  withRegistry,
} from './lookup.js';
import {
  lookupWorkspace,
  type Registry,
  type WorkspaceEntry,
} from '../registry.js';
import { pruneForks } from './instances.js';
import { agentRegistry, detectGitRoot, refuseIfRestorePending } from './lookup.js';
import { launchEnvFor } from './agents.js';
import { reattachOrHint, takeRestOption } from './ui.js';
export async function workspaceClose(deps: MainDeps, registry: Registry, rest: string[], workspace: string | undefined): Promise<number> {
  const name = rest[0];
  if (!name) throw new UsageError('workspace close requires <instance>');
  if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`);
  const entry = await resolveAndEnsure(deps, registry, workspace);
  const term = selectTerminal(deps, entry);
  const probed = entry.instances.find((item) => item.name === name);
  if (!probed) throw new CliError(`unknown instance: ${name}`, 1);
  const existed = term.windowExists(deps.runner, entry.session, probed.window);
  if (existed) {
    const approved = await deps.confirm(`close instance ${name}? Its window goes away; volumes, credentials, and fork state are kept.`);
    if (!approved) throw new CliError('close cancelled; nothing was changed', 1);
  }
  const handle = acquireLock(deps.lockDir, entry.id);
  try {
    // Read for the race guard and for the window target; the authoritative instance
    // lookup is the transaction below.
    const pre = loadRegistryOrThrow(deps).workspaces[entry.id];
    if (!pre) throw new CliError(`workspace is not registered: ${entry.root}`, 1);
    const instance = pre.instances.find((item) => item.name === name);
    if (!instance) throw new CliError(`unknown instance: ${name}`, 1);
    const existsNow = term.windowExists(deps.runner, pre.session, instance.window);
    if (!existed && existsNow) {
      throw new CliError(`instance ${name} became live; re-run: sandbox workspace close ${name}`, 1);
    }
    // Closed before the claim: closing an already-absent window is the
    // already-closed case, so a crash between the two is repaired by re-running.
    term.closeWindow(deps.runner, pre.session, instance.window);
    withRegistry(deps, (live) => {
      const target = live.workspaces[entry.id];
      if (!target) return;
      target.instances = target.instances.filter((item) => item.name !== name);
    });
    deps.stdout(`closed instance ${name}; fork state kept, prune with: sandbox workspace prune --forks\n`);
    return 0;
  } finally {
    handle.release();
  }
}
export async function workspaceAttach(deps: MainDeps, registry: Registry, workspace: string | undefined): Promise<number> {
  const entry = await resolveAndEnsure(deps, registry, workspace);
  const rt = selectRuntime(deps, entry);
  const term = selectTerminal(deps, entry);
  if (!term.sessionAlive(deps.runner, entry.session)) {
    throw new CliError(`no session for workspace ${entry.id}; run: sandbox workspace start`, 1);
  }
  const state = rt.containerState(deps.runner, entry.container, entry.id);
  if (state !== 'running') {
    deps.stderr(`warning: container ${entry.container} is ${state}; windows will be dead. Run: sandbox workspace start\n`);
  }
  term.reattach(deps.runner, entry.session, deps.insideTerminal);
  return 0;
}
export async function workspaceLogs(deps: MainDeps, registry: Registry, rest: string[], workspace: string | undefined): Promise<number> {
      const entry = await resolveAndEnsure(deps, registry, workspace);
  const rt = selectRuntime(deps, entry);
  const tail = takeRestOption(rest, ['--tail', '-t']) ?? '50';
  if (!/^\d+$/.test(tail)) throw new UsageError('workspace logs --tail must be a number');
  const state = rt.containerState(deps.runner, entry.container, entry.id);
  if (state === 'absent' || state === 'foreign') {
    throw new CliError(`no container for workspace ${entry.id}; run: sandbox workspace start`, 1);
  }
  const result = rt.containerLogs(deps.runner, entry.container, tail);
  if (result.stdout) deps.stdout(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) deps.stderr(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  return result.status;
}
export async function workspaceReopen(deps: MainDeps, registry: Registry, rest: string[], workspace: string | undefined): Promise<number> {
  const entry = await resolveAndEnsure(deps, registry, workspace);
  const rt = selectRuntime(deps, entry);
  const term = selectTerminal(deps, entry);
  const noAttach = rest.includes('--no-attach');
  const handle = acquireLock(deps.lockDir, entry.id);
  try {
    ensureReady(deps.runner, rt, entry, { image: requireImage(entry) });
    if (entry.instances.length === 0) {
      term.openAgentWindow(deps.runner, entry.session, 'shell', rt.execVector(entry.container, { workdir: entry.root, argv: ['bash'], env: launchEnvFor(deps, entry, 'shell') }), entry.root);
      deps.stdout('reopened shell window (no instances registered)\n');
    }
    const agents = agentRegistry(deps);
    for (const instance of entry.instances) {
      let launchArgv: string[];
      if (instance.kind === 'shell') {
        launchArgv = ['bash'];
      } else {
        try {
          launchArgv = agentEngine(agents, instance.kind).launch;
        } catch {
          deps.stdout(`skip window ${instance.name}: unknown agent kind ${instance.kind}\n`);
          continue;
        }
      }
      const launch = rt.execVector(entry.container, { workdir: entry.root, argv: launchArgv, env: launchEnvFor(deps, entry, instance.name, instance.homeMode) });
      ensureInstanceHome(deps.runner, rt, entry.container, instance.name, instance.homeMode);
      const outcome = term.openAgentWindow(deps.runner, entry.session, instance.window, launch, entry.root);
      deps.stdout(`${outcome} window ${instance.name} (${instance.kind})\n`);
    }
  } finally {
    handle.release();
  }
  if (!noAttach) reattachOrHint(deps, term, entry.session);
  return 0;
}
export async function workspaceExec(deps: MainDeps, registry: Registry, rest: string[], workspace: string | undefined): Promise<number> {
  const entry = await resolveAndEnsure(deps, registry, workspace);
  const rt = selectRuntime(deps, entry);
  const separator = rest.indexOf('--');
  const command = separator >= 0 ? rest.slice(separator + 1) : rest;
  if (command.length === 0) throw new UsageError('workspace exec requires -- <command>');
  const handle = acquireLock(deps.lockDir, entry.id);
  try {
    ensureReady(deps.runner, rt, entry, { image: requireImage(entry) });
    const spec = rt.execVector(entry.container, { workdir: entry.root, argv: command, tty: deps.stdinIsTTY });
    const result = deps.runner.run(spec.command, spec.args);
    if (result.stdout) deps.stdout(result.stdout);
    if (result.stderr) deps.stderr(result.stderr);
    return result.status;
  } finally {
    handle.release();
  }
}
export async function workspacePrune(deps: MainDeps, registry: Registry, rest: string[], workspace: string | undefined): Promise<number> {
  const every = rest.includes('--all');
  const forksOnly = rest.includes('--forks');
  const leftover = rest.filter((arg) => arg !== '--all' && arg !== '--forks');
  if (leftover.length > 0) throw new UsageError(`unexpected argument: ${leftover[0]}`);
  const targets: WorkspaceEntry[] = [];
  if (every) {
    targets.push(...Object.values(registry.workspaces));
  } else {
    const resolution = resolveWorkspace({
      explicitRoot: workspace,
      cwd: deps.cwd,
      registry,
      gitRoot: workspace === undefined ? detectGitRoot(deps) : null,
    });
    const entry = lookupWorkspace(registry, resolution.root);
    if (!entry) throw new CliError(`no registered workspace in scope: ${resolution.root}`, 1);
    targets.push(entry);
  }
  if (forksOnly) return pruneForks(deps, targets);
  const stopped: { entry: WorkspaceEntry; rt: RuntimeEngine }[] = [];
  for (const entry of targets) {
    // Refused before the prompt, so a frozen workspace is never asked about.
    refuseIfRestorePending(entry);
    const rt = selectRuntime(deps, entry);
    if (rt.containerState(deps.runner, entry.container, entry.id) === 'stopped') stopped.push({ entry, rt });
  }
  if (stopped.length === 0) {
    deps.stdout('no stopped workspace containers to prune\n');
    return 0;
  }
  const names = stopped.map((item) => item.entry.container).join(', ');
  const approved = await deps.confirm(`remove ${stopped.length} stopped container(s): ${names}? Volumes, networks, images, and the registry are kept.`);
  if (!approved) throw new CliError('prune cancelled; nothing was changed', 1);
  for (const item of stopped) {
    const handle = acquireLock(deps.lockDir, item.entry.id);
    try {
      // Authoritative re-check under the lock, before the removal below.
      const locked = loadRegistryOrThrow(deps).workspaces[item.entry.id];
      if (locked) refuseIfRestorePending(locked);
      item.rt.removeContainer(deps.runner, item.entry.container);
    } finally {
      handle.release();
    }
  }
  deps.stdout(`pruned ${names}; volumes, networks, images, and the registry kept\n`);
  return 0;
}
