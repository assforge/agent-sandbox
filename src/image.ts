import { AGENT_DEFINITIONS } from './agent.js';

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
): { tag: string; versions: Record<string, string> } {
  const buildArgs: Record<string, string> = {};
  for (const def of AGENT_DEFINITIONS) {
    if (def.npmPackage) buildArgs[`${def.name.toUpperCase()}_VERSION`] = def.pinnedVersion;
  }
  const tag = runner.buildImage({ contextDir, tag: candidateTag, buildArgs });
  const versions = runner.inspectBinaryVersions(tag);
  for (const def of AGENT_DEFINITIONS) {
    if (!def.npmPackage) continue;
    if (versions[def.npmPackage] !== def.pinnedVersion) {
      throw new Error(`candidate image reports ${def.npmPackage}@${versions[def.npmPackage] ?? 'unknown'}, expected ${def.pinnedVersion}`);
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
