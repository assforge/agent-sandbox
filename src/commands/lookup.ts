import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentEngines, loadUserCatalog, type AgentEngine } from '../engines/agent.js';
import { RUNTIME_ENGINES, type RuntimeEngine } from '../engines/runtime.js';
import { TERMINAL_ENGINES, type TerminalEngine } from '../engines/terminal.js';
import { loadHostConfig } from '../hostconfig.js';
import {
  defaultRegistryPath,
  loadRegistry,
  lookupWorkspace,
  registerWorkspace,
  type Registry,
  type WorkspaceEntry,
} from '../registry.js';
import { withRegistryTxn } from '../registry-txn.js';
import { defaultCanonicalize, resolveWorkspace } from '../resolve.js';
import { restoreClaimOf, restorePendingRefusal } from '../restore-claim.js';
import { rejectForbiddenMount } from '../config.js';
import type { CommandRunner } from '../docker.js';
import { CliError, type MainDeps } from './deps.js';
// Engine selection: host-level default from ~/.agent.sandbox/config.json with
// per-workspace override recorded on the entry. Unknown names fail closed.
export function selectRuntime(deps: MainDeps, entry?: WorkspaceEntry): RuntimeEngine {
  const wanted = entry?.runtime ?? loadHostConfig(deps.homeDir).runtime;
  const engine = RUNTIME_ENGINES[wanted];
  if (!engine) {
    throw new CliError(`unknown runtime engine: ${wanted}; run: sandbox runtime list`, 2);
  }
  return engine;
}
export function agentRegistry(deps: MainDeps): Map<string, AgentEngine> {
  return agentEngines(loadUserCatalog(deps.homeDir));
}
export function selectTerminal(deps: MainDeps, entry?: WorkspaceEntry): TerminalEngine {
  const wanted = entry?.terminal ?? loadHostConfig(deps.homeDir).terminal;
  const engine = TERMINAL_ENGINES[wanted];
  if (!engine) {
    throw new CliError(`unknown terminal engine: ${wanted}; run: sandbox terminal list`, 2);
  }
  return engine;
}
function registryPathOf(deps: MainDeps): string {
  return defaultRegistryPath(deps.homeDir);
}

export function loadRegistryOrThrow(deps: MainDeps): Registry {
  try {
    return loadRegistry(registryPathOf(deps));
  } catch (error) {
    throw new CliError(`cannot read registry: ${(error as Error).message}`, 2);
  }
}
/**
 * The only sanctioned way to write the registry -- see `registry-txn.ts` for the
 * invariant and for why the lock identity is a constant rather than a workspace id.
 * Everything a caller reads before this call is resolution input only.
 */
export const withRegistry = <T>(deps: MainDeps, fn: (registry: Registry) => T): T =>
  withRegistryTxn(deps.lockDir, registryPathOf(deps), loadRegistryOrThrow.bind(null, deps), fn);
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
export function detectGitRoot(deps: MainDeps): string | null {
  if (!hasGitDir(deps.cwd)) return null;
  const probed = deps.runner.run('git', ['-C', deps.cwd, 'rev-parse', '--show-toplevel']);
  if (probed.status !== 0) return null;
  const root = probed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)[0];
  return root ?? null;
}
interface ResolveOptions {
  /**
   * `restore` is the operation that clears a claim, and `status` reports one
   * without mutating anything. They are the only two commands that may proceed
   * while a claim is outstanding -- see `restore-claim.ts`.
   */
  allowPendingRestore?: boolean;
}

/**
 * The `restore` freeze, in one place. Every command that resolves a workspace
 * goes through `resolveAndEnsure`, so the rule is enforced at a choke point
 * rather than by discipline at two dozen call sites -- which is the difference
 * between a rule and a habit.
 */
export function refuseIfRestorePending(entry: WorkspaceEntry, options: ResolveOptions = {}): WorkspaceEntry {
  if (options.allowPendingRestore) return entry;
  const claim = restoreClaimOf(entry);
  if (claim) throw new CliError(restorePendingRefusal(entry, claim), 1);
  return entry;
}
export async function resolveAndEnsure(
  deps: MainDeps,
  registry: Registry,
  explicitRoot: string | undefined,
  options: ResolveOptions = {},
): Promise<WorkspaceEntry> {
  const gitRoot = explicitRoot === undefined ? detectGitRoot(deps) : null;
  const resolution = resolveWorkspace({ explicitRoot, cwd: deps.cwd, registry, gitRoot });
  const existing = lookupWorkspace(registry, resolution.root);
  if (existing) return refuseIfRestorePending(existing, options);
  deps.stdout(`workspace is not registered:\n  root: ${resolution.root}\n`);
  deps.stdout(`plan: register root, create container and host tmux session on first start.\n`);
  const approved = await deps.confirm('approve this workspace scope?');
  if (!approved) throw new CliError('workspace scope was not approved; nothing was changed', 1);
  const canonical = defaultCanonicalize(resolution.root);
  for (const mount of [canonical]) {
    const problem = rejectForbiddenMount(mount, deps.homeDir);
    if (problem) throw new CliError(`refused mount ${mount}: ${problem}`, 2);
  }
  const hostConfig = loadHostConfig(deps.homeDir);
  // Registered inside the transaction, and re-checked there: the read above may predate a
  // concurrent registration of the same root, and the entry returned is the live one.
  const ensured = withRegistry(deps, (live) =>
    lookupWorkspace(live, canonical) ??
    registerWorkspace(live, canonical, [canonical], { homeDir: deps.homeDir, runtime: hostConfig.runtime, terminal: hostConfig.terminal }),
  );
  // Guarded after the transaction closes. A fresh registration cannot carry a claim, but the
  // re-found entry above is another run's, and that one can.
  return refuseIfRestorePending(ensured, options);
}
export function requireImage(entry: WorkspaceEntry): string {
  if (!entry.image) {
    throw new CliError(`no image selected for workspace ${entry.id}; run: sandbox image build`, 1);
  }
  return entry.image;
}
/** Roster windows with no live pane. Empty when the session is absent. */
export function deadRosterWindows(deps: MainDeps, entry: WorkspaceEntry): string[] {
  const term = selectTerminal(deps, entry);
  if (!term.sessionAlive(deps.runner, entry.session)) return [];
  const dead: string[] = [];
  for (const instance of entry.instances) {
    if (!term.paneAlive(deps.runner, entry.session, instance.window)) dead.push(instance.window);
  }
  return dead;
}
/**
 * The live internal flag of the workspace network, or null when the engine
 * cannot answer. Doctor is a diagnostic: the apple engine fails closed by
 * throwing on an undeterminable mode, which is right for a start path and
 * wrong for a probe, so a throw reads as "cannot determine" here.
 */
export function probeNetworkInternal(rt: RuntimeEngine, runner: CommandRunner, network: string): boolean | null {
  try {
    return rt.networkInternal(runner, network);
  } catch {
    return null;
  }
}
