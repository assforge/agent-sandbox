#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { agentEngine, agentEngines, loadUserCatalog, outdatedEngines, type AgentEngine, type VersionRunner } from '../engines/agent.js';
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
import { canonicalAction, parseArgs, UsageError } from '../cli.js';
import {
  type CommandRunner,
  type RunResult,
} from '../docker.js';
import { RUNTIME_ENGINES, type RuntimeEngine } from '../engines/runtime.js';
import { TERMINAL_ENGINES, type TerminalEngine } from '../engines/terminal.js';
import { buildCandidate, activateImage, parseInspectedVersions, rollbackImage, INSPECT_VERSIONS_SCRIPT } from '../image.js';
import { acquireLock } from '../lock.js';
import { ensureInstanceHome, ensureReady, homeDirForInstance, stopWorkspace } from '../lifecycle.js';
import { dryRunMigration } from '../migrate.js';
import { loadHostConfig, saveHostConfig } from '../hostconfig.js';
import {
  defaultRegistryPath,
  loadRegistry,
  lookupWorkspace,
  networkName,
  registerWorkspace,
  saveRegistry,
  type Registry,
  type WorkspaceEntry,
} from '../registry.js';
import { defaultCanonicalize, resolveWorkspace } from '../resolve.js';
import { migrateHomeDir, sandboxDir } from '../paths.js';
import { doctorExitCode, renderDoctorJson, renderDoctorText, runDoctor } from '../doctor.js';
import { agentHelp, linkHelp, credentialsHelp, describeAction, imageHelp, unlinkHelp, runtimeHelp, terminalHelp, topHelp, updateHelp, workspaceHelp } from '../help.js';

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

// Engine selection: host-level default from ~/.agent.sandbox/config.json with
// per-workspace override recorded on the entry. Unknown names fail closed.
function selectRuntime(deps: MainDeps, entry?: WorkspaceEntry): RuntimeEngine {
  const wanted = entry?.runtime ?? loadHostConfig(deps.homeDir).runtime;
  const engine = RUNTIME_ENGINES[wanted];
  if (!engine) {
    throw new CliError(`unknown runtime engine: ${wanted}; run: sandbox runtime list`, 2);
  }
  return engine;
}

function agentRegistry(deps: MainDeps): Map<string, AgentEngine> {
  return agentEngines(loadUserCatalog(deps.homeDir));
}

function selectTerminal(deps: MainDeps, entry?: WorkspaceEntry): TerminalEngine {
  const wanted = entry?.terminal ?? loadHostConfig(deps.homeDir).terminal;
  const engine = TERMINAL_ENGINES[wanted];
  if (!engine) {
    throw new CliError(`unknown terminal engine: ${wanted}; run: sandbox terminal list`, 2);
  }
  return engine;
}

interface ResolvedAgentVersion {
  def: AgentEngine;
  key: string;
  pinned: string;
  latest: string;
}

/** Resolve latest versions for engine defs, printing the per-engine lines. */
function resolveAgentVersions(deps: MainDeps, defs: AgentEngine[], versionQueries: VersionRunner): ResolvedAgentVersion[] {
  const resolved: ResolvedAgentVersion[] = [];
  for (const def of defs) {
    const spec = def.installSpec();
    if (!spec.pinnedVersion) {
      deps.stdout(`${def.name} has no pinned version and cannot be upgraded\n`);
      continue;
    }
    const latest = def.latestVersion(versionQueries);
    if (!latest) {
      deps.stdout(`${def.name}: latest unknown, keeping pinned ${spec.pinnedVersion}\n`);
      continue;
    }
    resolved.push({ def, key: spec.npmPackage ?? def.name, pinned: spec.pinnedVersion, latest });
    deps.stdout(`${def.name}: pinned ${spec.pinnedVersion}, latest ${latest}\n`);
  }
  return resolved;
}

/** Build a verified upgrade candidate from version overrides. */
function buildUpgradeCandidate(
  deps: MainDeps,
  rt: RuntimeEngine,
  agents: Iterable<AgentEngine>,
  overrides: Record<string, string>,
  tag: string,
): { tag: string } {
  const contextDir = new URL('../../templates', import.meta.url).pathname;
  return buildCandidate(
    {
      buildImage: (plan) => {
        try {
          return rt.buildImage(deps.runner, plan);
        } catch (error) {
          throw new CliError((error as Error).message, 1);
        }
      },
      inspectBinaryVersions: (candidate) => {
        const probed = rt.runOneShot(deps.runner, candidate, { SANDBOX_GENERATION: 'inspect', SANDBOX_CONFIG_FINGERPRINT: 'inspect' }, ['sh', '-c', INSPECT_VERSIONS_SCRIPT]);
        return parseInspectedVersions(probed.stdout);
      },
      verifyCandidate: (candidate) => {
        const probed = rt.runOneShot(deps.runner, candidate, { SANDBOX_GENERATION: 'upgrade-verify', SANDBOX_CONFIG_FINGERPRINT: 'verify' }, ['sh', '-c', 'test -x /usr/local/bin/sandbox-entrypoint.sh']);
        return probed.status === 0;
      },
    },
    contextDir,
    tag,
    agents,
    overrides,
  );
}

/** Canonicalize and vet a mount path. Shared by configure/mount. Throws on refusal. */
function vettedMount(deps: MainDeps, path: string): string {
  const canonical = defaultCanonicalize(path);
  const problem = rejectForbiddenMount(canonical, deps.homeDir);
  if (problem) throw new CliError(`refused mount ${canonical}: ${problem}`, 2);
  return canonical;
}

/** Drop a mount, refusing the workspace root. Shared by configure/unmount. */
function dropMountFromEntry(entry: WorkspaceEntry, path: string): void {
  const canonicalDrop = defaultCanonicalize(path);
  if (normalizeLexical(canonicalDrop) === normalizeLexical(entry.root)) {
    throw new CliError(`cannot drop the workspace root mount: ${entry.root}`, 2);
  }
  entry.mounts = entry.mounts.filter((mount) => normalizeLexical(mount) !== normalizeLexical(canonicalDrop));
}

/** Print group or per-action help for resource groups. True when handled. */
function printGroupHelp(deps: MainDeps, group: string, action: string, help: boolean, groupHelp: () => string): boolean {
  if (!action) {
    deps.stdout(groupHelp());
    return true;
  }
  if (help) {
    const block = describeAction(group, action);
    if (!block) throw new UsageError(`unknown ${group} action: ${action}`);
    deps.stdout(block);
    return true;
  }
  return false;
}

/** Read agent versions from a running container. Null when it cannot be done. No tty: version output needs none, and -t fails without a terminal. */
export function inspectRunningVersions(deps: MainDeps, rt: RuntimeEngine, container: string, workdir: string): Record<string, string> | null {
  const spec = rt.execVector(container, { workdir, argv: ['sh', '-c', INSPECT_VERSIONS_SCRIPT], tty: false });
  const probed = deps.runner.run(spec.command, spec.args);
  if (probed.status !== 0) return null;
  return parseInspectedVersions(probed.stdout);
}

/** Resolve engine defs by name, failing with exit 1 on unknown agents. */
function resolveAgentDefs(agents: Map<string, AgentEngine>, names: string[]): AgentEngine[] {
  return names.map((name) => {
    try {
      return agentEngine(agents, name);
    } catch (error) {
      throw new CliError((error as Error).message, 1);
    }
  });
}

export interface MainDeps {
  cwd: string;
  homeDir: string;
  lockDir: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  pathLookup: (name: string) => string | null;
  commandSucceeds: (command: string, args: string[]) => boolean;
  runner: CommandRunner;
  insideTerminal: boolean;
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
    runAttached: (command: string, args: string[]): RunResult => {
      // No timeout: attach parks for the life of the session. stdio is
      // inherited so the child owns the terminal; piped stdio is exactly
      // what made every attach fail with "not a terminal".
      try {
        execFileSync(command, args, { stdio: 'inherit' });
        return { status: 0, stdout: '', stderr: '' };
      } catch (error) {
        const status = typeof (error as { status?: unknown }).status === 'number'
          ? (error as { status: number }).status
          : 1;
        return { status, stdout: '', stderr: '' };
      }
    },
  };
}

export function realDeps(assumeYes: boolean): MainDeps {
  const runner = realRunner();
  return {
    cwd: process.cwd(),
    homeDir: homedir(),
    lockDir: join(sandboxDir(homedir()), 'locks'),
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
    insideTerminal: (process.env['TMUX'] ?? '') !== '' || process.env['HERDR_ENV'] === '1',
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
/** Canonical package identity for self-update. Never derived from user input. */
const SELF_PACKAGE = '@assforge/cogent-sandbox';

function packageVersion(): string {  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
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

/** Filesystem pre-check so the git probe below never runs (and never
 * leaks its fatal to stderr) outside a repository. */
export function hasGitDir(cwd: string): boolean {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = join(dir, '..');
    if (parent === dir) return false;
    dir = parent;
  }
}

function detectGitRoot(deps: MainDeps): string | null {
  if (!hasGitDir(deps.cwd)) return null;
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
  const entry = registerWorkspace(registry, canonical, [canonical], { homeDir: deps.homeDir, runtime: loadHostConfig(deps.homeDir).runtime, terminal: loadHostConfig(deps.homeDir).terminal });
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
 * Per-instance launch environment: stored credentials plus HOME.
 * Shared mode points at the workspace home; fork and fresh isolate per
 * instance directory. HOME wins over any stored HOME key. Absent mode
 * means shared.
 */
function launchEnvFor(deps: MainDeps, entry: WorkspaceEntry, instance: string, homeMode?: string): Record<string, string> {
  const stored = loadCredentials(deps.homeDir, entry.id, instance) ?? {};
  return { ...stored, HOME: homeDirForInstance(instance, homeMode) };
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
  if (migrateHomeDir(deps.homeDir)) {
    deps.stderr('sandbox home moved from ~/.sandbox to ~/.agent.sandbox\n');
  }
  const parsed = parseArgs(argv);
  const agents = agentRegistry(deps);
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
      const doctorRt = current ? selectRuntime(deps, current) : selectRuntime(deps);
      const doctorTerm = current ? selectTerminal(deps, current) : selectTerminal(deps);
      let runningVersions: Record<string, string> | null = null;
      if (current && doctorRt.containerState(deps.runner, current.container, current.id) === 'running') {
        runningVersions = inspectRunningVersions(deps, doctorRt, current.container, current.root);
      }
      const checks = runDoctor(
        {
          nodeVersion: deps.nodeVersion,
          pathLookup: deps.pathLookup,
          commandSucceeds: deps.commandSucceeds,
          platform: deps.platform,
          runtime: {
            display: doctorRt.displayName,
            binary: doctorRt.doctorProbes.binary,
            args: doctorRt.doctorProbes.args,
            verified: doctorRt.verified,
          },
          terminal: {
            display: doctorTerm.name === 'tmux' ? 'tmux' : 'Herder',
            binary: doctorTerm.cliBinary,
            installHint: doctorTerm.installHint(deps.platform),
          },
        },
        { image: current?.image ?? null, network: current ? current.network : null, networkExists, deadWindows, runningVersions },
      );
      deps.stdout(parsed.json ? renderDoctorJson(checks) : renderDoctorText(checks));
      return doctorExitCode(checks);
    }
    case 'bare':
    case 'shell': {
      const name = parsed.kind === 'shell' ? (parsed.name ?? 'shell') : 'shell';
      try {
        // Name validation precedes resolution; the shared charset covers
        // every registered terminal engine.
        selectTerminal(deps).assertWindowName(name);
      } catch (error) {
        throw new CliError((error as Error).message, 2);
      }
      const registry = loadRegistryOrThrow(deps);
      const entry = await resolveAndEnsure(deps, registry, parsed.workspace);
      const rt = selectRuntime(deps, entry);
      const term = selectTerminal(deps, entry);
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        ensureReady(deps.runner, rt, entry, { image: requireImage(entry) });
        if (!entry.instances.some((item) => item.name === name)) {
          entry.instances.push({ name, kind: 'shell', window: name, homeMode: parsed.kind === 'shell' ? parsed.homeMode : undefined });
          if (parsed.kind === 'shell' && parsed.homeMode === 'fork' && !entry.forks.includes(name)) entry.forks.push(name);
          saveRegistry(registryPathOf(deps), registry);
        }
        const shellMode = entry.instances.find((item) => item.name === name)?.homeMode ?? (parsed.kind === 'shell' ? parsed.homeMode : undefined);
        const launchEnv = launchEnvFor(deps, entry, name, shellMode);
        ensureInstanceHome(deps.runner, rt, entry.container, name, shellMode);
        term.openAgentWindow(deps.runner, entry.session, name, rt.execVector(entry.container, { workdir: entry.root, argv: ['bash'], env: launchEnv }), entry.root);
      } finally {
        handle.release();
      }
      if (!parsed.noAttach) reattachOrHint(deps, term, entry.session);
      return 0;
    }
    case 'agent': {
      const def = agentEngine(agents, parsed.agent);
      const name = parsed.name ?? parsed.agent;
      try {
        // See shell branch: shared charset, validated before resolution.
        selectTerminal(deps).assertWindowName(name);
      } catch (error) {
        throw new CliError((error as Error).message, 2);
      }
      const registry = loadRegistryOrThrow(deps);
      const entry = await resolveAndEnsure(deps, registry, parsed.workspace);
      const rt = selectRuntime(deps, entry);
      const term = selectTerminal(deps, entry);
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
          entry.instances.push({ name, kind: parsed.agent, window: name, homeMode: parsed.homeMode });
          if (parsed.homeMode === 'fork' && !entry.forks.includes(name)) entry.forks.push(name);
          saveRegistry(registryPathOf(deps), registry);
        }
        const mode = same?.homeMode ?? parsed.homeMode;
        const launchEnv = launchEnvFor(deps, entry, name, mode);
        ensureInstanceHome(deps.runner, rt, entry.container, name, mode);
        launched = term.openAgentWindow(
          deps.runner,
          entry.session,
          name,
          rt.execVector(entry.container, { workdir: entry.root, argv: [...def.launch, ...parsed.forwarded], env: launchEnv }),
          entry.root,
        );
      } finally {
        handle.release();
      }
      deps.stdout(`${launched} window ${name} (${parsed.agent}) in session ${entry.session}\n`);
      if (!parsed.noAttach) reattachOrHint(deps, term, entry.session);
      return 0;
    }
    case 'workspace':
      if (printGroupHelp(deps, 'workspace', parsed.action, parsed.help, workspaceHelp)) return 0;
      return workspaceCommand(deps, parsed.action, parsed.rest, parsed.workspace);
    case 'link': {
      if (parsed.help) {
        deps.stdout(linkHelp());
        return 0;
      }
      const registry = loadRegistryOrThrow(deps);
      const raw = parsed.root ?? deps.cwd;
      if (!existsSync(raw)) {
        throw new CliError(`workspace root does not exist: ${raw}`, 2);
      }
      const canonical = defaultCanonicalize(raw);
      const entry = registerWorkspace(registry, canonical, [canonical], { homeDir: deps.homeDir, runtime: loadHostConfig(deps.homeDir).runtime, terminal: loadHostConfig(deps.homeDir).terminal });
      saveRegistry(registryPathOf(deps), registry);
      deps.stdout(`registered ${entry.id} for ${canonical}\n`);
      return 0;
    }
    case 'unlink': {
      if (parsed.help) {
        deps.stdout(unlinkHelp());
        return 0;
      }
      const registry = loadRegistryOrThrow(deps);
      const raw = parsed.root ?? deps.cwd;
      const root = defaultCanonicalize(raw);
      return unregisterWorkspace(deps, registry, root);
    }
    case 'agentAdmin':
      if (printGroupHelp(deps, 'agent', parsed.action, parsed.help, agentHelp)) return 0;
      return agentCommand(deps, parsed.action, parsed.rest);
    case 'credentials':
      if (printGroupHelp(deps, 'credentials', parsed.action, parsed.help, credentialsHelp)) return 0;
      return credentialsCommand(deps, parsed.action, parsed.rest, parsed.workspace);
    case 'runtime':
      if (printGroupHelp(deps, 'runtime', parsed.action, parsed.help, runtimeHelp)) return 0;
      return runtimeCommand(deps, parsed.action, parsed.rest);
    case 'terminal':
      if (printGroupHelp(deps, 'terminal', parsed.action, parsed.help, terminalHelp)) return 0;
      return terminalCommand(deps, parsed.action, parsed.rest);
    case 'image':
      if (printGroupHelp(deps, 'image', parsed.action, parsed.help, imageHelp)) return 0;
      return imageCommand(deps, parsed.action, parsed.rest, parsed.workspace);
    case 'update': {
      if (parsed.help) {
        deps.stdout(updateHelp());
        return 0;
      }
      const current = packageVersion();
      const probed = deps.runner.run('npm', ['view', SELF_PACKAGE, 'version']);
      if (probed.status !== 0) throw new CliError(`cannot check the latest ${SELF_PACKAGE} version`, 1);
      const latest = probed.stdout.trim();
      if (!latest) throw new CliError(`cannot check the latest ${SELF_PACKAGE} version`, 1);
      if (parsed.check) {
        deps.stdout(`current ${current}, latest ${latest}\n`);
        return 0;
      }
      if (latest === current) {
        deps.stdout(`sandbox ${current} is already current\n`);
        return 0;
      }
      const installed = deps.runner.run('npm', ['install', '-g', `${SELF_PACKAGE}@${latest}`]);
      if (installed.status !== 0) {
        const detail = installed.stderr.trim() || installed.stdout.trim();
        throw new CliError(`update to ${latest} failed${detail ? `: ${detail}` : ''}; check npm authentication for the package registry`, 1);
      }
      deps.stdout(`updated sandbox ${current} -> ${latest}; run sandbox workspace upgrade to rebuild images with the new CLI\n`);
      return 0;
    }
  }
}

function takeRestOption(rest: string[], names: string[]): string | undefined {
  const index = rest.findIndex((arg) => names.includes(arg));
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (!value || value.startsWith('-')) throw new UsageError(`option ${rest[index]} requires a value`);
  return value;
}

/** Reattach, turning a terminal-less failure into an actionable message: the window itself is already ready. */
export function reattachOrHint(deps: MainDeps, term: TerminalEngine, session: string): void {
  try {
    term.reattach(deps.runner, session, deps.insideTerminal);
  } catch (error) {
    throw new CliError(
      `cannot attach to session ${session}: ${(error as Error).message}; the window is ready, attach from a terminal with: sandbox workspace attach`,
      1,
    );
  }
}
/** Remove orphan fork state: forks with no roster entry left.
 * Fork names share the instance charset (letters, digits, dot,
 * underscore, hyphen), so interpolation below cannot break out.
 * Credential files are never touched: clear them explicitly.
 */
async function pruneForks(deps: MainDeps, registry: Registry, targets: WorkspaceEntry[]): Promise<number> {
  const victims: { entry: WorkspaceEntry; rt: RuntimeEngine; fork: string }[] = [];
  for (const entry of targets) {
    const live = new Set(entry.instances.map((item) => item.name));
    const rt = selectRuntime(deps, entry);
    for (const fork of entry.forks) {
      if (!live.has(fork)) victims.push({ entry, rt, fork });
    }
  }
  if (victims.length === 0) {
    deps.stdout('no orphan fork state to prune\n');
    return 0;
  }
  const names = victims.map((item) => `${item.entry.id}:${item.fork}`).join(', ');
  const approved = await deps.confirm(`remove ${victims.length} orphan fork(s): ${names}? Credential files are kept.`);
  if (!approved) throw new CliError('prune cancelled; nothing was changed', 1);
  for (const item of victims) {
    const handle = acquireLock(deps.lockDir, item.entry.id);
    try {
      // The home volume rides along at /v: without it the one-shot would
      // prune an ephemeral container filesystem and report success.
      const probed = item.rt.runOneShot(
        deps.runner,
        requireImage(item.entry),
        { SANDBOX_GENERATION: 'prune', SANDBOX_CONFIG_FINGERPRINT: 'prune' },
        ['sh', '-c', `rm -rf '/v/instances/${item.fork}'`],
        { mounts: [{ source: item.entry.homeVolume, target: '/v' }] },
      );
      if (probed.status !== 0) throw new CliError(`cannot prune fork ${item.fork}`, 1);
      item.entry.forks = item.entry.forks.filter((fork) => fork !== item.fork);
      saveRegistry(registryPathOf(deps), registry);
    } finally {
      handle.release();
    }
  }
  deps.stdout(`pruned forks: ${names}; credential files kept\n`);
  return 0;
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
  const rt = selectRuntime(deps, entry);
  const term = selectTerminal(deps, entry);
  let state = rt.containerState(deps.runner, entry.container, entry.id);
  const alive = term.sessionAlive(deps.runner, entry.session);
  const live = state === 'running' || alive || entry.instances.length > 0;
  if (live) {
    const approved = await deps.confirm(
      `unregister ${entry.id}? This stops its container and kills its terminal session. Volumes, networks, images, and credentials are kept.`,
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
  const term = selectTerminal(deps, entry);
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
  switch (canonicalAction('workspace', action)) {
    case 'help':
      deps.stdout(workspaceHelp());
      return 0;
    case 'list': {
      const entries = Object.values(registry.workspaces);
      if ((rest.includes('--json') || rest.includes('-j'))) {
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
      const rt = selectRuntime(deps, entry);
      const term = selectTerminal(deps, entry);
      const state = rt.containerState(deps.runner, entry.container, entry.id);
      const alive = term.sessionAlive(deps.runner, entry.session);
      const windows = alive
        ? deps.runner.run('tmux', ['list-windows', '-t', entry.session, '-F', '#{window_name}']).stdout.split('\n').map((line) => line.trim())
        : [];
      const describe = (name: string, kind: string, homeMode?: string): string => {
        const home = homeMode ?? 'shared';
        if (!alive) return `${name}(${kind}:${home}, session absent)`;
        return windows.includes(name) ? `${name}(${kind}:${home})` : `${name}(${kind}:${home}, window missing)`;
      };
      if ((rest.includes('--json') || rest.includes('-j'))) {
        deps.stdout(`${JSON.stringify({ id: entry.id, container: state, session: alive, instances: entry.instances.map((i) => ({ name: i.name, kind: i.kind, window: windows.includes(i.window), home: i.homeMode ?? 'shared' })) }, null, 2)}\n`);
        return 0;
      }
      deps.stdout(`workspace ${entry.id}\n  container: ${state}\n  session: ${alive ? 'alive' : 'absent'}\n  instances: ${entry.instances.map((i) => describe(i.name, i.kind, i.homeMode)).join(', ') || '(none)'}\n`);
      return 0;
    }
    case 'link': {
      const root = takeRestOption(rest, ['--root', '-r']);
      if (!root) throw new UsageError('workspace link requires --root <path>');
      if (!existsSync(root)) {
        throw new CliError(`workspace root does not exist: ${root}`, 2);
      }
      const canonical = defaultCanonicalize(root);
      const entry = registerWorkspace(registry, canonical, [canonical], { homeDir: deps.homeDir, runtime: loadHostConfig(deps.homeDir).runtime, terminal: loadHostConfig(deps.homeDir).terminal });
      saveRegistry(registryPathOf(deps), registry);
      deps.stdout(`registered ${entry.id} for ${canonical}\n`);
      return 0;
    }
    case 'unlink': {
      const root = workspace ? defaultCanonicalize(workspace) : defaultCanonicalize(deps.cwd);
      return unregisterWorkspace(deps, registry, root);
    }
    case 'start': {
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const rt = selectRuntime(deps, entry);
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
      const rt = selectRuntime(deps, entry);
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
    case 'restart': {
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const rt = selectRuntime(deps, entry);
      if (entry.instances.length > 0) {
        const approved = await deps.confirm(`${entry.instances.length} live instances will be interrupted. Restart?`);
        if (!approved) throw new CliError('restart cancelled; nothing was changed', 1);
      }
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        stopWorkspace(deps.runner, rt, entry);
        ensureReady(deps.runner, rt, entry, { image: requireImage(entry) });
        deps.stdout(`workspace ${entry.id} restarted (container ${entry.container})\n`);
        return 0;
      } finally {
        handle.release();
      }
    }
    case 'upgrade': {
      const target = rest[0] ?? 'all';
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const agents = agentRegistry(deps);
      const names = target === 'all' ? [...agents.keys()] : [target];
      const versionQueries = makeVersionRunner(deps);
      const resolved = resolveAgentVersions(deps, resolveAgentDefs(agents, names), versionQueries);
      const drifted = resolved.filter((item) => item.latest !== item.pinned);
      if (drifted.length === 0) {
        deps.stdout('every agent is already at its latest version; nothing to build\n');
        return 0;
      }
      if (entry.instances.length > 0) {
        const approved = await deps.confirm(
          `${entry.instances.length} live instances will be interrupted. Rebuild agents and recreate the container?`,
        );
        if (!approved) throw new CliError('upgrade cancelled; nothing was changed', 1);
      }
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        const rt = selectRuntime(deps, entry);
        const overrides: Record<string, string> = {};
        for (const item of drifted) overrides[item.key] = item.latest;
        const tag = `sandbox-workspace:upgrade-${Date.now()}`;
        const built = buildUpgradeCandidate(deps, rt, agents.values(), overrides, tag);
        activateImage(entry, built.tag);
        saveRegistry(registryPathOf(deps), registry);
        stopWorkspace(deps.runner, rt, entry);
        ensureReady(deps.runner, rt, entry, { image: built.tag });
        deps.stdout(`workspace ${entry.id} upgraded to ${built.tag} (container ${entry.container})\n`);
        return 0;
      } finally {
        handle.release();
      }
    }
    case 'close': {
      const name = rest[0];
      if (!name) throw new UsageError('workspace close requires <instance>');
      if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`);
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const term = selectTerminal(deps, entry);
      const index = entry.instances.findIndex((item) => item.name === name);
      const instance = entry.instances[index];
      if (index < 0 || !instance) throw new CliError(`unknown instance: ${name}`, 1);
      const approved = await deps.confirm(`close instance ${name}? Its window goes away; volumes, credentials, and fork state are kept.`);
      if (!approved) throw new CliError('close cancelled; nothing was changed', 1);
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        term.closeWindow(deps.runner, entry.session, instance.window);
        entry.instances.splice(index, 1);
        saveRegistry(registryPathOf(deps), registry);
        deps.stdout(`closed instance ${name}; fork state kept, prune with: sandbox workspace prune --forks\n`);
        return 0;
      } finally {
        handle.release();
      }
    }
    case 'attach': {
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
    case 'logs': {      const entry = await resolveAndEnsure(deps, registry, workspace);
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
    case 'reopen': {
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
    case 'exec': {
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
    case 'configure': {
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
        deps.stdout(`plan: switch runtime ${entry.runtime} -> ${runtime} (recreates the container on next start)\n`);
      }
      if (terminal !== undefined && terminal !== entry.terminal) {
        deps.stdout(`plan: switch terminal ${entry.terminal} -> ${terminal} (recreates windows on next start)\n`);
      }
      const approved = await deps.confirm('apply these changes?');
      if (!approved) throw new CliError('configure cancelled; nothing was changed', 1);
      if (addMount && !entry.mounts.includes(defaultCanonicalize(addMount))) entry.mounts.push(defaultCanonicalize(addMount));
      if (network !== undefined) entry.network = network;
      if (runtime !== undefined) entry.runtime = runtime;
      if (terminal !== undefined) entry.terminal = terminal;
      if (dropMount) {
        dropMountFromEntry(entry, dropMount);
      }
      saveRegistry(registryPathOf(deps), registry);
      return 0;
    }
    case 'mount': {
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
      entry.mounts.push(canonical);
      saveRegistry(registryPathOf(deps), registry);
      deps.stdout(`mount ${canonical} added to ${entry.id}; applies on next start\n`);
      return 0;
    }
    case 'unmount': {
      const path = rest[0];
      if (!path) throw new UsageError('workspace unmount requires <path>');
      const entry = await resolveAndEnsure(deps, registry, workspace);
      dropMountFromEntry(entry, path);
      const approved = await deps.confirm(`drop mount ${path} from ${entry.id}? Applies on next start.`);
      if (!approved) throw new CliError('unmount cancelled; nothing was changed', 1);
      saveRegistry(registryPathOf(deps), registry);
      deps.stdout(`mount ${path} dropped from ${entry.id}; applies on next start\n`);
      return 0;
    }
    case 'prune': {
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
      if (forksOnly) return pruneForks(deps, registry, targets);
      const stopped: { entry: WorkspaceEntry; rt: RuntimeEngine }[] = [];
      for (const entry of targets) {
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
          item.rt.removeContainer(deps.runner, item.entry.container);
        } finally {
          handle.release();
        }
      }
      deps.stdout(`pruned ${names}; volumes, networks, images, and the registry kept\n`);
      return 0;
    }
    case 'backup': {
      const output = takeRestOption(rest, ['--output', '-o']);
      if (!output) throw new UsageError('workspace backup requires --output <path>');
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const rt = selectRuntime(deps, entry);
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        const receipt = backupWorkspace(
          {
            copyFromContainer: (container, from, to) => {
              try {
                rt.copyFromContainer(deps.runner, container, from, to);
              } catch (error) {
                throw new CliError((error as Error).message, 1);
              }
            },
            copyToContainer: (container, from, to) => {
              try {
                rt.copyToContainer(deps.runner, container, from, to);
              } catch (error) {
                throw new CliError((error as Error).message, 1);
              }
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
      const rt = selectRuntime(deps, entry);
      const manifestId = peekBackupId(input);
      if (manifestId !== entry.id) {
        throw new CliError(`backup belongs to ${manifestId}, not to ${entry.id}; nothing was changed`, 1);
      }
      const approved = await deps.confirm(`restore ${entry.id} from ${input}? Running state will be overwritten.`);
      if (!approved) throw new CliError('restore cancelled; nothing was changed', 1);
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        const restored = restoreWorkspace(
          {
            copyFromContainer: (container, from, to) => {
              try {
                rt.copyFromContainer(deps.runner, container, from, to);
              } catch (error) {
                throw new CliError((error as Error).message, 1);
              }
            },
            copyToContainer: (container, from, to) => {
              try {
                rt.copyToContainer(deps.runner, container, from, to);
              } catch (error) {
                throw new CliError((error as Error).message, 1);
              }
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
      const inventoryRt = selectRuntime(deps);
      const inventoryTerm = selectTerminal(deps);
      const existing = [
        ...inventoryRt.listContainers(deps.runner).map((name) => ({ kind: 'container' as const, name })),
        ...inventoryRt.listVolumes(deps.runner).map((name) => ({ kind: 'volume' as const, name })),
        ...inventoryTerm.listSessions(deps.runner).map((name) => ({ kind: 'session' as const, name })),
      ];
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const rt = selectRuntime(deps, entry);
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
          try {
            rt.copyVolume(deps.runner, mapping.legacy.name, mapping.destination, entry.id);
          } catch (error) {
            throw new CliError(`migrate copy failed for ${mapping.legacy.name}: ${(error as Error).message}`, 1);
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

/** Version queries backed by npm and curl via argv vectors (no shell, no new deps). */
function makeVersionRunner(deps: MainDeps): VersionRunner {
  return {
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
    fetchText: (url) => {
      const result = deps.runner.run('curl', ['-fsSL', '--max-time', '10', url]);
      if (result.status !== 0) return null;
      const text = result.stdout.trim();
      return text || null;
    },
  };
}

async function agentCommand(deps: MainDeps, action: string, rest: string[]): Promise<number> {
  const agents = agentRegistry(deps);
  switch (action) {
    case 'help':
      deps.stdout(agentHelp());
      return 0;
    case 'list': {
      const listed = [...agents.values()].map((engine) => {
        const spec = engine.installSpec();
        return { name: engine.name, npmPackage: spec.npmPackage, pinnedVersion: spec.pinnedVersion, statePaths: engine.statePaths, launch: engine.launch };
      });
      if ((rest.includes('--json') || rest.includes('-j'))) {
        deps.stdout(`${JSON.stringify({ agents: listed }, null, 2)}\n`);
        return 0;
      }
      for (const item of listed) {
        const spec = agents.get(item.name)?.installSpec();
        deps.stdout(spec?.channel === 'native'
          ? `${item.name}: native ${item.pinnedVersion} (installer)\n`
          : `${item.name}: ${item.npmPackage}@${item.pinnedVersion} (npm)\n`);
      }
      return 0;
    }
    case 'outdated': {
      const entries = outdatedEngines(makeVersionRunner(deps), agents.values());
      if ((rest.includes('--json') || rest.includes('-j'))) {
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
      const rt = selectRuntime(deps);
      const names = target === 'all' ? [...agents.keys()] : [target];
      const versionQueries = makeVersionRunner(deps);
      const resolved = resolveAgentVersions(deps, resolveAgentDefs(agents, names), versionQueries);
      const overrides: Record<string, string> = {};
      for (const item of resolved) overrides[item.key] = item.latest;
      if (Object.keys(overrides).length === 0) return 0;
      const tag = `sandbox-workspace:upgrade-${Date.now()}`;
      const built = buildUpgradeCandidate(deps, rt, agents.values(), overrides, tag);
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
    if ((rest.includes('--json') || rest.includes('-j'))) {
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
  const instance = takeRestOption(rest, ['--instance', '-i']);
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
      const file = takeRestOption(rest, ['--file', '-f']);
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

async function runtimeCommand(deps: MainDeps, action: string, rest: string[]): Promise<number> {
  switch (action) {
    case 'help':
      deps.stdout(runtimeHelp());
      return 0;
    case 'list': {
      const selected = loadHostConfig(deps.homeDir).runtime;
      const rows = Object.values(RUNTIME_ENGINES).map((engine) => ({
        name: engine.name,
        selected: engine.name === selected,
        verified: engine.verified,
        capabilities: engine.capabilities,
      }));
      if ((rest.includes('--json') || rest.includes('-j'))) {
        deps.stdout(`${JSON.stringify({ runtimes: rows }, null, 2)}\n`);
        return 0;
      }
      for (const row of rows) {
        deps.stdout(`${row.name}${row.selected ? ' (selected)' : ''}${row.verified ? '' : ' [experimental]'}\n`);
      }
      return 0;
    }
    case 'use': {
      const name = rest[0];
      if (!name) throw new UsageError('runtime use requires <name>');
      if (!RUNTIME_ENGINES[name]) {
        throw new CliError(`unknown runtime engine: ${name}; run: sandbox runtime list`, 2);
      }
      const config = loadHostConfig(deps.homeDir);
      saveHostConfig(deps.homeDir, { runtime: name, terminal: config.terminal });
      deps.stdout(`selected runtime ${name} for new workspaces\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown runtime action: ${action}`);
  }
}

async function terminalCommand(deps: MainDeps, action: string, rest: string[]): Promise<number> {
  switch (action) {
    case 'help':
      deps.stdout(terminalHelp());
      return 0;
    case 'list': {
      const selected = loadHostConfig(deps.homeDir).terminal;
      const rows = Object.values(TERMINAL_ENGINES).map((engine) => ({ name: engine.name, selected: engine.name === selected }));
      if ((rest.includes('--json') || rest.includes('-j'))) {
        deps.stdout(`${JSON.stringify({ terminals: rows }, null, 2)}\n`);
        return 0;
      }
      for (const row of rows) {
        deps.stdout(`${row.name}${row.selected ? ' (selected)' : ''}\n`);
      }
      return 0;
    }
    case 'use': {
      const name = rest[0];
      if (!name) throw new UsageError('terminal use requires <name>');
      if (!TERMINAL_ENGINES[name]) {
        throw new CliError(`unknown terminal engine: ${name}; run: sandbox terminal list`, 2);
      }
      const config = loadHostConfig(deps.homeDir);
      saveHostConfig(deps.homeDir, { runtime: config.runtime, terminal: name });
      deps.stdout(`selected terminal ${name} for new workspaces\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown terminal action: ${action}`);
  }
}

async function imageCommand(deps: MainDeps, action: string, rest: string[], workspace: string | undefined): Promise<number> {  const registry = loadRegistryOrThrow(deps);
  const agents = agentRegistry(deps);  switch (action) {
    case 'help':
      deps.stdout(imageHelp());
      return 0;
    case 'list': {
      const runtimes = new Set(Object.values(registry.workspaces).map((item) => item.runtime));
      runtimes.add(loadHostConfig(deps.homeDir).runtime);
      const containers: string[] = [];
      for (const name of runtimes) {
        const engine = RUNTIME_ENGINES[name];
        if (engine) containers.push(...engine.listManagedContainers(deps.runner));
      }
      const entries = Object.values(registry.workspaces).map((entry) => ({ id: entry.id, image: entry.image, container: entry.container }));
      if ((rest.includes('--json') || rest.includes('-j'))) {
        deps.stdout(`${JSON.stringify({ images: entries, containers }, null, 2)}\n`);
        return 0;
      }
      for (const item of entries) {
        deps.stdout(`${item.id}: ${item.image ?? '(none)'} (${item.container})\n`);
      }
      return 0;
    }
    case 'build': {
      const buildEntry = workspace ? lookupWorkspace(registry, defaultCanonicalize(workspace)) : null;
      const rt = selectRuntime(deps, buildEntry ?? undefined);
      const contextDir = new URL('../../templates', import.meta.url).pathname;
      const tag = `sandbox-workspace:candidate-${Date.now()}`;
      const built = buildCandidate(
        {
          buildImage: (plan) => {
            try {
              return rt.buildImage(deps.runner, plan);
            } catch (error) {
              throw new CliError((error as Error).message, 1);
            }
          },
          inspectBinaryVersions: (candidate) => {
            const probed = rt.runOneShot(deps.runner, candidate, { SANDBOX_GENERATION: 'inspect', SANDBOX_CONFIG_FINGERPRINT: 'inspect' }, ['sh', '-c', INSPECT_VERSIONS_SCRIPT]);
            return parseInspectedVersions(probed.stdout);
          },
          verifyCandidate: (candidate) => {
            const generation = `verify-${Date.now()}`;
            const probed = rt.runOneShot(deps.runner, candidate, { SANDBOX_GENERATION: generation, SANDBOX_CONFIG_FINGERPRINT: 'verify' }, ['sh', '-c', 'test -x /usr/local/bin/sandbox-entrypoint.sh && cat /tmp/sandbox-ready/ready.json']);
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
      const entry = await resolveAndEnsure(deps, registry, workspace);
      const rt = selectRuntime(deps, entry);
      if (!rt.imageExists(deps.runner, digest)) throw new CliError(`image not found locally: ${digest}`, 1);
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
