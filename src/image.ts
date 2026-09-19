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
export const INSPECT_VERSIONS_SCRIPT = 'claude --version; opencode --version; codex --version; copilot --version; pi --version';

/** Parse the inspect probe: first tokens per line, keyed for buildCandidate. */
export function parseInspectedVersions(stdout: string): Record<string, string> {
  const versions: Record<string, string> = {};
  // copilot 1.0.86 appends a `Run 'copilot update' ...` hint to stdout after
  // its version line. It is filtered here so the positional parse below keeps
  // working; no version line ever starts with `Run '`.
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("Run 'copilot update'"));
  if (lines[0]) versions['claude'] = (lines[0]?.split(' ')[0] as string);
  if (lines[1]) versions['opencode-ai'] = lines[1] as string;
  if (lines[2]) versions['@openai/codex'] = (lines[2] as string).replace(/^codex-cli /, '');
  if (lines[3]) versions['@github/copilot'] = (lines[3] as string).replace(/^GitHub Copilot CLI /, '').replace(/\.$/, '');
  if (lines[4]) versions['@earendil-works/pi-coding-agent'] = lines[4] as string;
  return versions;
}

/** Build a candidate without secrets. Never retags the selected image. */
export function buildCandidate(
  runner: ImageRunner,
  contextDir: string,
  candidateTag: string,
  engines: Iterable<AgentEngine>,
  versionOverrides: Record<string, string> = {},
): { tag: string; versions: Record<string, string> } {
  const buildArgs: Record<string, string> = {};
  const expected: Record<string, string> = {};
  for (const engine of engines) {
    const spec = engine.installSpec();
    if (!spec.pinnedVersion) continue;
    const version = (spec.npmPackage ? versionOverrides[spec.npmPackage] : undefined)
      ?? versionOverrides[engine.name]
      ?? spec.pinnedVersion;
    buildArgs[`${engine.name.toUpperCase()}_VERSION`] = version;
    expected[spec.npmPackage ?? engine.name] = version;
  }
  const tag = runner.buildImage({ contextDir, tag: candidateTag, buildArgs });
  const versions = runner.inspectBinaryVersions(tag);
  for (const [npmPackage, want] of Object.entries(expected)) {
    if (versions[npmPackage] !== want) {
      throw new Error(`candidate image reports ${npmPackage}@${versions[npmPackage] ?? 'unknown'}, expected ${want}`);
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

/** Explicit cutover: the running image becomes the rollback target. */
export function activateImage(entry: WorkspaceEntry, candidate: string): Activation {
  const activation = recordActivation(entry.image, candidate);
  entry.previousImage = activation.previous;
  entry.image = activation.current;
  return activation;
}

/** Rollback re-activates the previous digest. It never reverses a data migration. */
export function rollbackImage(entry: WorkspaceEntry): Activation {
  if (!entry.previousImage) {
    throw new Error(`no previous image recorded for workspace ${entry.id}; rollback requires an earlier activation`);
  }
  const activation = recordActivation(entry.image, entry.previousImage);
  entry.previousImage = activation.previous;
  entry.image = activation.current;
  return activation;
}
