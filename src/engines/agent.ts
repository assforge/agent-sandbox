/**
 * AgentEngine seam (D8). The sandbox core owns the governance problem
 * (which agent runs in which window with whose credentials); each engine
 * owns its install channel and launch shape. Consumers depend on this
 * interface, never on npm or vendor specifics.
 */
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

export type AgentInstallChannel = 'npm' | 'native';

export interface AgentInstallSpec {
  channel: AgentInstallChannel;
  npmPackage: string | null;
  pinnedVersion: string | null;
}

export interface AgentEngine {
  readonly name: string;
  readonly statePaths: string[];
  readonly launch: string[];
  installSpec(): AgentInstallSpec;
}

export class NpmAgentEngine implements AgentEngine {
  constructor(
    readonly name: string,
    readonly statePaths: string[],
    readonly launch: string[],
    private readonly packageName: string,
    private readonly version: string,
  ) {}

  installSpec(): AgentInstallSpec {
    return { channel: 'npm', npmPackage: this.packageName, pinnedVersion: this.version };
  }
}

export class NativeAgentEngine implements AgentEngine {
  constructor(
    readonly name: string,
    readonly statePaths: string[],
    readonly launch: string[],
  ) {}

  installSpec(): AgentInstallSpec {
    return { channel: 'native', npmPackage: null, pinnedVersion: null };
  }
}

export interface AgentCatalogEntry {
  name: string;
  statePaths: string[];
  launch: string[];
  npmPackage: string | null;
  pinnedVersion: string | null;
}

/** Built-in catalog: the four verified agents, as data. */
export const BUILTIN_CATALOG: AgentCatalogEntry[] = [
  { name: 'claude', statePaths: ['.claude'], launch: ['claude'], npmPackage: null, pinnedVersion: null },
  { name: 'opencode', statePaths: ['.config/opencode'], launch: ['opencode'], npmPackage: 'opencode-ai', pinnedVersion: '1.18.31' },
  { name: 'codex', statePaths: ['.codex'], launch: ['codex'], npmPackage: '@openai/codex', pinnedVersion: '0.154.0' },
  { name: 'copilot', statePaths: ['.copilot', '.config/github-copilot'], launch: ['copilot'], npmPackage: '@github/copilot', pinnedVersion: '1.0.85' },
];

/** Agents with no verified install channel. Named here, never constructed. */
export const UNSUPPORTED_AGENT_NAMES = ['grok', 'agy'] as const;

function validateCatalogEntry(value: unknown): AgentCatalogEntry {
  if (typeof value !== 'object' || value === null) throw new Error('agent catalog entry must be an object');
  const record = value as Record<string, unknown>;
  const name = record['name'];
  const statePaths = record['statePaths'];
  const launch = record['launch'];
  const npmPackage = record['npmPackage'] ?? null;
  const pinnedVersion = record['pinnedVersion'] ?? null;
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`agent catalog entry has an invalid name: ${String(name)}`);
  }
  if (!Array.isArray(statePaths) || !statePaths.every((item): item is string => typeof item === 'string' && item.length > 0)) {
    throw new Error(`agent catalog entry ${name} has invalid statePaths`);
  }
  if (!Array.isArray(launch) || launch.length === 0 || !launch.every((item): item is string => typeof item === 'string' && item.length > 0)) {
    throw new Error(`agent catalog entry ${name} has invalid launch`);
  }
  if (npmPackage !== null && typeof npmPackage !== 'string') {
    throw new Error(`agent catalog entry ${name} has an invalid npmPackage`);
  }
  if (pinnedVersion !== null && typeof pinnedVersion !== 'string') {
    throw new Error(`agent catalog entry ${name} has an invalid pinnedVersion`);
  }
  if ((npmPackage === null) !== (pinnedVersion === null)) {
    throw new Error(`agent catalog entry ${name} must set npmPackage and pinnedVersion together`);
  }
  return { name, statePaths, launch, npmPackage, pinnedVersion };
}

/** Load and validate an agent catalog document. Fails closed on any violation. */
export function loadAgentCatalog(document: unknown): AgentCatalogEntry[] {
  if (!Array.isArray(document)) throw new Error('agent catalog must be an array');
  return document.map(validateCatalogEntry);
}

function buildEngine(entry: AgentCatalogEntry): AgentEngine {
  if (entry.npmPackage && entry.pinnedVersion) {
    return new NpmAgentEngine(entry.name, entry.statePaths, entry.launch, entry.npmPackage, entry.pinnedVersion);
  }
  return new NativeAgentEngine(entry.name, entry.statePaths, entry.launch);
}

/** Engine registry: built-in catalog plus user-supplied entries. Built-ins win name conflicts. */
export function agentEngines(extraCatalog: AgentCatalogEntry[] = []): Map<string, AgentEngine> {
  const registry = new Map<string, AgentEngine>();
  for (const entry of extraCatalog) {
    if (!registry.has(entry.name)) registry.set(entry.name, buildEngine(entry));
  }
  for (const entry of BUILTIN_CATALOG) registry.set(entry.name, buildEngine(entry));
  return registry;
}

/** User-supplied catalog documents under ~/.sandbox/engines/*.json. */
export function userEnginesDir(homeDir: string): string {
  return join(homeDir, '.sandbox', 'engines');
}

/** Load every user catalog document. An invalid file fails closed with its path. */
export function loadUserCatalog(homeDir: string): AgentCatalogEntry[] {
  let files: string[];
  try {
    files = readdirSync(userEnginesDir(homeDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: AgentCatalogEntry[] = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const path = join(userEnginesDir(homeDir), file);
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`agent catalog file is not valid JSON: ${path}: ${(error as Error).message}`);
    }
    try {
      entries.push(...loadAgentCatalog(document));
    } catch (error) {
      throw new Error(`agent catalog file is invalid: ${path}: ${(error as Error).message}`);
    }
  }
  return entries;
}

export function agentEngine(registry: Map<string, AgentEngine>, name: string): AgentEngine {
  const found = registry.get(name);
  if (!found) {
    if ((UNSUPPORTED_AGENT_NAMES as readonly string[]).includes(name)) {
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

export function outdatedEngines(runner: VersionRunner, engines: Iterable<AgentEngine>): OutdatedEntry[] {
  const entries: OutdatedEntry[] = [];
  for (const engine of engines) {
    const spec = engine.installSpec();
    if (spec.channel !== 'npm' || !spec.npmPackage || !spec.pinnedVersion) continue;
    entries.push({
      agent: engine.name,
      npmPackage: spec.npmPackage,
      installed: runner.installedVersion(spec.npmPackage),
      pinned: spec.pinnedVersion,
      latest: runner.latestVersion(spec.npmPackage),
    });
  }
  return entries;
}
