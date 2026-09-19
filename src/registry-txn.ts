import { acquireLock } from './lock.js';
import { saveRegistry, type Registry } from './registry.js';

/**
 * The registry file is shared by every workspace, so the lock protecting it is keyed on
 * a constant rather than on a workspace id. A per-workspace lock cannot protect a
 * whole-file write: two invocations on *different* workspaces take different locks and
 * then overwrite each other's snapshot of the whole file.
 *
 * Lock granularity has to match write granularity, and the write here is the file.
 */
export const REGISTRY_LOCK_ID = 'registry';

/**
 * The only sanctioned way to write the registry.
 *
 * The lock is taken BEFORE the read, so the object `fn` mutates was loaded under it.
 * `fn` is synchronous by construction, so the lock can never be held across an `await`
 * -- and therefore never across a user prompt, a readiness wait or a volume copy.
 *
 * A registry read taken *before* this call is resolution input only: any entry that is
 * going to be mutated must be re-resolved from the object handed to `fn`, because a
 * pre-lock snapshot may already have been superseded by a concurrent invocation.
 */
export function withRegistryTxn<T>(
  lockDir: string,
  registryPath: string,
  load: (path: string) => Registry,
  fn: (registry: Registry) => T,
): T {
  const handle = acquireLock(lockDir, REGISTRY_LOCK_ID);
  try {
    const registry = load(registryPath);
    const result = fn(registry);
    saveRegistry(registryPath, registry);
    return result;
  } finally {
    handle.release();
  }
}
