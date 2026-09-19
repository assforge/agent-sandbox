import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { sandboxDir } from '../paths.js';
import type { CommandRunner, RunResult } from '../docker.js';
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}
export interface MainDeps {
  cwd: string;
  homeDir: string;
  lockDir: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  pathLookup: (name: string) => string | null;
  commandSucceeds: (command: string, args: string[]) => boolean;
  runner: CommandRunner;
  insideTerminal: boolean;
  stdinIsTTY: boolean;
  assumeYes: boolean;
  confirm: (question: string) => Promise<boolean>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}
function toRunResult(error: unknown): RunResult {
  const record = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
  const text = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value instanceof Buffer) return value.toString('utf8');
    return '';
  };
  return {
    status: typeof record.status === 'number' ? record.status : 1,
    stdout: text(record.stdout),
    stderr: text(record.stderr),
  };
}
export function realRunner(): CommandRunner {
  return {
    run: (command: string, args: string[]): RunResult => {
      try {
        const stdout = execFileSync(command, args, { encoding: 'utf8', timeout: 120000 });
        return { status: 0, stdout, stderr: '' };
      } catch (error) {
        return toRunResult(error);
      }
    },
    runAttached: (command: string, args: string[]): RunResult => {
      // No timeout: attach parks for the life of the session. stdio is
      // inherited so the child owns the terminal; piped stdio is exactly
      // what made every attach fail with "not a terminal".
      try {
        execFileSync(command, args, { stdio: 'inherit' });
        return { status: 0, stdout: '', stderr: '' };
      } catch (error) {
        const status = typeof (error as { status?: unknown }).status === 'number'
          ? (error as { status: number }).status
          : 1;
        return { status, stdout: '', stderr: '' };
      }
    },
  };
}
export function realDeps(assumeYes: boolean): MainDeps {
  const runner = realRunner();
  return {
    cwd: process.cwd(),
    homeDir: homedir(),
    lockDir: join(sandboxDir(homedir()), 'locks'),
    platform: process.platform,
    nodeVersion: process.version,
    pathLookup: (name: string): string | null => {
      const pathValue = process.env['PATH'] ?? '';
      for (const dir of pathValue.split(':')) {
        const candidate = `${dir}/${name}`;
        try {
          if (existsSync(candidate)) return candidate;
        } catch {
          continue;
        }
      }
      return null;
    },
    commandSucceeds: (command: string, args: string[]): boolean => {
      try {
        execFileSync(command, args, { stdio: 'ignore', timeout: 10000 });
        return true;
      } catch {
        return false;
      }
    },
    runner,
    insideTerminal: (process.env['TMUX'] ?? '') !== '' || process.env['HERDR_ENV'] === '1',
    stdinIsTTY: process.stdin.isTTY ?? false,
    assumeYes,
    confirm: async (question: string): Promise<boolean> => {
      if (assumeYes) return true;
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
        return answer.trim().toLowerCase() === 'y';
      } finally {
        rl.close();
      }
    },
    stdout: (text: string): void => {
      process.stdout.write(text);
    },
    stderr: (text: string): void => {
      process.stderr.write(text);
    },
  };
}
/** Single source of truth: the package manifest next to dist/. */
/** Canonical package identity for self-update. Never derived from user input. */
export const SELF_PACKAGE = '@assforge/cogent-sandbox';

export function packageVersion(): string {  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error('package.json has no version string');
  return parsed.version;
}
