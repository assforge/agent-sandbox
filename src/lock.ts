import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { O_CREAT, O_EXCL, O_WRONLY } from 'node:constants';
import { join } from 'node:path';

/**
 * Advisory per-workspace operation lock. Concurrent sandbox invocations for
 * the same workspace serialize on acquisition. The lockfile records the
 * holder pid, so a holder that crashed without releasing is reclaimed
 * instead of wedging later invocations forever. Waits use short timed
 * sleeps; the CLI is a synchronous single-shot process, so no event loop
 * is starved.
 */
export function lockPath(lockDir: string, workspaceIdValue: string): string {
  return join(lockDir, `${workspaceIdValue}.lock`);
}

export interface LockHandle {
  path: string;
  release: () => void;
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwner(path: string): number | null {
  try {
    const owner = Number.parseInt(readFileSync(path, 'utf8'), 10);
    return Number.isNaN(owner) ? null : owner;
  } catch {
    return null;
  }
}

export function acquireLock(lockDir: string, workspaceIdValue: string, timeoutMs = 30000): LockHandle {
  if (!lockDir.startsWith('/') || lockDir.split('/').includes('..')) {
    throw new Error(`refused lock directory: ${lockDir}`);
  }
  mkdirSync(lockDir, { recursive: true });
  const path = lockPath(lockDir, workspaceIdValue);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(path, O_CREAT | O_EXCL | O_WRONLY, 0o600);
      writeSync(fd, `${process.pid}\n`);
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
      const owner = readOwner(path);
      if (owner !== null && !pidAlive(owner)) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring workspace lock: ${path}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
