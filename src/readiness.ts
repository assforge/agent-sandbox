import { createHash, randomBytes } from 'node:crypto';

export interface ReadinessToken {
  generation: string;
  fingerprint: string;
}

export interface ObservedReadiness extends ReadinessToken {
  startedAt: number;
}

export function freshGeneration(): string {
  return randomBytes(16).toString('hex');
}

export function configurationFingerprint(parts: string[]): string {
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Readiness is specific to the current startup generation. A persistent
 * state file from a previous run can never satisfy it.
 */
export function checkReadiness(expected: ReadinessToken, observed: ReadinessToken | null, processAlive: boolean): boolean {
  if (!observed || !processAlive) return false;
  return observed.generation === expected.generation && observed.fingerprint === expected.fingerprint;
}

/**
 * Restart path: the entrypoint rewrites ready.json on every container
 * start, so a fingerprint match with a fresh started_at proves this start
 * initialized. Allows clock skew between host and container runtimes.
 */
export function checkRestarted(observed: ObservedReadiness | null, fingerprint: string, startEpoch: number): boolean {
  if (!observed) return false;
  if (observed.fingerprint !== fingerprint) return false;
  return observed.startedAt >= startEpoch - 120;
}
