import { imageHelp } from '../help.js';
import { UsageError } from '../cli.js';
import { buildCandidate, buildInspectScript, engineProbeKeys, parseInspectedVersions } from '../image.js';
import { RUNTIME_ENGINES, type RuntimeEngine } from '../engines/runtime.js';
import { activateImage, formatVersionReceipt, rollbackImage } from '../image.js';
import { acquireLock } from '../lock.js';
import { loadHostConfig } from '../hostconfig.js';
import { lookupWorkspace } from '../registry.js';
import { defaultCanonicalize } from '../resolve.js';
import { CliError, type MainDeps } from './deps.js';
import { agentRegistry, loadRegistryOrThrow, resolveAndEnsure, selectRuntime, withRegistry } from './lookup.js';

/** Best-effort version recording for activation. Null when the image cannot be probed; activation never depends on it. */
function probeImageVersions(deps: MainDeps, rt: RuntimeEngine, image: string): Record<string, string> | null {
  const script = buildInspectScript(agentRegistry(deps).values());
  const probed = rt.runOneShot(deps.runner, image, { SANDBOX_GENERATION: 'record', SANDBOX_CONFIG_FINGERPRINT: 'record' }, ['sh', '-c', script]);
  if (probed.status !== 0) return null;
  return parseInspectedVersions(probed.stdout, engineProbeKeys(agentRegistry(deps).values()));
}
export async function imageCommand(deps: MainDeps, action: string, rest: string[], workspace: string | undefined): Promise<number> {  const registry = loadRegistryOrThrow(deps);
  const agents = agentRegistry(deps);  switch (action) {
    case 'help':
      deps.stdout(imageHelp());
      return 0;
    case 'list': {
      const runtimes = new Set(Object.values(registry.workspaces).map((item) => item.runtime));
      runtimes.add(loadHostConfig(deps.homeDir).runtime);
      const containers: string[] = [];
      const referenced = new Set<string>();
      for (const entry of Object.values(registry.workspaces)) {
        if (entry.image) referenced.add(entry.image);
        if (entry.previousImage) referenced.add(entry.previousImage);
      }
      const unreferenced: string[] = [];
      for (const name of runtimes) {
        const engine = RUNTIME_ENGINES[name];
        if (!engine) continue;
        containers.push(...engine.listManagedContainers(deps.runner));
        for (const image of engine.listWorkspaceImages(deps.runner)) {
          if (!referenced.has(image) && !unreferenced.includes(image)) unreferenced.push(image);
        }
      }
      const entries = Object.values(registry.workspaces).map((entry) => ({ id: entry.id, image: entry.image, container: entry.container }));
      if ((rest.includes('--json') || rest.includes('-j'))) {
        deps.stdout(`${JSON.stringify({ images: entries, containers, unreferenced }, null, 2)}\n`);
        return 0;
      }
      for (const item of entries) {
        deps.stdout(`${item.id}: ${item.image ?? '(none)'} (${item.container})\n`);
      }
      for (const image of unreferenced) {
        deps.stdout(`unreferenced: ${image} (remove with: sandbox image prune)\n`);
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
            const probed = rt.runOneShot(deps.runner, candidate, { SANDBOX_GENERATION: 'inspect', SANDBOX_CONFIG_FINGERPRINT: 'inspect' }, ['sh', '-c', buildInspectScript(agents.values())]);
            return parseInspectedVersions(probed.stdout, engineProbeKeys(agents.values()));
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
      deps.stdout(`candidate ${built.tag} verified (${formatVersionReceipt(built.versions)}); activate explicitly with: sandbox image activate ${built.tag}\n`);
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
        const recorded = probeImageVersions(deps, rt, digest);
        const activation = withRegistry(deps, (live) => {
          const target = live.workspaces[entry.id];
          if (!target) throw new CliError(`workspace is not registered: ${entry.root}`, 1);
          return activateImage(target, digest, recorded ?? undefined);
        });
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
      // Best-effort recording of the image we are rolling back to. Applied
      // inside the transaction only when nothing re-pointed it meanwhile.
      const rt = selectRuntime(deps, entry);
      const previous = entry.previousImage;
      const recorded = previous ? probeImageVersions(deps, rt, previous) : null;
      const handle = acquireLock(deps.lockDir, entry.id);
      try {
        const activation = withRegistry(deps, (live) => {
          const target = live.workspaces[entry.id];
          if (!target) throw new CliError(`workspace is not registered: ${entry.root}`, 1);
          try {
            return rollbackImage(target, target.previousImage === previous ? (recorded ?? undefined) : undefined);
          } catch (error) {
            throw new CliError((error as Error).message, 1);
          }
        });
        deps.stdout(`rolled back to ${activation.current}; data migrations are not reversed\n`);
        return 0;
      } finally {
        handle.release();
      }
    }
    case 'prune': {
      // Keep every image a workspace still references: current for the next
      // start, previous for rollback. Everything else sandbox minted is fair
      // game, across every runtime in use.
      const keep = new Set<string>();
      for (const entry of Object.values(registry.workspaces)) {
        if (entry.image) keep.add(entry.image);
        if (entry.previousImage) keep.add(entry.previousImage);
      }
      const runtimes = new Set(Object.values(registry.workspaces).map((item) => item.runtime));
      runtimes.add(loadHostConfig(deps.homeDir).runtime);
      const stale: Array<{ runtime: RuntimeEngine; image: string }> = [];
      for (const name of runtimes) {
        const engine = RUNTIME_ENGINES[name];
        if (!engine) continue;
        for (const image of engine.listWorkspaceImages(deps.runner)) {
          if (!keep.has(image)) stale.push({ runtime: engine, image });
        }
      }
      if (stale.length === 0) {
        deps.stdout('no unreferenced workspace images\n');
        return 0;
      }
      const approved = await deps.confirm(`remove ${stale.length} unreferenced workspace image(s)?`);
      if (!approved) throw new CliError('prune cancelled; nothing was changed', 1);
      let removed = 0;
      for (const { runtime, image } of stale) {
        try {
          runtime.removeImage(deps.runner, image);
        } catch (error) {
          throw new CliError((error as Error).message, 1);
        }
        deps.stdout(`pruned ${image}\n`);
        removed += 1;
      }
      deps.stdout(`pruned ${removed} image(s), kept ${keep.size} referenced\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown image action: ${action}`);
  }
}
