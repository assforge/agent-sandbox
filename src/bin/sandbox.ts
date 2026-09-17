#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { agentEngine, agentEngines, outdatedEngines } from '../engines/agent.js';
import { backupWorkspace, restoreWorkspace } from '../backup.js';
import { normalizeLexical, redactedConfig, rejectForbiddenMount } from '../config.js';
import {
  assertInstanceName,
  clearCredentials,
  listCredentialInstances,
  loadCredentials,
  redactEnv,
  setCredentials,
} from '../credentials.js';
import { parseArgs, UsageError } from '../cli.js';
import {
  networkName,
  type CommandRunner,
  type RunResult,
} from '../docker.js';
import { runtimeEngine } from '../engines/runtime.js';
import { terminalEngine } from '../engines/terminal.js';
import { buildCandidate, activateImage, rollbackImage } from '../image.js';
import { acquireLock } from '../lock.js';
import { CONTAINER_WORKDIR, ensureInstanceHome, ensureReady, instanceHome, stopWorkspace } from '../lifecycle.js';
import { dryRunMigration } from '../migrate.js';
import {
  defaultRegistryPath,
  loadRegistry,
  lookupWorkspace,
  registerWorkspace,
  saveRegistry,
  type Registry,
  type WorkspaceEntry,
} from '../registry.js';
import { defaultCanonicalize, resolveWorkspace } from '../resolve.js';
import { dockerExec } from '../session.js';
import { assertWindowName } from '../terminal.js';
import { doctorExitCode, renderDoctorJson, renderDoctorText, runDoctor } from '../doctor.js';
import { agentHelp, credentialsHelp, imageHelp, topHelp, workspaceHelp } from '../help.js';

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

// Engine selection is hardcoded to the verified engines in slice 1.
// Host-level selection with per-workspace override arrives in slice 3;
// the call sites below already speak only the interfaces.
const rt = runtimeEngine('docker');
const term = terminalEngine('tmux');
const agents = agentEngines();

export interface MainDeps {
  cwd: string;
  homeDir: string;
  lockDir: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  pathLookup: (name: string) => string | null;
  commandSucceeds: (command: string, args: string[]) => boolean;
  runner: CommandRunner;
  insideTmux: boolean;
  stdinIsTTY: boolean;
  assumeYes: boolean;
  confirm: (question: string) => Promise<boolean>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function toRunResult(error: unknown): RunResult {
  const record = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
  const text = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value instanceof Buffer) return value.toString('utf8');
    return '';
  };
  return {
    status: typeof record.status === 'number' ? record.status : 1,
    stdout: text(record.stdout),
    stderr: text(record.stderr),
  };
}

export function realRunner(): CommandRunner {
  return {
    run: (command: string, args: string[]): RunResult => {
      try {
        const stdout = execFileSync(command, args, { encoding: 'utf8', timeout: 120000 });
        return { status: 0, stdout, stderr: '' };
      } catch (error) {
        return toRunResult(error);
      }
    },
  };
}

export function realDeps(assumeYes: boolean): MainDeps {
  const runner = realRunner();
  return {
    cwd: process.cwd(),
    homeDir: homedir(),
    lockDir: `${homedir()}/.sandbox/locks`,
    platform: process.platform,
    nodeVersion: process.version,
    pathLookup: (name: string): string | null => {
      const pathValue = process.env['PATH'] ?? '';
      for (const dir of pathValue.split(':')) {
        const candidate = `${dir}/${name}`;
        try {
          if (existsSync(candidate)) return candidate;
        } catch {
          continue;
        }
      }
      return null;
    },
    commandSucceeds: (command: string, args: string[]): boolean => {
      try {
        execFileSync(command, args, { stdio: 'ignore', timeout: 10000 });
        return true;
      } catch {
        return false;
      }
    },
    runner,
    insideTmux: process.env['TMUX'] !== undefined && process.env['TMUX'] !== '',
    stdinIsTTY: process.stdin.isTTY ?? false,
    assumeYes,
    confirm: async (question: string): Promise<boolean> => {
      if (assumeYes) return true;
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
        return answer.trim().toLowerCase() === 'y';
      } finally {
        rl.close();
      }
    },
    stdout: (text: string): void => {
      process.stdout.write(text);
    },
    stderr: (text: string): void => {
      process.stderr.write(text);
    },
  };
}

/** Single source of truth: the package manifest next to dist/. */
function packageVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error('package.json has no version string');
  return parsed.version;
}

function registryPathOf(deps: MainDeps): string {
  return defaultRegistryPath(deps.homeDir);
}

function loadRegistryOrThrow(deps: MainDeps): Registry {
  try {
    return loadRegistry(registryPathOf(deps));
  } catch (error) {
    throw new CliError(`cannot read registry: ${(error as Error).message}`, 2);
  }
}

function detectGitRoot(deps: MainDeps): string | null {
  const probed = deps.runner.run('git', ['-C', deps.cwd, 'rev-parse', '--show-toplevel']);
  if (probed.status !== 0) return null;
  const root = probed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)[0];
  return root ?? null;
}

async function resolveAndEnsure(
  deps: MainDeps,
  registry: Registry,
  explicitRoot: string | undefined,
): Promise<WorkspaceEntry> {
  const gitRoot = explicitRoot === undefined ? detectGitRoot(deps) : null;
  const resolution = resolveWorkspace({ explicitRoot, cwd: deps.cwd, registry, gitRoot });
  const existing = lookupWorkspace(registry, resolution.root);
  if (existing) return existing;
  deps.stdout(`workspace is not registered:\n  root: ${resolution.root}\n`);
  deps.stdout(`plan: register root, create container and host tmux session on first start.\n`);
  const approved = await deps.confirm('approve this workspace scope?');
  if (!approved) throw new CliError('workspace scope was not approved; nothing was changed', 1);
  const canonical = defaultCanonicalize(resolution.root);
  for (const mount of [canonical]) {
    const problem = rejectForbiddenMount(mount, deps.homeDir);
    if (problem) throw new CliError(`refused mount ${mount}: ${problem}`, 2);
  }
  const entry = registerWorkspace(registry, canonical, [canonical], { homeDir: deps.homeDir });
  saveRegistry(registryPathOf(deps), registry);
  return entry;
}

function requireImage(entry: WorkspaceEntry): string {
  if (!entry.image) {
    throw new CliError(`no image selected for workspace ${entry.id}; run: sandbox image build`, 1);
  }
  return entry.image;
}

/**
 * Per-instance launch environment: stored credentials plus a dedicated
 * HOME so agent configuration and history do not cross instances.
 * HOME wins over any stored HOME key: the instance directory is the
 * isolation mechanism, not a suggestion.
 */
function launchEnvFor(deps: MainDeps, entry: WorkspaceEntry, instance: string): Record<string, string> {
  const stored = loadCredentials(deps.homeDir, entry.id, instance) ?? {};
  return { ...stored, HOME: instanceHome(instance) };
}

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  try {
    return await dispatch(argv, deps);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`error: ${error.message}\nRun sandbox --help for usage.\n`);
      return error.exitCode;
    }
    if (error instanceof CliError) {
      deps.stderr(`error: ${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

async function dispatch(argv: string[], deps: MainDeps): Promise<number> {
  const parsed = parseArgs(argv);
  switch (parsed.kind) {
    case 'help':
      deps.stdout(topHelp());
      return 0;
    case 'version':
      deps.stdout(`sandbox ${packageVersion()}\n`);
      return 0;
    case 'doctor': {
      const registry = loadRegistryOrThrow(deps);
      const resolution = resolveWorkspace({ explicitRoot: parsed.workspace, cwd: deps.cwd, registry });
      const current = resolution.registered ? lookupWorkspace(registry, resolution.root) : null;
      const network = current ? networkName(current.id) : '';
      const networkListed = current
        ? deps.runner.run('docker', ['network', 'ls', '--filter', `name=^${network}$`, '--format', '{{.Name}}'])
        : null;
      const networkExists =
        networkListed !== null &&
        networkListed.status === 0 &&
        networkListed.stdout.split('\n').map((line) => line.trim()).includes(network);
      const deadWindows = current ? deadRosterWindows(deps, current) : [];
      const checks = runDoctor(
        {
          nodeVersion: deps.nodeVersion,
          pathLookup: deps.pathLookup,
          commandSucceeds: deps.commandSucceeds,
          platform: deps.platform,
        },
        { image: current?.image ?? null, network: current ? current.network : null, networkExists, deadWindows },
      );
      deps.stdout(parsed.json ? renderDoctorJson(checks) : renderDoctorText(checks));
      return doctorExitCode(checks);
    }
    case 'bare':
    case 'shell': {
      const name = parsed.kind === 'shell' ? (parsed.name ?? 'shell') : 'shell';
      try {
        assertWindowName(name);
      } catch (error) {
        throw new CliError((error as Error).message, 2);
      }
      const registry = loadRegistryOrThrow(deps);
      const entry = await resolveAndEnsure(deps, registry, parsed.workspace);
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        ensureReady(deps.runner, rt, entry, { image: requireImage(entry) });
        if (!entry.instances.some((item) => item.name === name)) {
          entry.instances.push({ name, kind: 'shell', window: name });
          saveRegistry(registryPathOf(deps), registry);
        }
        const launchEnv = launchEnvFor(deps, entry, name);
        ensureInstanceHome(deps.runner, entry.container, name);
        term.openAgentWindow(deps.runner, entry.session, name, dockerExec(entry.container, CONTAINER_WORKDIR, ['bash'], 'agent', true, launchEnv), entry.root);
      } finally {
        handle.release();
      }
      if (!parsed.noAttach) term.reattach(deps.runner, entry.session, deps.insideTmux);
      return 0;
    }
    case 'agent': {
      const def = agentEngine(agents, parsed.agent);
      const name = parsed.name ?? parsed.agent;
      try {
        assertWindowName(name);
      } catch (error) {
        throw new CliError((error as Error).message, 2);
      }
      const registry = loadRegistryOrThrow(deps);
      const entry = await resolveAndEnsure(deps, registry, parsed.workspace);
      const same = entry.instances.find((item) => item.name === name);
      if (same && same.kind !== parsed.agent) {
        throw new CliError(`instance name is occupied by another agent: ${name} runs ${same.kind}`, 1);
      }
      // The lock covers preparation only: reattach blocks for the life of
      // the session and must never hold the workspace lock.
      const handle = acquireLock(deps.lockDir, entry.id);
      let launched: string;
      try {
        ensureReady(deps.runner, rt, entry, { image: requireImage(entry) });
        if (!same) {
          entry.instances.push({ name, kind: parsed.agent, window: name });
          saveRegistry(registryPathOf(deps), registry);
        }
        const launchEnv = launchEnvFor(deps, entry, name);
        ensureInstanceHome(deps.runner, entry.container, name);
        launched = term.openAgentWindow(
          deps.runner,
          entry.session,
          name,
          dockerExec(entry.container, CONTAINER_WORKDIR, [...def.launch, ...parsed.forwarded], 'agent', true, launchEnv),
          entry.root,
        );
      } finally {
        handle.release();
      }
      deps.stdout(`${launched} window ${name} (${parsed.agent}) in session ${entry.session}\n`);
      if (!parsed.noAttach) term.reattach(deps.runner, entry.session, deps.insideTmux);
      return 0;
    }
    case 'workspace':
      return workspaceCommand(deps, parsed.action, parsed.rest, parsed.workspace);
    case 'register': {
      const registry = loadRegistryOrThrow(deps);
      const raw = parsed.root ?? deps.cwd;
      if (!existsSync(raw)) {
        throw new CliError(`workspace root does not exist: ${raw}`, 2);
      }
      const canonical = defaultCanonicalize(raw);
      const entry = registerWorkspace(registry, canonical, [canonical], { homeDir: deps.homeDir });
      saveRegistry(registryPathOf(deps), registry);
      deps.stdout(`registered ${entry.id} for ${canonical}\n`);
      return 0;
    }
    case 'unregister': {
      const registry = loadRegistryOrThrow(deps);
      const raw = parsed.root ?? deps.cwd;
      const root = defaultCanonicalize(raw);
      return unregisterWorkspace(deps, registry, root);
    }
    case 'agentAdmin':
      return agentCommand(deps, parsed.action, parsed.rest);
    case 'credentials':
      return credentialsCommand(deps, parsed.action, parsed.rest, parsed.workspace);
    case 'image':
      return imageCommand(deps, parsed.action, parsed.rest, parsed.workspace);
  }
}

function takeRestOption(rest: string[], names: string[]): string | undefined {
  const index = rest.findIndex((arg) => names.includes(arg));
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (!value || value.startsWith('-')) throw new UsageError(`option ${rest[index]} requires a value`);
  return value;
}

/** Remove a workspace registration. Stops the container and kills the
 * session after confirmation when anything is live. Volumes, networks,
 * images, and credential files are always kept: unregister forgets the
 * mapping, it never purges data. */
async function unregisterWorkspace(deps: MainDeps, registry: Registry, root: string): Promise<number> {
  const entry = lookupWorkspace(registry, root);
  if (!entry) {
    throw new CliError(`workspace is not registered: ${root}`, 1);
  }
  let state = rt.containerState(deps.runner, entry.container, entry.id);
  const alive = term.sessionAlive(deps.runner, entry.session);
  const live = state === 'running' || alive || entry.instances.length > 0;
  if (live) {
    const approved = await deps.confirm(
      `unregister ${entry.id}? This stops its container and kills its tmux session. Volumes, networks, images, and credentials are kept.`,
    );
    if (!approved) throw new CliError('unregister cancelled; nothing was changed', 1);
  }
  const handle = acquireLock(deps.lockDir, entry.id);
  try {
    if (state === 'running') {
      stopWorkspace(deps.runner, rt, entry);
      state = 'stopped';
    }
    if (state === 'stopped') rt.removeContainer(deps.runner, entry.container);
    if (term.sessionAlive(deps.runner, entry.session)) term.killSession(deps.runner, entry.session);
    delete registry.workspaces[entry.id];
    saveRegistry(registryPathOf(deps), registry);
    deps.stdout(`unregistered ${entry.id}; volumes, networks, images, and credentials kept\n`);
    return 0;
  } finally {
    handle.release();
  }
}/** Roster windows with no live pane. Empty when the session is absent. */
function deadRosterWindows(deps: MainDeps, entry: WorkspaceEntry): string[] {
  if (!term.sessionAlive(deps.runner, entry.session)) return [];
  const dead: string[] = [];
  for (const instance of entry.instances) {
    if (!term.paneAlive(deps.runner, entry.session, instance.window)) dead.push(instance.window);
  }
  return dead;
}

/** Read the workspace id from a backup manifest without touching the registry. */function peekBackupId(outputDir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(outputDir, 'workspace.json'), 'utf8')) as { id?: unknown };
    if (typeof parsed.id !== 'string' || !parsed.id) throw new Error('bad id');
    return parsed.id;
  } catch {
    throw new CliError(`backup is missing or invalid: ${join(outputDir, 'workspace.json')}`, 1);
  }
}

async function workspaceCommand(deps: MainDeps, action: string, rest: string[], workspace: string | undefined): Promise<number> {
  const registry = loadRegistryOrThrow(deps);
  switch (action) {
    case 'help':
      deps.stdout(workspaceHelp());
      return 0;
    case 'list': {
      const entries = Object.values(registry.workspaces);
      if (rest.includes('--json')) {
        deps.stdout(`${JSON.stringify({ workspaces: entries.map((entry) => redactedConfig(entry)) }, null, 2)}\n`);
        return 0;
      }
      if (entries.length === 0) {
        deps.stdout('no workspaces registered\n');
        return 0;
      }
      for (const entry of entries) {
        deps.stdout(`${entry.id}\n  root: ${entry.root}\n  container: ${entry.container}\n  image: ${entry.image ?? '(none)'}\n`);
      }
      return 0;
    }
    case 'status': {
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const state = rt.containerState(deps.runner, entry.container, entry.id);
      const alive = term.sessionAlive(deps.runner, entry.session);
      const windows = alive
        ? deps.runner.run('tmux', ['list-windows', '-t', entry.session, '-F', '#{window_name}']).stdout.split('\n').map((line) => line.trim())
        : [];
      const describe = (name: string, kind: string): string => {
        if (!alive) return `${name}(${kind}, session absent)`;
        return windows.includes(name) ? `${name}(${kind})` : `${name}(${kind}, window missing)`;
      };
      if (rest.includes('--json')) {
        deps.stdout(`${JSON.stringify({ id: entry.id, container: state, session: alive, instances: entry.instances.map((i) => ({ name: i.name, kind: i.kind, window: windows.includes(i.window) })) }, null, 2)}\n`);
        return 0;
      }
      deps.stdout(`workspace ${entry.id}\n  container: ${state}\n  session: ${alive ? 'alive' : 'absent'}\n  instances: ${entry.instances.map((i) => describe(i.name, i.kind)).join(', ') || '(none)'}\n`);
      return 0;
    }
    case 'register': {
      const root = takeRestOption(rest, ['--root']);
      if (!root) throw new UsageError('workspace register requires --root <path>');
      if (!existsSync(root)) {
        throw new CliError(`workspace root does not exist: ${root}`, 2);
      }
      const canonical = defaultCanonicalize(root);
      const entry = registerWorkspace(registry, canonical, [canonical], { homeDir: deps.homeDir });
      saveRegistry(registryPathOf(deps), registry);
      deps.stdout(`registered ${entry.id} for ${canonical}\n`);
      return 0;
    }
    case 'unregister': {
      const root = workspace ? defaultCanonicalize(workspace) : defaultCanonicalize(deps.cwd);
      return unregisterWorkspace(deps, registry, root);
    }
    case 'start': {
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        ensureReady(deps.runner, rt, entry, { image: requireImage(entry) });
        deps.stdout(`workspace ${entry.id} ready (container ${entry.container})\n`);
        return 0;
      } finally {
        handle.release();
      }
    }
    case 'stop': {
      const entry = await resolveAndEnsure(deps, registry, workspace);
      if (entry.instances.length > 0) {
        const approved = await deps.confirm(`${entry.instances.length} live instances will be interrupted. Stop?`);
        if (!approved) throw new CliError('stop cancelled; nothing was changed', 1);
      }
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        stopWorkspace(deps.runner, rt, entry);
        deps.stdout(`workspace ${entry.id} stopped; volumes kept\n`);
        return 0;
      } finally {
        handle.release();
      }
    }
    case 'attach': {
      const entry = await resolveAndEnsure(deps, registry, workspace);
      if (!term.sessionAlive(deps.runner, entry.session)) {
        throw new CliError(`no session for workspace ${entry.id}; run: sandbox workspace start`, 1);
      }
      const state = rt.containerState(deps.runner, entry.container, entry.id);
      if (state !== 'running') {
        deps.stderr(`warning: container ${entry.container} is ${state}; windows will be dead. Run: sandbox workspace start\n`);
      }
      term.reattach(deps.runner, entry.session, deps.insideTmux);
      return 0;
    }
    case 'logs': {      const entry = await resolveAndEnsure(deps, registry, workspace);
      const tail = takeRestOption(rest, ['--tail']) ?? '50';
      if (!/^\d+$/.test(tail)) throw new UsageError('workspace logs --tail must be a number');
      const state = rt.containerState(deps.runner, entry.container, entry.id);
      if (state === 'absent' || state === 'foreign') {
        throw new CliError(`no container for workspace ${entry.id}; run: sandbox workspace start`, 1);
      }
      const result = deps.runner.run('docker', ['logs', '--tail', tail, entry.container]);
      if (result.stdout) deps.stdout(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
      if (result.stderr) deps.stderr(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
      return result.status;
    }
    case 'reopen': {
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const noAttach = rest.includes('--no-attach');
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        ensureReady(deps.runner, rt, entry, { image: requireImage(entry) });
        if (entry.instances.length === 0) {
          term.openAgentWindow(deps.runner, entry.session, 'shell', dockerExec(entry.container, CONTAINER_WORKDIR, ['bash'], 'agent', true, launchEnvFor(deps, entry, 'shell')), entry.root);
          deps.stdout('reopened shell window (no instances registered)\n');
        }
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
          const launch = dockerExec(entry.container, CONTAINER_WORKDIR, launchArgv, 'agent', true, launchEnvFor(deps, entry, instance.name));
          ensureInstanceHome(deps.runner, entry.container, instance.name);
          const outcome = term.openAgentWindow(deps.runner, entry.session, instance.window, launch, entry.root);
          deps.stdout(`${outcome} window ${instance.name} (${instance.kind})\n`);
        }
      } finally {
        handle.release();
      }
      if (!noAttach) term.reattach(deps.runner, entry.session, deps.insideTmux);
      return 0;
    }
    case 'exec': {
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const separator = rest.indexOf('--');
      const command = separator >= 0 ? rest.slice(separator + 1) : rest;
      if (command.length === 0) throw new UsageError('workspace exec requires -- <command>');
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        ensureReady(deps.runner, rt, entry, { image: requireImage(entry) });
        const spec = dockerExec(entry.container, CONTAINER_WORKDIR, command, 'agent', deps.stdinIsTTY);
        const result = deps.runner.run(spec.command, spec.args);
        if (result.stdout) deps.stdout(result.stdout);
        if (result.stderr) deps.stderr(result.stderr);
        return result.status;
      } finally {
        handle.release();
      }
    }
    case 'configure': {
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const addMount = takeRestOption(rest, ['--add-mount']);
      const dropMount = takeRestOption(rest, ['--drop-mount']);
      const network = takeRestOption(rest, ['--network']);
      if (network !== undefined && network !== 'open' && network !== 'restricted') {
        throw new UsageError('workspace configure --network must be open or restricted');
      }
      if (!addMount && !dropMount && network === undefined) {
        deps.stdout(`${JSON.stringify(redactedConfig(entry), null, 2)}\n`);
        return 0;
      }
      if (addMount) {
        const canonical = defaultCanonicalize(addMount);
        const problem = rejectForbiddenMount(canonical, deps.homeDir);
        if (problem) throw new CliError(`refused mount ${canonical}: ${problem}`, 2);
        deps.stdout(`plan: add mount ${canonical} to ${entry.id}\n`);
      }
      if (dropMount) deps.stdout(`plan: drop mount ${dropMount} from ${entry.id}\n`);
      if (network !== undefined && network !== entry.network) {
        deps.stdout(`plan: switch network ${entry.network} -> ${network} (recreates the container on next start)\n`);
      }
      const approved = await deps.confirm('apply these changes?');
      if (!approved) throw new CliError('configure cancelled; nothing was changed', 1);
      if (addMount && !entry.mounts.includes(defaultCanonicalize(addMount))) entry.mounts.push(defaultCanonicalize(addMount));
      if (network !== undefined) entry.network = network;
      if (dropMount) {
        const canonicalDrop = defaultCanonicalize(dropMount);
        if (normalizeLexical(canonicalDrop) === normalizeLexical(entry.root)) {
          throw new CliError(`cannot drop the workspace root mount: ${entry.root}`, 2);
        }
        entry.mounts = entry.mounts.filter((mount) => normalizeLexical(mount) !== normalizeLexical(canonicalDrop));
      }
      saveRegistry(registryPathOf(deps), registry);
      return 0;
    }
    case 'backup': {
      const output = takeRestOption(rest, ['--output']);
      if (!output) throw new UsageError('workspace backup requires --output <path>');      const entry = await resolveAndEnsure(deps, registry, workspace);
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        const receipt = backupWorkspace(
          {
            copyFromContainer: (container, from, to) => {
              const result = deps.runner.run('docker', ['cp', `${container}:${from}`, to]);
              if (result.status !== 0) throw new CliError(`backup copy failed: ${result.stderr.trim()}`, 1);
            },
            copyToContainer: (container, from, to) => {
              const result = deps.runner.run('docker', ['cp', from, `${container}:${to}`]);
              if (result.status !== 0) throw new CliError(`restore copy failed: ${result.stderr.trim()}`, 1);
            },
          },
          entry,
          output,
        );
        deps.stdout(`backup of ${receipt.workspace} written to ${receipt.outputDir}\n`);
        return 0;
      } finally {
        handle.release();
      }
    }
    case 'restore': {
      const input = takeRestOption(rest, ['--input']);
      if (!input) throw new UsageError('workspace restore requires --input <path>');
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const manifestId = peekBackupId(input);
      if (manifestId !== entry.id) {
        throw new CliError(`backup belongs to ${manifestId}, not to ${entry.id}; nothing was changed`, 1);
      }
      const approved = await deps.confirm(`restore ${entry.id} from ${input}? Running state will be overwritten.`);
      if (!approved) throw new CliError('restore cancelled; nothing was changed', 1);
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        const restored = restoreWorkspace(          {
            copyFromContainer: (container, from, to) => {
              const result = deps.runner.run('docker', ['cp', `${container}:${from}`, to]);
              if (result.status !== 0) throw new CliError(`backup copy failed: ${result.stderr.trim()}`, 1);
            },
            copyToContainer: (container, from, to) => {
              const result = deps.runner.run('docker', ['cp', from, `${container}:${to}`]);
              if (result.status !== 0) throw new CliError(`restore copy failed: ${result.stderr.trim()}`, 1);
            },
          },
          registry,
          input,
        );
        if (restored.id !== entry.id) {
          throw new CliError(`backup identity changed during restore; nothing was saved`, 1);
        }
        saveRegistry(registryPathOf(deps), registry);
        deps.stdout(`restored ${restored.id} from ${input}; restart the workspace to cut over\n`);
        return 0;
      } finally {
        handle.release();
      }
    }
    case 'migrate': {
      const source = takeRestOption(rest, ['--source']);
      if (source !== 'claude-relay') throw new UsageError('workspace migrate requires --source claude-relay');
      const apply = rest.includes('--apply');
      const listed = deps.runner.run('docker', ['ps', '-a', '--format', '{{.Names}}']);
      const volumes = deps.runner.run('docker', ['volume', 'ls', '--format', '{{.Name}}']);
      const sessions = deps.runner.run('tmux', ['list-sessions', '-F', '#{session_name}']);
      const existing = [
        ...listed.stdout.split('\n').map((n) => n.trim()).filter(Boolean).map((name) => ({ kind: 'container' as const, name })),
        ...volumes.stdout.split('\n').map((n) => n.trim()).filter(Boolean).map((name) => ({ kind: 'volume' as const, name })),
        ...(sessions.status === 0 ? sessions.stdout.split('\n').map((n) => n.trim()).filter(Boolean).map((name) => ({ kind: 'session' as const, name })) : []),
      ];
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const plan = dryRunMigration(existing, entry.id);
      deps.stdout(`dry-run: ${plan.mappings.length} legacy resources mapped, originals retained\n`);
      for (const mapping of plan.mappings) {
        deps.stdout(`  ${mapping.legacy.kind} ${mapping.legacy.name} -> ${mapping.destination}${mapping.copiesState ? ' (state)' : ''}\n`);
      }
      if (!apply) return 0;
      const approved = await deps.confirm('copy approved agent state and interrupt writers?');
      if (!approved) throw new CliError('migrate cancelled; nothing was changed', 1);
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        let copied = 0;
        for (const mapping of plan.mappings) {
          if (!mapping.copiesState || mapping.legacy.kind !== 'volume') continue;
          rt.ensureVolume(deps.runner, mapping.destination, entry.id);
          const result = deps.runner.run('docker', [
            'run', '--rm',
            '-v', `${mapping.legacy.name}:/from:ro`,
            '-v', `${mapping.destination}:/to`,
            'alpine', 'sh', '-c', 'cp -a /from/. /to/',
          ]);
          if (result.status !== 0) {
            throw new CliError(`migrate copy failed for ${mapping.legacy.name}: ${result.stderr.trim()}`, 1);
          }
          copied += 1;
        }
        deps.stdout(`migrate apply complete: ${copied} state volumes copied; originals retained for recovery\n`);
        return 0;
      } finally {
        handle.release();
      }
    }
    default:
      throw new UsageError(`unknown workspace action: ${action}`);
  }
}

async function agentCommand(deps: MainDeps, action: string, rest: string[]): Promise<number> {
  switch (action) {
    case 'help':
      deps.stdout(agentHelp());
      return 0;
    case 'list': {
      const listed = [...agents.values()].map((engine) => {
        const spec = engine.installSpec();
        return { name: engine.name, npmPackage: spec.npmPackage, pinnedVersion: spec.pinnedVersion, statePaths: engine.statePaths, launch: engine.launch };
      });
      if (rest.includes('--json')) {
        deps.stdout(`${JSON.stringify({ agents: listed }, null, 2)}\n`);
        return 0;
      }
      for (const item of listed) {
        deps.stdout(`${item.name}: ${item.npmPackage ?? 'native'}@${item.pinnedVersion ?? 'native'}\n`);
      }
      return 0;
    }
    case 'outdated': {
      const entries = outdatedEngines({
        installedVersion: (pkg) => {
          const result = deps.runner.run('npm', ['ls', '-g', pkg, '--depth=0', '--json']);
          if (result.status !== 0) return null;
          try {
            const parsed = JSON.parse(result.stdout) as { dependencies?: Record<string, { version?: unknown }> };
            const version = parsed.dependencies?.[pkg]?.version;
            return typeof version === 'string' ? version : null;
          } catch {
            return null;
          }
        },
        latestVersion: (pkg) => {
          const result = deps.runner.run('npm', ['view', pkg, 'version']);
          if (result.status !== 0) return null;
          const version = result.stdout.trim();
          return version || null;
        },
      }, agents.values());
      if (rest.includes('--json')) {
        deps.stdout(`${JSON.stringify({ agents: entries }, null, 2)}\n`);
        return 0;
      }
      for (const item of entries) {
        deps.stdout(`${item.agent}: installed ${item.installed ?? '(none)'}, pinned ${item.pinned}, latest ${item.latest ?? '(unknown)'}\n`);
      }
      return 0;
    }
    case 'upgrade': {
      const target = rest[0];
      if (!target) throw new UsageError('agent upgrade requires <agent|all>');
      const names = target === 'all' ? [...agents.keys()] : [target];
      const overrides: Record<string, string> = {};
      const defs = names.map((name) => {
        try {
          return agentEngine(agents, name);
        } catch (error) {
          throw new CliError((error as Error).message, 1);
        }
      });
      for (const def of defs) {
        const spec = def.installSpec();
        if (spec.channel !== 'npm' || !spec.npmPackage || !spec.pinnedVersion) {
          deps.stdout(`${def.name} is native and has no npm upgrade channel\n`);
          continue;
        }
        const probed = deps.runner.run('npm', ['view', spec.npmPackage, 'version']);
        const latest = probed.status === 0 ? probed.stdout.trim() : '';
        if (!latest) throw new CliError(`cannot resolve latest version for ${spec.npmPackage}`, 1);
        overrides[spec.npmPackage] = latest;
        deps.stdout(`${def.name}: pinned ${spec.pinnedVersion}, latest ${latest}\n`);
      }
      if (Object.keys(overrides).length === 0) return 0;
      const contextDir = new URL('../../templates', import.meta.url).pathname;
      const tag = `sandbox-workspace:upgrade-${Date.now()}`;
      const built = buildCandidate(
        {
          buildImage: (plan) => dockerBuild(deps.runner, plan),
          inspectBinaryVersions: (candidate) => {
            const probed = deps.runner.run('docker', [
              'run', '--rm',
              '-e', 'SANDBOX_GENERATION=inspect',
              '-e', 'SANDBOX_CONFIG_FINGERPRINT=inspect',
              candidate, 'sh', '-c', 'opencode --version; codex --version; copilot --version',
            ]);
            const versions: Record<string, string> = {};
            const lines = probed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
            if (lines[0]) versions['opencode-ai'] = lines[0];
            if (lines[1]) versions['@openai/codex'] = lines[1].replace(/^codex-cli /, '');
            if (lines[2]) versions['@github/copilot'] = lines[2].replace(/^GitHub Copilot CLI /, '').replace(/\.$/, '');
            return versions;
          },
          verifyCandidate: (candidate) => {
            const probed = deps.runner.run('docker', [
              'run', '--rm',
              '-e', 'SANDBOX_GENERATION=upgrade-verify',
              '-e', 'SANDBOX_CONFIG_FINGERPRINT=verify',
              candidate, 'sh', '-c', 'test -x /usr/local/bin/sandbox-entrypoint.sh',
            ]);
            return probed.status === 0;
          },
        },
        contextDir,
        tag,
        agents.values(),
        overrides,
      );
      deps.stdout(`upgrade candidate ${built.tag} verified; running sessions are untouched.\nActivate explicitly with: sandbox image activate ${built.tag}\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown agent action: ${action}`);
  }
}

async function credentialsCommand(deps: MainDeps, action: string, rest: string[], workspace: string | undefined): Promise<number> {
  const registry = loadRegistryOrThrow(deps);
  if (action === 'help') {
    deps.stdout(credentialsHelp());
    return 0;
  }
  if (action === 'list') {
    const entries = Object.values(registry.workspaces);
    if (rest.includes('--json')) {
      const payload: Record<string, string[]> = {};
      for (const entry of entries) payload[entry.id] = listCredentialInstances(deps.homeDir, entry.id);
      deps.stdout(`${JSON.stringify({ credentials: payload }, null, 2)}\n`);
      return 0;
    }
    for (const entry of entries) {
      const names = listCredentialInstances(deps.homeDir, entry.id);
      deps.stdout(`${entry.id}: ${names.join(', ') || '(none)'}\n`);
    }
    return 0;
  }
  const instance = takeRestOption(rest, ['--instance']);
  if (!instance) throw new UsageError(`credentials ${action} requires --instance <name>`);
  try {
    assertInstanceName(instance);
  } catch (error) {
    throw new CliError((error as Error).message, 2);
  }
  const resolution = resolveWorkspace({ explicitRoot: workspace, cwd: deps.cwd, registry });
  const entry = resolution.registered ? lookupWorkspace(registry, resolution.root) : null;
  if (!entry) throw new CliError('no workspace in scope; register one first', 1);
  switch (action) {
    case 'show': {
      const stored = loadCredentials(deps.homeDir, entry.id, instance);
      if (!stored) {
        deps.stdout(`no credentials for instance ${instance}\n`);
        return 0;
      }
      deps.stdout(`${JSON.stringify(redactEnv(stored), null, 2)}\n`);
      return 0;
    }
    case 'set': {
      const file = takeRestOption(rest, ['--file']);
      if (!file) throw new UsageError('credentials set requires --file <path>');
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        throw new CliError(`cannot read credential file: ${file}`, 2);
      }
      if (loadCredentials(deps.homeDir, entry.id, instance) !== null) {
        const approved = await deps.confirm(`instance ${instance} already has credentials. Overwrite?`);
        if (!approved) throw new CliError('credentials set cancelled; nothing was changed', 1);
      }
      let keys: string[];
      try {
        keys = setCredentials(deps.homeDir, entry.id, instance, content);
      } catch (error) {
        throw new CliError((error as Error).message, 2);
      }
      deps.stdout(`stored ${keys.length} keys for instance ${instance} (values never shown)\n`);
      return 0;
    }
    case 'clear': {
      const removed = clearCredentials(deps.homeDir, entry.id, instance);
      deps.stdout(removed ? `cleared credentials for instance ${instance}\n` : `no credentials for instance ${instance}\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown credentials action: ${action}`);
  }
}

function dockerBuild(runner: CommandRunner, plan: { contextDir: string; tag: string; buildArgs: Record<string, string> }): string {
  const args = ['build', '-f', `${plan.contextDir}/Dockerfile`];
  for (const [key, value] of Object.entries(plan.buildArgs)) args.push('--build-arg', `${key}=${value}`);
  args.push('-t', plan.tag, plan.contextDir);
  const result = runner.run('docker', args);
  if (result.status !== 0) {
    const tail = result.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0).slice(-15).join('\n');
    const detail = [result.stderr.trim(), tail].filter((part) => part.length > 0).join('\n');
    throw new CliError(`image build failed:\n${detail}`, 1);
  }
  return plan.tag;
}

async function imageCommand(deps: MainDeps, action: string, rest: string[], workspace: string | undefined): Promise<number> {  const registry = loadRegistryOrThrow(deps);
  switch (action) {
    case 'help':
      deps.stdout(imageHelp());
      return 0;
    case 'list': {
      const containers = rt.listManagedContainers(deps.runner);
      const entries = Object.values(registry.workspaces).map((entry) => ({ id: entry.id, image: entry.image, container: entry.container }));
      if (rest.includes('--json')) {
        deps.stdout(`${JSON.stringify({ images: entries, containers }, null, 2)}\n`);
        return 0;
      }
      for (const item of entries) {
        deps.stdout(`${item.id}: ${item.image ?? '(none)'} (${item.container})\n`);
      }
      return 0;
    }
    case 'build': {
      const contextDir = new URL('../../templates', import.meta.url).pathname;
      const tag = `sandbox-workspace:candidate-${Date.now()}`;
      const built = buildCandidate(
        {
          buildImage: (plan) => dockerBuild(deps.runner, plan),
          inspectBinaryVersions: (candidate) => {
            const probed = deps.runner.run('docker', [
              'run', '--rm',
              '-e', 'SANDBOX_GENERATION=inspect',
              '-e', 'SANDBOX_CONFIG_FINGERPRINT=inspect',
              candidate, 'sh', '-c', 'opencode --version; codex --version; copilot --version',
            ]);
            const versions: Record<string, string> = {};
            const lines = probed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
            if (lines[0]) versions['opencode-ai'] = lines[0];
            if (lines[1]) versions['@openai/codex'] = lines[1].replace(/^codex-cli /, '');
            if (lines[2]) versions['@github/copilot'] = lines[2].replace(/^GitHub Copilot CLI /, '').replace(/\.$/, '');
            return versions;
          },
          verifyCandidate: (candidate) => {
            const generation = `verify-${Date.now()}`;
            const probed = deps.runner.run('docker', [
              'run', '--rm',
              '-e', `SANDBOX_GENERATION=${generation}`,
              '-e', 'SANDBOX_CONFIG_FINGERPRINT=verify',
              candidate, 'sh', '-c', 'test -x /usr/local/bin/sandbox-entrypoint.sh && cat /tmp/sandbox-ready/ready.json',
            ]);
            if (probed.status !== 0) return false;
            try {
              const ready = JSON.parse(probed.stdout) as { generation?: unknown };
              return ready.generation === generation;
            } catch {
              return false;
            }
          },
        },
        contextDir,
        tag,
        agents.values(),
      );
      deps.stdout(`candidate ${built.tag} verified; activate explicitly with: sandbox image activate ${built.tag}\n`);
      return 0;
    }
    case 'activate': {
      const digest = rest[0];
      if (!digest) throw new UsageError('image activate requires <digest>');
      if (!rt.imageExists(deps.runner, digest)) throw new CliError(`image not found locally: ${digest}`, 1);
      const entry = await resolveAndEnsure(deps, registry, workspace);
      if (entry.instances.length > 0) {
        const approved = await deps.confirm(`${entry.instances.length} live instances will be interrupted. Activate?`);
        if (!approved) throw new CliError('activate cancelled; nothing was changed', 1);
      }
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        const activation = activateImage(entry, digest);
        saveRegistry(registryPathOf(deps), registry);
        deps.stdout(`activated ${activation.current} (previous: ${activation.previous ?? '(none)'})\n`);
        return 0;
      } finally {
        handle.release();
      }
    }
    case 'rollback': {
      const entry = await resolveAndEnsure(deps, registry, workspace);
      if (entry.instances.length > 0) {
        const approved = await deps.confirm(`${entry.instances.length} live instances will be interrupted. Roll back?`);
        if (!approved) throw new CliError('rollback cancelled; nothing was changed', 1);
      }
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        let activation;
        try {
          activation = rollbackImage(entry);
        } catch (error) {
          throw new CliError((error as Error).message, 1);
        }
        saveRegistry(registryPathOf(deps), registry);
        deps.stdout(`rolled back to ${activation.current}; data migrations are not reversed\n`);
        return 0;
      } finally {
        handle.release();
      }
    }
    default:
      throw new UsageError(`unknown image action: ${action}`);
  }
}

function invokedAsMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  const assumeYes = process.argv.includes('--yes') || process.argv.includes('-y');
  const filtered = process.argv.slice(2).filter((arg) => arg !== '--yes' && arg !== '-y');
  main(filtered, realDeps(assumeYes)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`error: ${(error as Error).message ?? error}\n`);
      process.exit(1);
    },
  );
}
