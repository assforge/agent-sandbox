import { agentEngine, type AgentEngine, type VersionRunner } from '../engines/agent.js';
import { buildCandidate, INSPECT_VERSIONS_SCRIPT, parseInspectedVersions } from '../image.js';
import type { RuntimeEngine } from '../engines/runtime.js';
import { loadCredentials } from '../credentials.js';
import { homeDirForInstance } from '../lifecycle.js';
import type { WorkspaceEntry } from '../registry.js';
import { CliError, type MainDeps } from './deps.js';
interface ResolvedAgentVersion {
  def: AgentEngine;
  key: string;
  minimum: string;
  latest: string;
}

/** Resolve latest versions for engine defs, printing the per-engine lines. */
export function resolveAgentVersions(deps: MainDeps, defs: AgentEngine[], versionQueries: VersionRunner): ResolvedAgentVersion[] {
  const resolved: ResolvedAgentVersion[] = [];
  for (const def of defs) {
    const spec = def.installSpec();
    if (!spec.minimumVersion) {
      deps.stdout(`${def.name} has no minimum version and cannot be upgraded\n`);
      continue;
    }
    const latest = def.latestVersion(versionQueries);
    if (!latest) {
      deps.stdout(`${def.name}: latest unknown, keeping minimum ${spec.minimumVersion}\n`);
      continue;
    }
    resolved.push({ def, key: spec.npmPackage ?? def.name, minimum: spec.minimumVersion, latest });
    deps.stdout(`${def.name}: minimum ${spec.minimumVersion}, latest ${latest}\n`);
  }
  return resolved;
}
/** Build a verified upgrade candidate from version overrides. Returns the build receipt. */
export function buildUpgradeCandidate(
  deps: MainDeps,
  rt: RuntimeEngine,
  agents: Iterable<AgentEngine>,
  overrides: Record<string, string>,
  tag: string,
): { tag: string; versions: Record<string, string> } {
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
/** Resolve engine defs by name, failing with exit 1 on unknown agents. */
export function resolveAgentDefs(agents: Map<string, AgentEngine>, names: string[]): AgentEngine[] {
  return names.map((name) => {
    try {
      return agentEngine(agents, name);
    } catch (error) {
      throw new CliError((error as Error).message, 1);
    }
  });
}
/**
 * Per-instance launch environment: stored credentials plus HOME.
 * Shared mode points at the workspace home; fork and fresh isolate per
 * instance directory. HOME wins over any stored HOME key. Absent mode
 * means shared.
 */
export function launchEnvFor(deps: MainDeps, entry: WorkspaceEntry, instance: string, homeMode?: string): Record<string, string> {
  const stored = loadCredentials(deps.homeDir, entry.id, instance) ?? {};
  return { ...stored, HOME: homeDirForInstance(instance, homeMode) };
}

/** Version queries backed by npm and curl via argv vectors (no shell, no new deps). */
export function makeVersionRunner(deps: MainDeps): VersionRunner {
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
