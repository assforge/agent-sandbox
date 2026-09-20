/**
 * AgentEngine seam (D8). The sandbox core owns the governance problem
 * (which agent runs in which window with whose credentials); each engine
 * owns its install channel and launch shape. Consumers depend on this
 * interface, never on npm or vendor specifics.
 */
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

import { sandboxDir } from '../paths.js';

export type AgentInstallChannel = 'npm' | 'native';

export interface AgentInstallSpec {
  channel: AgentInstallChannel;
  npmPackage: string | null;
  minimumVersion: string | null;
}

export interface AgentEngine {
  readonly name: string;
  readonly statePaths: string[];
  readonly launch: string[];
  installSpec(): AgentInstallSpec;
  /** Latest releasable version, or null when it cannot be determined. */
  latestVersion(runner: VersionRunner): string | null;
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
    return { channel: 'npm', npmPackage: this.packageName, minimumVersion: this.version };
  }

  latestVersion(runner: VersionRunner): string | null {
    return runner.latestVersion(this.packageName);
  }
}

export class NativeAgentEngine implements AgentEngine {
  constructor(
    readonly name: string,
    readonly statePaths: string[],
    readonly launch: string[],
    private readonly version: string,
    private readonly endpoint: string | null,
  ) {}

  installSpec(): AgentInstallSpec {
    return { channel: 'native', npmPackage: null, minimumVersion: this.version };
  }

  latestVersion(runner: VersionRunner): string | null {
    if (!this.endpoint) return null;
    const text = runner.fetchText(this.endpoint);
    if (!text) return null;
    // Extract the leading version, never the whole line: a feed that gains
    // a suffix must not hand an invalid version to the installer.
    return text.trim().match(/^[0-9]+\.[0-9]+\.[0-9]+/)?.[0] ?? null;
  }
}

export interface AgentCatalogEntry {
  name: string;
  statePaths: string[];
  launch: string[];
  npmPackage: string | null;
  minimumVersion: string | null;
  latestEndpoint: string | null;
}

/** Built-in catalog: the fourteen verified agents, as data. */
export const BUILTIN_CATALOG: AgentCatalogEntry[] = [
  { name: 'claude', statePaths: ['.claude'], launch: ['claude'], npmPackage: null, minimumVersion: '2.1.276', latestEndpoint: 'https://downloads.claude.ai/claude-code-releases/latest' },
  { name: 'opencode', statePaths: ['.config/opencode'], launch: ['opencode'], npmPackage: 'opencode-ai', minimumVersion: '1.18.31', latestEndpoint: null },
  { name: 'codex', statePaths: ['.codex'], launch: ['codex'], npmPackage: '@openai/codex', minimumVersion: '0.155.1', latestEndpoint: null },
  { name: 'copilot', statePaths: ['.copilot', '.config/github-copilot'], launch: ['copilot'], npmPackage: '@github/copilot', minimumVersion: '1.0.86', latestEndpoint: null },
  { name: 'pi', statePaths: ['.pi/agent'], launch: ['pi'], npmPackage: '@earendil-works/pi-coding-agent', minimumVersion: '0.85.1', latestEndpoint: null },
  { name: 'grok', statePaths: ['.grok'], launch: ['grok'], npmPackage: null, minimumVersion: '1.0.34', latestEndpoint: 'https://x.ai/cli/stable' },
  { name: 'agy', statePaths: ['.gemini'], launch: ['agy'], npmPackage: null, minimumVersion: '1.2.7', latestEndpoint: null },
  { name: 'qwen', statePaths: ['.qwen'], launch: ['qwen'], npmPackage: '@qwen-code/qwen-code', minimumVersion: '0.24.1', latestEndpoint: null },
  { name: 'kimi', statePaths: ['.kimi-code'], launch: ['kimi'], npmPackage: '@moonshot-ai/kimi-code', minimumVersion: '2.0.2', latestEndpoint: null },
  { name: 'mimo', statePaths: ['.config/mimocode', '.local/share/mimocode'], launch: ['mimo'], npmPackage: '@mimo-ai/cli', minimumVersion: '0.1.14', latestEndpoint: null },
  { name: 'auggie', statePaths: ['.augment'], launch: ['auggie'], npmPackage: '@augmentcode/auggie', minimumVersion: '0.36.0', latestEndpoint: null },
  { name: 'cursor', statePaths: ['.cursor'], launch: ['cursor-agent', '--disable-auto-update'], npmPackage: null, minimumVersion: '2026.09.10', latestEndpoint: null },
  { name: 'devin', statePaths: ['.config/devin', '.local/share/devin'], launch: ['devin'], npmPackage: null, minimumVersion: '3000.10.31', latestEndpoint: null },
  { name: 'kiro', statePaths: ['.kiro'], launch: ['kiro-cli'], npmPackage: null, minimumVersion: '2.22.1', latestEndpoint: null },
];

/** Agents with no verified install channel. Named here, never constructed. Empty today; the guard stays for future names. */
export const UNSUPPORTED_AGENT_NAMES: readonly string[] = [];

function validateCatalogEntry(value: unknown): AgentCatalogEntry {
  if (typeof value !== 'object' || value === null) throw new Error('agent catalog entry must be an object');
  const record = value as Record<string, unknown>;
  const name = record['name'];
  const statePaths = record['statePaths'];
  const launch = record['launch'];
  const npmPackage = record['npmPackage'] ?? null;
  const minimumVersion = record['minimumVersion'] ?? null;
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`agent catalog entry has an invalid name: ${String(name)}`);
  }
  // Rejected at load, not only at lookup. agentEngines registers a user entry
  // under its own name, so a catalog that declares `grok` produces a *successful*
  // lookup and the guard in agentEngine never runs.
  if ((UNSUPPORTED_AGENT_NAMES as readonly string[]).includes(name)) {
    throw new Error(`agent catalog entry ${name} is not supported in containers (no verified linux install channel)`);
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
  if (minimumVersion !== null && typeof minimumVersion !== 'string') {
    throw new Error(`agent catalog entry ${name} has an invalid minimumVersion`);
  }
  if ((npmPackage === null) !== (minimumVersion === null) && npmPackage !== null) {
    throw new Error(`agent catalog entry ${name} must set npmPackage and minimumVersion together`);
  }
  if (npmPackage === null && minimumVersion === null) {
    throw new Error(`agent catalog entry ${name} needs a minimum version or an npm package`);
  }
  const latestEndpoint = record['latestEndpoint'] ?? null;
  if (latestEndpoint !== null && typeof latestEndpoint !== 'string') {
    throw new Error(`agent catalog entry ${name} has an invalid latestEndpoint`);
  }
  return { name, statePaths, launch, npmPackage, minimumVersion, latestEndpoint };
}

/** Load and validate an agent catalog document. Fails closed on any violation. */
export function loadAgentCatalog(document: unknown): AgentCatalogEntry[] {
  if (!Array.isArray(document)) throw new Error('agent catalog must be an array');
  return document.map(validateCatalogEntry);
}

function buildEngine(entry: AgentCatalogEntry): AgentEngine {
  if (entry.npmPackage && entry.minimumVersion) {
    return new NpmAgentEngine(entry.name, entry.statePaths, entry.launch, entry.npmPackage, entry.minimumVersion);
  }
  return new NativeAgentEngine(entry.name, entry.statePaths, entry.launch, entry.minimumVersion as string, entry.latestEndpoint);
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

/** User-supplied catalog documents under ~/.agent.sandbox/engines/*.json. */
export function userEnginesDir(homeDir: string): string {
  return join(sandboxDir(homeDir), 'engines');
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
  // Checked before the lookup, never after: a user catalog can register one of
  // these names, and a successful lookup would then skip the guard entirely.
  if ((UNSUPPORTED_AGENT_NAMES as readonly string[]).includes(name)) {
    throw new Error(
      `agent is not supported in containers: ${name} has no verified linux install channel (host binaries are darwin-only)`,
    );
  }
  const found = registry.get(name);
  if (!found) throw new Error(`unknown agent: ${name}`);
  return found;
}

export interface VersionRunner {
  installedVersion: (npmPackage: string) => string | null;
  latestVersion: (npmPackage: string) => string | null;
  fetchText: (url: string) => string | null;
}

export interface OutdatedEntry {
  agent: string;
  npmPackage: string | null;
  installed: string | null;
  minimum: string;
  latest: string | null;
}

export function outdatedEngines(runner: VersionRunner, engines: Iterable<AgentEngine>): OutdatedEntry[] {
  const entries: OutdatedEntry[] = [];
  for (const engine of engines) {
    const spec = engine.installSpec();
    if (!spec.minimumVersion) continue;
    entries.push({
      agent: engine.name,
      npmPackage: spec.npmPackage,
      installed: spec.npmPackage ? runner.installedVersion(spec.npmPackage) : null,
      minimum: spec.minimumVersion,
      latest: engine.latestVersion(runner),
    });
  }
  return entries;
}
