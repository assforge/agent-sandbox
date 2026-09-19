import { existsSync } from 'node:fs';
import { redactedConfig } from '../config.js';
import { loadHostConfig } from '../hostconfig.js';
import { lookupWorkspace, registerWorkspace } from '../registry.js';
import { canonicalAction, UsageError } from '../cli.js';
import { linkHelp, unlinkHelp, workspaceHelp } from '../help.js';
import { defaultCanonicalize } from '../resolve.js';
import { restoreClaimOf, restoreClaimState, restoreRerunCommand } from '../restore-claim.js';
import { CliError, type MainDeps } from './deps.js';
import {
  loadRegistryOrThrow,
  refuseIfRestorePending,
  resolveAndEnsure,
  selectRuntime,
  selectTerminal,
  withRegistry,
} from './lookup.js';
import { takeRestOption } from './ui.js';
import { unregisterWorkspace } from './instances.js';
import { workspaceAttach, workspaceClose, workspaceExec, workspaceLogs, workspacePrune, workspaceReopen } from './workspace-instances.js';
import { workspaceConfigure, workspaceMount, workspaceUnmount } from './workspace-config.js';
import { workspaceBackup, workspaceMigrate, workspaceRestore } from './workspace-state.js';
import { workspaceRestart, workspaceStart, workspaceStop, workspaceUpgrade } from './workspace-lifecycle.js';
export async function workspaceCommand(deps: MainDeps, action: string, rest: string[], workspace: string | undefined): Promise<number> {
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
      // Reports a claim rather than refusing on one: it takes no workspace lock and
      // mutates nothing, so it is one of the two commands a claim does not freeze.
      const entry = await resolveAndEnsure(deps, registry, workspace, { allowPendingRestore: true });
      const rt = selectRuntime(deps, entry);
      const term = selectTerminal(deps, entry);
      const state = rt.containerState(deps.runner, entry.container, entry.id);
      const alive = term.sessionAlive(deps.runner, entry.session);
      const windows = alive ? term.listWindows(deps.runner, entry.session) : [];
      const describe = (name: string, kind: string, homeMode?: string): string => {
        const home = homeMode ?? 'shared';
        if (!alive) return `${name}(${kind}:${home}, session absent)`;
        return windows.includes(name) ? `${name}(${kind}:${home})` : `${name}(${kind}:${home}, window missing)`;
      };
      const claim = restoreClaimOf(entry);
      if ((rest.includes('--json') || rest.includes('-j'))) {
        deps.stdout(`${JSON.stringify({ id: entry.id, container: state, session: alive, restore: claim ? { state: restoreClaimState(claim), source: claim.source, startedAt: claim.startedAt } : null, instances: entry.instances.map((i) => ({ name: i.name, kind: i.kind, window: windows.includes(i.window), home: i.homeMode ?? 'shared' })) }, null, 2)}\n`);
        return 0;
      }
      // Printed only when there is something to say, so the ordinary output is unchanged.
      const claimLine = claim ? `  restore: ${restoreClaimState(claim)} -- ${restoreRerunCommand(claim)}\n` : '';
      deps.stdout(`workspace ${entry.id}\n  container: ${state}\n  session: ${alive ? 'alive' : 'absent'}\n${claimLine}  instances: ${entry.instances.map((i) => describe(i.name, i.kind, i.homeMode)).join(', ') || '(none)'}\n`);
      return 0;
    }
    case 'link': {
      const root = takeRestOption(rest, ['--root', '-r']);
      if (!root) throw new UsageError('workspace link requires --root <path>');
      if (!existsSync(root)) {
        throw new CliError(`workspace root does not exist: ${root}`, 2);
      }
      const canonical = defaultCanonicalize(root);
      const hostConfig = loadHostConfig(deps.homeDir);
      // The second of the two `link` arms, guarded identically. They are separate arms
      // because one resolves from `--root` and the other from the parsed top level, and
      // that duplication is exactly where a single-site rule goes missing.
      const entry = withRegistry(deps, (live) => {
        const found = lookupWorkspace(live, canonical);
        if (found) return refuseIfRestorePending(found);
        return registerWorkspace(live, canonical, [canonical], { homeDir: deps.homeDir, runtime: hostConfig.runtime, terminal: hostConfig.terminal });
      });
      deps.stdout(`registered ${entry.id} for ${canonical}\n`);
      return 0;
    }
    case 'unlink': {
      const root = workspace ? defaultCanonicalize(workspace) : defaultCanonicalize(deps.cwd);
      return unregisterWorkspace(deps, registry, root);
    }
    case 'start': return workspaceStart(deps, registry, workspace);
    case 'stop': return workspaceStop(deps, registry, workspace);
    case 'restart': return workspaceRestart(deps, registry, workspace);
    case 'upgrade': return workspaceUpgrade(deps, registry, rest, workspace);
    case 'close': return workspaceClose(deps, registry, rest, workspace);
    case 'attach': return workspaceAttach(deps, registry, workspace);
    case 'logs': return workspaceLogs(deps, registry, rest, workspace);
    case 'reopen': return workspaceReopen(deps, registry, rest, workspace);
    case 'exec': return workspaceExec(deps, registry, rest, workspace);
    case 'configure': return workspaceConfigure(deps, registry, rest, workspace);
    case 'mount': return workspaceMount(deps, registry, rest, workspace);
    case 'unmount': return workspaceUnmount(deps, registry, rest, workspace);
    case 'prune': return workspacePrune(deps, registry, rest, workspace);
    case 'backup': return workspaceBackup(deps, registry, rest, workspace);
    case 'restore': return workspaceRestore(deps, registry, rest, workspace);
    case 'migrate': return workspaceMigrate(deps, registry, rest, workspace);
    default:
      throw new UsageError(`unknown workspace action: ${action}`);
  }
}

export async function linkWorkspace(deps: MainDeps, root: string | undefined, help: boolean): Promise<number> {
  if (help) {
    deps.stdout(linkHelp());
    return 0;
  }
  const raw = root ?? deps.cwd;
  if (!existsSync(raw)) {
    throw new CliError(`workspace root does not exist: ${raw}`, 2);
  }
  const canonical = defaultCanonicalize(raw);
  const hostConfig = loadHostConfig(deps.homeDir);
  // Guarded inside the transaction: a `link` on an already-registered workspace is a
  // no-op mutation, and refusing it here means a refusal never leaves a write behind.
  const entry = withRegistry(deps, (live) => {
    const found = lookupWorkspace(live, canonical);
    if (found) return refuseIfRestorePending(found);
    return registerWorkspace(live, canonical, [canonical], { homeDir: deps.homeDir, runtime: hostConfig.runtime, terminal: hostConfig.terminal });
  });
  deps.stdout(`registered ${entry.id} for ${canonical}\n`);
  return 0;
}

export async function unlinkWorkspace(deps: MainDeps, root: string | undefined, help: boolean): Promise<number> {
  if (help) {
    deps.stdout(unlinkHelp());
    return 0;
  }
  const registry = loadRegistryOrThrow(deps);
  const raw = root ?? deps.cwd;
  const resolved = defaultCanonicalize(raw);
  return unregisterWorkspace(deps, registry, resolved);
}
