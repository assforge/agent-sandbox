import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { O_CREAT, O_EXCL } from 'node:constants';
import { join } from 'node:path';

/**
 * Advisory per-workspace operation lock. Concurrent sandbox invocations for
 * the same workspace serialize on lock acquisition; a holder that crashes
 * without releasing blocks later invocations until the timeout expires.
 */
export function lockPath(lockDir: string, workspaceIdValue: string): string {
  return join(lockDir, `${workspaceIdValue}.lock`);
}

export interface LockHandle {
  path: string;
  release: () => void;
}

export function acquireLock(lockDir: string, workspaceIdValue: string, timeoutMs = 30000): LockHandle {
  mkdirSync(lockDir, { recursive: true });
  const path = lockPath(lockDir, workspaceIdValue);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(path, O_CREAT | O_EXCL, 0o644);
      let released = false;
      return {
        path,
        release: () => {
          if (released) return;
          released = true;
          try {
            closeSync(fd);
          } catch {
            // descriptor already closed; release stays idempotent
          }
          rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring workspace lock: ${path}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
