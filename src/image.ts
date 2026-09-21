import type { AgentEngine } from './engines/agent.js';
import type { WorkspaceEntry } from './registry.js';

export interface ImageBuildPlan {
  contextDir: string;
  tag: string;
  buildArgs: Record<string, string>;
}

export interface ImageRunner {
  buildImage: (plan: ImageBuildPlan) => string;
  inspectBinaryVersions: (tag: string) => Record<string, string>;
  verifyCandidate: (tag: string) => boolean;
}

/**
 * Version probe shared by upgrade inspect and the doctor drift check.
 *
 * Keyed, not positional: every binary reports as `key=<first output line>`
 * so a missing, extra, or multi-line output can never shift values into the
 * wrong slots. Lines without a `key=` prefix (spillover hints, warnings)
 * are ignored. A key whose binary is absent simply has no entry, which the
 * floor gate and the drift check both treat as missing, never as another
 * engine's version. Built from the engine set so user-catalog engines ride
 * the same probe.
 */
/** Single-quote a shell word. Catalog-controlled strings interpolated below. */
function shq(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export function buildInspectScript(engines: Iterable<AgentEngine>): string {
  const parts: string[] = [];
  for (const engine of engines) {
    const key = engine.installSpec().npmPackage ?? engine.name;
    const binary = engine.launch[0] ?? engine.name;
    parts.push(`echo ${shq(key)}="$(${shq(binary)} --version 2>/dev/null | head -n 1)"`);
  }
  return parts.join('; ');
}

/** Probe keys for an engine set: exactly what the script reports. */
export function engineProbeKeys(engines: Iterable<AgentEngine>): string[] {
  const keys: string[] = [];
  for (const engine of engines) {
    keys.push(engine.installSpec().npmPackage ?? engine.name);
  }
  return keys;
}

/** Per-key output normalizers, keyed like the probe. Unknown keys are ignored. */
const VERSION_TRIMS: Array<[string, (line: string) => string]> = [
  ['claude', (line) => line.split(' ')[0] as string],
  ['@openai/codex', (line) => line.replace(/^codex-cli /, '')],
  ['@github/copilot', (line) => line.replace(/^GitHub Copilot CLI /, '').replace(/\.$/, '')],
  ['grok', (line) => line.replace(/^grok /, '').split(' ')[0] as string],
  ['@augmentcode/auggie', (line) => line.split(' ')[0] as string],
  ['cursor', (line) => line.replace(/^cursor-agent /, '').split('-')[0] as string],
  ['devin', (line) => line.replace(/^devin /, '').split(' ')[0] as string],
  ['kiro', (line) => line.replace(/^kiro-cli /, '').split(' ')[0] as string],
  ['aider', (line) => line.replace(/^aider /, '')],
];

/** Parse the inspect probe into versions keyed for buildCandidate. Only keys in the allowed set are kept: stray lines never enter a recording. */
export function parseInspectedVersions(stdout: string, allowed: Iterable<string>): Record<string, string> {
  const allow = new Set(allowed);
  const trims = new Map(VERSION_TRIMS);
  const versions: Record<string, string> = {};
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1).trim();
    if (key.length === 0 || value.length === 0 || !allow.has(key)) continue;
    // First wins: a duplicated key keeps the earliest report rather than
    // letting a later line overwrite it.
    if (Object.hasOwn(versions, key)) continue;
    // First wins: a duplicated key keeps the earliest report rather than
    // letting a later line overwrite it.

    const trim = trims.get(key);
    versions[key] = trim ? trim(value) : value;
  }
  return versions;
}

/**
 * Numeric X.Y.Z comparison. Null when either side is not three dot-separated
 * integers: an unparseable version never satisfies a floor and never equals
 * another version, so both the build gate and the drift check fail closed.
 */
export function compareVersions(left: string, right: string): number | null {
  const parse = (value: string): [number, number, number] | null => {
    const parts = value.trim().split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[0-9]+$/.test(part))) return null;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isSafeInteger(n))) return null;
    return nums as [number, number, number];
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** True when installed meets the floor. Unparseable input fails closed. */
export function versionAtLeast(installed: string, minimum: string): boolean {
  return compareVersions(installed, minimum) !== null && (compareVersions(installed, minimum) as number) >= 0;
}

/** Build receipt: resolved versions in probe order. */
export function formatVersionReceipt(versions: Record<string, string>): string {
  return Object.entries(versions)
    .map(([name, version]) => `${name}@${version}`)
    .join(', ');
}

/**
 * Build a candidate without secrets. Never retags the selected image.
 *
 * Latest-first: the image installs whatever the channels currently serve;
 * version overrides are passed through only when the caller pins one
 * (upgrade flows, emergencies). The gate is structural, not exact: every
 * engine must report a parseable version at or above its catalog floor.
 * The resolved versions are returned as the build receipt.
 */
export function buildCandidate(
  runner: ImageRunner,
  contextDir: string,
  candidateTag: string,
  engines: Iterable<AgentEngine>,
  versionOverrides: Record<string, string> = {},
): { tag: string; versions: Record<string, string> } {
  const buildArgs: Record<string, string> = {};
  const floors: Record<string, string> = {};
  for (const engine of engines) {
    const spec = engine.installSpec();
    if (!spec.minimumVersion) continue;
    const override = (spec.npmPackage ? versionOverrides[spec.npmPackage] : undefined)
      ?? versionOverrides[engine.name];
    if (override !== undefined) buildArgs[`${engine.name.toUpperCase()}_VERSION`] = override;
    floors[spec.npmPackage ?? engine.name] = spec.minimumVersion;
  }
  const tag = runner.buildImage({ contextDir, tag: candidateTag, buildArgs });
  const versions = runner.inspectBinaryVersions(tag);
  for (const [npmPackage, minimum] of Object.entries(floors)) {
    const got = versions[npmPackage];
    if (!got) {
      throw new Error(`candidate image reports no version for ${npmPackage}, minimum ${minimum}`);
    }
    if (!versionAtLeast(got, minimum)) {
      throw new Error(`candidate image reports ${npmPackage}@${got}, below minimum ${minimum}`);
    }
  }
  if (!runner.verifyCandidate(tag)) {
    throw new Error(`candidate image failed verification with independent state: ${tag}`);
  }
  return { tag, versions };
}

export interface Activation {
  previous: string | null;
  current: string;
}

/** Activation is explicit and recorded only after the candidate verifies. */
export function recordActivation(previous: string | null, candidate: string): Activation {
  return { previous, current: candidate };
}

/** Explicit cutover: the running image becomes the rollback target. Records the inspected versions, or clears a stale recording the probe could not refresh. */
export function activateImage(entry: WorkspaceEntry, candidate: string, versions?: Record<string, string>): Activation {
  const activation = recordActivation(entry.image, candidate);
  entry.previousImage = activation.previous;
  entry.image = activation.current;
  if (versions) entry.agentVersions = versions;
  else delete entry.agentVersions;
  return activation;
}

/** Rollback re-activates the previous digest. It never reverses a data migration. */
export function rollbackImage(entry: WorkspaceEntry, versions?: Record<string, string>): Activation {
  if (!entry.previousImage) {
    throw new Error(`no previous image recorded for workspace ${entry.id}; rollback requires an earlier activation`);
  }
  const activation = recordActivation(entry.image, entry.previousImage);
  entry.previousImage = activation.previous;
  entry.image = activation.current;
  if (versions) entry.agentVersions = versions;
  else delete entry.agentVersions;
  return activation;
}
