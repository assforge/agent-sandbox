import { acquireLock } from '../lock.js';
import { ensureReady, stopWorkspace } from '../lifecycle.js';
import { CliError, type MainDeps } from './deps.js';
import {
  agentRegistry,
  requireImage,
  resolveAndEnsure,
  selectRuntime,
  withRegistry,
} from './lookup.js';
import { activateImage, formatVersionReceipt } from '../image.js';
import { buildUpgradeCandidate, makeVersionRunner, resolveAgentDefs, resolveAgentVersions } from './agents.js';
import type { Registry } from '../registry.js';
export async function workspaceStart(deps: MainDeps, registry: Registry, workspace: string | undefined): Promise<number> {
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
export async function workspaceStop(deps: MainDeps, registry: Registry, workspace: string | undefined): Promise<number> {
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
export async function workspaceRestart(deps: MainDeps, registry: Registry, workspace: string | undefined): Promise<number> {
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
export async function workspaceUpgrade(deps: MainDeps, registry: Registry, rest: string[], workspace: string | undefined): Promise<number> {
  const target = rest[0] ?? 'all';
  const entry = await resolveAndEnsure(deps, registry, workspace);
  const agents = agentRegistry(deps);
  const names = target === 'all' ? [...agents.keys()] : [target];
  const versionQueries = makeVersionRunner(deps);
  const resolved = resolveAgentVersions(deps, resolveAgentDefs(agents, names), versionQueries);
  // Nothing to do when the image already recorded these exact versions.
  // Entries without a recording predate it: rebuild once, then recorded.
  const recorded = entry.agentVersions ?? null;
  const drifted = resolved.filter((item) => item.latest !== recorded?.[item.key]);
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
      activateImage(target, built.tag, built.versions);
    });
    stopWorkspace(deps.runner, rt, entry);
    ensureReady(deps.runner, rt, entry, { image: built.tag });
    deps.stdout(`workspace ${entry.id} upgraded to ${built.tag} (${formatVersionReceipt(built.versions)}; container ${entry.container})\n`);
    return 0;
  } finally {
    handle.release();
  }
}
