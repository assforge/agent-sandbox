/**
 * Shared engine vocabulary. No engine specifics live here: only the
 * shapes every engine family exchanges with the sandbox core.
 */

/** An argv vector for execution. Never a shell string. */
export interface ExecSpec {
  command: string;
  args: string[];
}

/** Charset shared by instance names, window names, and lock identities. */
export function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

export function assertSafeName(kind: string, name: string): void {
  if (!isSafeName(name)) {
    throw new Error(`invalid ${kind} name: ${name}; use letters, digits, dot, underscore, or hyphen`);
  }
}
