import { agentEngine, type AgentEngine } from '../engines/agent.js';
import { acquireLock } from '../lock.js';
import { ensureInstanceHome, ensureReady } from '../lifecycle.js';
import type { HomeMode } from '../registry.js';
import { CliError, type MainDeps } from './deps.js';
import {
  loadRegistryOrThrow,
  requireImage,
  resolveAndEnsure,
  selectRuntime,
  selectTerminal,
  withRegistry,
} from './lookup.js';
import { launchEnvFor } from './agents.js';
import { reattachOrHint } from './ui.js';

export async function openShellWindow(
  deps: MainDeps,
  kind: 'bare' | 'shell',
  parsed: { name?: string; workspace?: string; homeMode?: HomeMode; noAttach?: boolean },
): Promise<number> {
  const name = kind === 'shell' ? (parsed.name ?? 'shell') : 'shell';
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
    const homeMode = kind === 'shell' ? parsed.homeMode : undefined;
    // The write is the transaction, and the mode is read back from the same
    // transaction: nothing here depends on the pre-lock snapshot.
    const shellMode = withRegistry(deps, (live) => {
      const target = live.workspaces[entry.id];
      if (!target) throw new CliError(`workspace is not registered: ${entry.root}`, 1);
      if (!target.instances.some((item) => item.name === name)) {
        target.instances.push({ name, kind: 'shell', window: name, homeMode });
        if (homeMode === 'fork' && !target.forks.includes(name)) target.forks.push(name);
      }
      return target.instances.find((item) => item.name === name)?.homeMode ?? homeMode;
    });
    const launchEnv = launchEnvFor(deps, entry, name, shellMode);
    ensureInstanceHome(deps.runner, rt, entry.container, name, shellMode);
    term.openAgentWindow(deps.runner, entry.session, name, rt.execVector(entry.container, { workdir: entry.root, argv: ['bash'], env: launchEnv }), entry.root);
  } finally {
    handle.release();
  }
  if (!parsed.noAttach) reattachOrHint(deps, term, entry.session);
  return 0;
}

export async function openAgentWindow(
  deps: MainDeps,
  agents: Map<string, AgentEngine>,
  parsed: { agent: string; name?: string; workspace?: string; homeMode?: HomeMode; forwarded: string[]; noAttach?: boolean },
): Promise<number> {
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
    // Re-checked inside the transaction: the pre-lock `same` may be stale, and the
    // mode must come from the entry that was actually written.
    const mode = withRegistry(deps, (live) => {
      const target = live.workspaces[entry.id];
      if (!target) throw new CliError(`workspace is not registered: ${entry.root}`, 1);
      const existing = target.instances.find((item) => item.name === name);
      if (existing && existing.kind !== parsed.agent) {
        throw new CliError(`instance name is occupied by another agent: ${name} runs ${existing.kind}`, 1);
      }
      if (!existing) {
        target.instances.push({ name, kind: parsed.agent, window: name, homeMode: parsed.homeMode });
        if (parsed.homeMode === 'fork' && !target.forks.includes(name)) target.forks.push(name);
      }
      return existing?.homeMode ?? parsed.homeMode;
    });
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
