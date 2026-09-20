import { agentHelp } from '../help.js';
import { UsageError } from '../cli.js';
import { outdatedEngines } from '../engines/agent.js';
import { formatVersionReceipt } from '../image.js';
import type { MainDeps } from './deps.js';
import { agentRegistry, selectRuntime } from './lookup.js';
import {
  buildUpgradeCandidate,
  makeVersionRunner,
  resolveAgentDefs,
  resolveAgentVersions,
} from './agents.js';
export async function agentCommand(deps: MainDeps, action: string, rest: string[]): Promise<number> {
  const agents = agentRegistry(deps);
  switch (action) {
    case 'help':
      deps.stdout(agentHelp());
      return 0;
    case 'list': {
      const listed = [...agents.values()].map((engine) => {
        const spec = engine.installSpec();
        return { name: engine.name, npmPackage: spec.npmPackage, minimumVersion: spec.minimumVersion, statePaths: engine.statePaths, launch: engine.launch };
      });
      if ((rest.includes('--json') || rest.includes('-j'))) {
        deps.stdout(`${JSON.stringify({ agents: listed }, null, 2)}\n`);
        return 0;
      }
      for (const item of listed) {
        const spec = agents.get(item.name)?.installSpec();
        deps.stdout(spec?.channel === 'native'
          ? `${item.name}: native ${item.minimumVersion} (installer)\n`
          : `${item.name}: ${item.npmPackage}@${item.minimumVersion} (npm)\n`);
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
        deps.stdout(`${item.agent}: installed ${item.installed ?? '(none)'}, minimum ${item.minimum}, latest ${item.latest ?? '(unknown)'}\n`);
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
      // An explicitly named engine whose latest cannot be resolved (agy:
      // latest-only, no feed) still rebuilds bare latest-first; only a bare
      // `all` with nothing resolvable is a no-op.
      const unresolved = names.filter((name) => !resolved.some((item) => item.def.name === name));
      if (Object.keys(overrides).length === 0 && (target === 'all' || unresolved.length === 0)) return 0;
      const tag = `sandbox-workspace:upgrade-${Date.now()}`;
      const built = buildUpgradeCandidate(deps, rt, agents.values(), overrides, tag);
      deps.stdout(`upgrade candidate ${built.tag} verified (${formatVersionReceipt(built.versions)}); running sessions are untouched.\nActivate explicitly with: sandbox image activate ${built.tag}\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown agent action: ${action}`);
  }
}
