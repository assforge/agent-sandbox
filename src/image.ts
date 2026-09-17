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
    if (spec.channel !== 'npm' || !spec.npmPackage || !spec.pinnedVersion) continue;
    const version = versionOverrides[spec.npmPackage] ?? spec.pinnedVersion;
    buildArgs[`${engine.name.toUpperCase()}_VERSION`] = version;
    expected[spec.npmPackage] = version;
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
