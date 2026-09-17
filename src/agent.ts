export interface AgentDefinition {
  name: string;
  npmPackage: string | null;
  pinnedVersion: string;
  statePaths: string[];
  launch: string[];
}

export const UNSUPPORTED_AGENTS = ['grok', 'agy'] as const;

/**
 * Supported agents with pinned npm versions and verified state locations.
 * grok and agy have no verified linux-arm64 channel and are unsupported.
 */
export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    name: 'claude',
    npmPackage: null,
    pinnedVersion: 'native',
    statePaths: ['.claude'],
    launch: ['claude'],
  },
  {
    name: 'opencode',
    npmPackage: 'opencode-ai',
    pinnedVersion: '1.18.31',
    statePaths: ['.config/opencode'],
    launch: ['opencode'],
  },
  {
    name: 'codex',
    npmPackage: '@openai/codex',
    pinnedVersion: '0.154.0',
    statePaths: ['.codex'],
    launch: ['codex'],
  },
  {
    name: 'copilot',
    npmPackage: '@github/copilot',
    pinnedVersion: '1.0.85',
    statePaths: ['.copilot', '.config/github-copilot'],
    launch: ['copilot'],
  },
];

export function agentDefinition(name: string): AgentDefinition {
  const found = AGENT_DEFINITIONS.find((item) => item.name === name);
  if (!found) {
    if ((UNSUPPORTED_AGENTS as readonly string[]).includes(name)) {
      throw new Error(
        `agent is not supported in containers: ${name} has no verified linux install channel (host binaries are darwin-only)`,
      );
    }
    throw new Error(`unknown agent: ${name}`);
  }
  return found;
}

export interface VersionRunner {
  installedVersion: (npmPackage: string) => string | null;
  latestVersion: (npmPackage: string) => string | null;
}

export interface OutdatedEntry {
  agent: string;
  npmPackage: string;
  installed: string | null;
  pinned: string;
  latest: string | null;
}

export function outdatedAgents(runner: VersionRunner): OutdatedEntry[] {
  const entries: OutdatedEntry[] = [];
  for (const def of AGENT_DEFINITIONS) {
    if (!def.npmPackage) continue;
    entries.push({
      agent: def.name,
      npmPackage: def.npmPackage,
      installed: runner.installedVersion(def.npmPackage),
      pinned: def.pinnedVersion,
      latest: runner.latestVersion(def.npmPackage),
    });
  }
  return entries;
}
