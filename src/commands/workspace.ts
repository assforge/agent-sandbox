import { existsSync } from 'node:fs';
import { BackupRefusedError, backupWorkspace, copyRestoreHome, planRestore } from '../backup.js';
import { redactedConfig } from '../config.js';
import { dryRunMigration } from '../migrate.js';
import { loadHostConfig } from '../hostconfig.js';
import {
  lookupWorkspace,
  registerWorkspace,
  type WorkspaceEntry,
} from '../registry.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalAction, UsageError } from '../cli.js';
import { workspaceHelp } from '../help.js';
import { defaultCanonicalize, resolveWorkspace } from '../resolve.js';
import { restoreClaimOf, restoreClaimState, restoreRerunCommand } from '../restore-claim.js';
import { acquireLock } from '../lock.js';
import { ensureInstanceHome, ensureReady, stopWorkspace } from '../lifecycle.js';
import { agentEngine } from '../engines/agent.js';
import { RUNTIME_ENGINES, type RuntimeEngine } from '../engines/runtime.js';
import { TERMINAL_ENGINES } from '../engines/terminal.js';
import { activateImage } from '../image.js';
import { linkHelp, unlinkHelp } from '../help.js';
import { CliError, type MainDeps } from './deps.js';
import {
  agentRegistry,
  detectGitRoot,
  loadRegistryOrThrow,
  refuseIfRestorePending,
  requireImage,
  resolveAndEnsure,
  selectRuntime,
  selectTerminal,
  withRegistry,
} from './lookup.js';
import {
  buildUpgradeCandidate,
  launchEnvFor,
  makeVersionRunner,
  resolveAgentDefs,
  resolveAgentVersions,
} from './agents.js';
import { dropMountFromEntry, vettedMount } from './mounts.js';
import { reattachOrHint, takeRestOption } from './ui.js';
import { pruneForks, unregisterWorkspace } from './instances.js';
/** Read the workspace id from a backup manifest without touching the registry. */function peekBackupId(outputDir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(outputDir, 'workspace.json'), 'utf8')) as { id?: unknown };
    if (typeof parsed.id !== 'string' || !parsed.id) throw new Error('bad id');
    return parsed.id;
  } catch {
    throw new CliError(`backup is missing or invalid: ${join(outputDir, 'workspace.json')}`, 1);
  }
}
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
        // The image pointer IS the intent: recorded in a short transaction before the
        // slow work, so a crash leaves registry = new image / container = old image and
        // the next start recreates it (the recreation condition on the image id).
        withRegistry(deps, (live) => {
          const target = live.workspaces[entry.id];
          if (!target) throw new CliError(`workspace is not registered: ${entry.root}`, 1);
          activateImage(target, built.tag);
        });
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
      withRegistry(deps, (live) => {
        const target = live.workspaces[entry.id];
        if (!target) throw new CliError(`workspace is not registered: ${entry.root}`, 1);
        if (!target.mounts.includes(canonical)) target.mounts.push(canonical);
      });
      deps.stdout(`mount ${canonical} added to ${entry.id}; applies on next start\n`);
      return 0;
    }
    case 'unmount': {
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
      // Exempt from the claim it is about to write, and from one left by a crashed
      // predecessor: this command is what clears it.
      const entry = await resolveAndEnsure(deps, registry, workspace, { allowPendingRestore: true });
      const rt = selectRuntime(deps, entry);
      const manifestId = peekBackupId(input);
      if (manifestId !== entry.id) {
        throw new CliError(`backup belongs to ${manifestId}, not to ${entry.id}; nothing was changed`, 1);
      }
      const approved = await deps.confirm(`restore ${entry.id} from ${input}? Running state will be overwritten.`);
      if (!approved) throw new CliError('restore cancelled; nothing was changed', 1);
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        // The registry half is a short transaction. The volume copy is the slow half and
        // is deliberately outside it, so the registry lock is never held across a copy.
        //
        // The claim is written *before* the copy, because a crash during the copy is the
        // only case nothing else on disk would report. A re-run overwrites it in this same
        // transaction and clears it in the one below, which is why stop-and-re-run is safe:
        // copying over a half-copy completes it.
        const restored = withRegistry(deps, (live) => {
          let target: WorkspaceEntry;
          try {
            target = planRestore(live, input, deps.homeDir);
          } catch (error) {
            // A refused backup path is the restore-side twin of a refused
            // mount at registration, which exits 2.
            if (error instanceof BackupRefusedError) throw new CliError(error.message, 2);
            throw error;
          }
          if (target.id !== entry.id) {
            throw new CliError(`backup identity changed during restore; nothing was saved`, 1);
          }
          target.pendingOperation = {
            kind: 'restore',
            source: input,
            startedAt: new Date().toISOString(),
            pid: process.pid,
          };
          return target;
        });
        copyRestoreHome(
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
          restored,
          input,
        );
        // The copy completed, so the home is determinate again. Cleared in a second short
        // transaction, after the slow work -- never held across it.
        withRegistry(deps, (live) => {
          const target = live.workspaces[restored.id];
          if (target) delete target.pendingOperation;
        });
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
