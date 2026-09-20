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

/** Version probe shared by upgrade inspect and the doctor drift check. */
export const INSPECT_VERSIONS_SCRIPT = 'claude --version; opencode --version; codex --version; copilot --version; pi --version; grok --version; agy --version; qwen --version; kimi --version; mimo --version; auggie --version; cursor-agent --version; devin --version; kiro-cli --version';

/** Parse the inspect probe: first tokens per line, keyed for buildCandidate. */
export function parseInspectedVersions(stdout: string): Record<string, string> {
  const versions: Record<string, string> = {};
  // copilot 1.0.86 appends a `Run 'copilot update' ...` hint to stdout after
  // its version line. It is filtered here so the positional parse below keeps
  // working; no version line ever starts with `Run '`.
  // The positional scheme is fail-closed by construction: any missing or
  // extra line shifts later values into the wrong slots, the shifted value
  // will not clear its floor, and buildCandidate throws rather than shipping
  // a misattributed image. Doctor drift can at worst warn on a shifted
  // probe; it never installs anything.
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("Run 'copilot update'"));
  if (lines[0]) versions['claude'] = (lines[0]?.split(' ')[0] as string);
  if (lines[1]) versions['opencode-ai'] = lines[1] as string;
  if (lines[2]) versions['@openai/codex'] = (lines[2] as string).replace(/^codex-cli /, '');
  if (lines[3]) versions['@github/copilot'] = (lines[3] as string).replace(/^GitHub Copilot CLI /, '').replace(/\.$/, '');
  if (lines[4]) versions['@earendil-works/pi-coding-agent'] = lines[4] as string;
  if (lines[5]) versions['grok'] = (lines[5] as string).replace(/^grok /, '').split(' ')[0] as string;
  if (lines[6]) versions['agy'] = lines[6] as string;
  if (lines[7]) versions['@qwen-code/qwen-code'] = lines[7] as string;
  if (lines[8]) versions['@moonshot-ai/kimi-code'] = lines[8] as string;
  if (lines[9]) versions['@mimo-ai/cli'] = lines[9] as string;
  if (lines[10]) versions['@augmentcode/auggie'] = (lines[10] as string).split(' ')[0] as string;
  if (lines[11]) versions['cursor'] = (lines[11] as string).replace(/^cursor-agent /, '').split('-')[0] as string;
  if (lines[12]) versions['devin'] = (lines[12] as string).replace(/^devin /, '').split(' ')[0] as string;
  if (lines[13]) versions['kiro'] = (lines[13] as string).replace(/^kiro-cli /, '').split(' ')[0] as string;
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
