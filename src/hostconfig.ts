import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HostConfig {
  runtime: string;
  terminal: string;
}

export const DEFAULT_RUNTIME = 'docker';
export const DEFAULT_TERMINAL = 'tmux';

export function hostConfigPath(homeDir: string): string {
  return join(homeDir, '.sandbox', 'config.json');
}

/** Host-level defaults. Missing or partial files fall back to defaults field by field. */
export function loadHostConfig(homeDir: string): HostConfig {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(hostConfigPath(homeDir), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot read host config: ${(error as Error).message}`);
    }
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const runtime = record['runtime'];
  const terminal = record['terminal'];
  return {
    runtime: typeof runtime === 'string' && runtime.length > 0 ? runtime : DEFAULT_RUNTIME,
    terminal: typeof terminal === 'string' && terminal.length > 0 ? terminal : DEFAULT_TERMINAL,
  };
}

export function saveHostConfig(homeDir: string, config: HostConfig): void {
  mkdirSync(join(homeDir, '.sandbox'), { recursive: true });
  writeFileSync(hostConfigPath(homeDir), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
