import { INSPECT_VERSIONS_SCRIPT, parseInspectedVersions } from '../image.js';
import type { RuntimeEngine } from '../engines/runtime.js';
import type { MainDeps } from './deps.js';
/** Read agent versions from a running container. Null when it cannot be done. No tty: version output needs none, and -t fails without a terminal. */
export function inspectRunningVersions(deps: MainDeps, rt: RuntimeEngine, container: string, workdir: string): Record<string, string> | null {
  const spec = rt.execVector(container, { workdir, argv: ['sh', '-c', INSPECT_VERSIONS_SCRIPT], tty: false });
  const probed = deps.runner.run(spec.command, spec.args);
  if (probed.status !== 0) return null;
  return parseInspectedVersions(probed.stdout);
}
/**
 * Project hook commands missing inside the running container. One probe per
 * binary via `$0` so config text never interpolates into shell. Null when
 * the probe itself fails; empty means everything resolved.
 */
export function probeHookCommands(deps: MainDeps, rt: RuntimeEngine, container: string, workdir: string, commands: string[]): string[] | null {
  const missing: string[] = [];
  for (const command of commands) {
    const spec = rt.execVector(container, { workdir, argv: ['sh', '-c', 'command -v "$0" >/dev/null 2>&1', command], tty: false });
    const probed = deps.runner.run(spec.command, spec.args);
    // A missing binary exits silently non-zero; execution-layer trouble
    // brings stderr. Only the latter aborts the whole probe.
    if (probed.status !== 0 && probed.stderr.trim().length > 0) return null;
    if (probed.status !== 0) missing.push(command);
  }
  return missing;
}
