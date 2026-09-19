import type { RuntimeEngine } from '../engines/runtime.js';
import type { Registry, WorkspaceEntry } from '../registry.js';
import { acquireLock } from '../lock.js';
import { lookupWorkspace } from '../registry.js';
import { stopWorkspace } from '../lifecycle.js';
import { CliError, type MainDeps } from './deps.js';
import {
  loadRegistryOrThrow,
  refuseIfRestorePending,
  requireImage,
  selectRuntime,
  selectTerminal,
  withRegistry,
} from './lookup.js';
/** Remove orphan fork state: forks with no roster entry left.
 * Fork names are validated at the restore boundary (src/backup.ts), and the
 * path below is passed to the one-shot as an argv element rather than
 * interpolated into the shell script, so neither a crafted registry nor a
 * tampered backup can turn a name into executable code.
 * Victims are chosen before confirmation but re-checked under the lock:
 * another invocation can reopen a name while the prompt is on screen.
 * Credential files are never touched: clear them explicitly.
 */
export async function pruneForks(deps: MainDeps, targets: WorkspaceEntry[]): Promise<number> {
  const victims: { entry: WorkspaceEntry; rt: RuntimeEngine; fork: string }[] = [];
  for (const entry of targets) {
    // Refused before the prompt, so a frozen workspace is never asked about.
    refuseIfRestorePending(entry);
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
  const skipped: string[] = [];
  const pruned: string[] = [];
  for (const item of victims) {
    const handle = acquireLock(deps.lockDir, item.entry.id);
    try {
      // Read for the guard and for the one-shot's inputs. The authoritative re-check is
      // the transaction below; this read only decides whether to attempt the delete.
      const pre = loadRegistryOrThrow(deps).workspaces[item.entry.id];
      if (!pre) throw new CliError(`workspace is not registered: ${item.entry.root}`, 1);
      // Authoritative re-check under the lock, before the one-shot below.
      refuseIfRestorePending(pre);
      if (!pre.forks.includes(item.fork)) continue;
      if (pre.instances.some((instance) => instance.name === item.fork)) {
        skipped.push(item.fork);
        continue;
      }
      // The home volume rides along at /v: without it the one-shot would
      // prune an ephemeral container filesystem and report success.
      //
      // The delete comes BEFORE the claim: `rm -rf` is idempotent (it exits 0 on an
      // absent path), so a crash between the two is repaired by re-running -- a no-op
      // one-shot, then the claim.
      const probed = item.rt.runOneShot(
        deps.runner,
        requireImage(pre),
        { SANDBOX_GENERATION: 'prune', SANDBOX_CONFIG_FINGERPRINT: 'prune' },
        ['sh', '-c', 'rm -rf -- "$1"', 'sh', `/v/instances/${item.fork}`],
        { mounts: [{ source: pre.homeVolume, target: '/v' }] },
      );
      if (probed.status !== 0) throw new CliError(`cannot prune fork ${item.fork}`, 1);
      withRegistry(deps, (live) => {
        const target = live.workspaces[item.entry.id];
        if (!target) return;
        if (target.instances.some((instance) => instance.name === item.fork)) return;
        target.forks = target.forks.filter((fork) => fork !== item.fork);
        pruned.push(`${item.entry.id}:${item.fork}`);
      });
    } finally {
      handle.release();
    }
  }
  if (skipped.length > 0) {
    deps.stderr(`skipped fork(s) that became live while confirming: ${skipped.join(', ')}\n`);
  }
  if (pruned.length === 0) {
    deps.stdout(
      skipped.length > 0
        ? 'no forks pruned; every victim became live while confirming\n'
        : 'no forks pruned; nothing remained eligible\n',
    );
    return 0;
  }
  deps.stdout(`pruned forks: ${pruned.join(', ')}; credential files kept\n`);
  return 0;
}
/** Remove a workspace registration. Stops the container and kills the
 * session after confirmation when anything is live. Volumes, networks,
 * images, and credential files are always kept: unregister forgets the
 * mapping, it never purges data. */
export async function unregisterWorkspace(deps: MainDeps, registry: Registry, root: string): Promise<number> {
  const entry = lookupWorkspace(registry, root);
  if (!entry) {
    throw new CliError(`workspace is not registered: ${root}`, 1);
  }
  // Refused before the prompt, so a frozen workspace is never asked about.
  refuseIfRestorePending(entry);
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
    // Authoritative re-check under the lock: the phase-1 read may predate a claim written
    // by a restore that then died. It precedes every resource change below.
    const locked = loadRegistryOrThrow(deps).workspaces[entry.id];
    if (locked) refuseIfRestorePending(locked);
    if (state === 'running') {
      stopWorkspace(deps.runner, rt, entry);
      state = 'stopped';
    }
    if (state === 'stopped') rt.removeContainer(deps.runner, entry.container);
    if (term.sessionAlive(deps.runner, entry.session)) term.killSession(deps.runner, entry.session);
    withRegistry(deps, (live) => {
      delete live.workspaces[entry.id];
    });
    deps.stdout(`unregistered ${entry.id}; volumes, networks, images, and credentials kept\n`);
    return 0;
  } finally {
    handle.release();
  }
}
