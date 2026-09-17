import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertSafeName } from './engines/types.js';

export const INSTANCE_ENV_DIR = 'instances';

/** Instance names double as credential file stems: same charset, file-safe. */
export function assertInstanceName(instance: string): void {
  assertSafeName('instance', instance);
}

export function credentialsDir(homeDir: string, workspaceIdValue: string): string {
  return join(homeDir, '.sandbox', workspaceIdValue, INSTANCE_ENV_DIR);
}

function envFile(homeDir: string, workspaceIdValue: string, instance: string): string {
  return join(credentialsDir(homeDir, workspaceIdValue), `${instance}.env`);
}

function assertEnvKey(key: string, line: number): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`invalid environment key on line ${line}: ${key}`);
  }
}

/** Parse KEY=VALUE lines; blank lines and # comments are ignored. */
export function parseEnvFile(content: string): Record<string, string> {
  const record: Record<string, string> = {};
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`invalid environment line ${i + 1}: expected KEY=VALUE`);
    const key = line.slice(0, separator).trim();
    assertEnvKey(key, i + 1);
    record[key] = line.slice(separator + 1);
  }
  return record;
}

export function setCredentials(homeDir: string, workspaceIdValue: string, instance: string, content: string): string[] {
  assertInstanceName(instance);
  const record = parseEnvFile(content);
  const dir = credentialsDir(homeDir, workspaceIdValue);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = envFile(homeDir, workspaceIdValue, instance);
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return Object.keys(record);
}

export function loadCredentials(homeDir: string, workspaceIdValue: string, instance: string): Record<string, string> | null {
  assertInstanceName(instance);
  let content: string;
  try {
    content = readFileSync(envFile(homeDir, workspaceIdValue, instance), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return parseEnvFile(content);
}

export function clearCredentials(homeDir: string, workspaceIdValue: string, instance: string): boolean {
  assertInstanceName(instance);
  try {
    rmSync(envFile(homeDir, workspaceIdValue, instance), { force: false });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function listCredentialInstances(homeDir: string, workspaceIdValue: string): string[] {
  let names: string[];
  try {
    names = readdirSync(credentialsDir(homeDir, workspaceIdValue));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => name.endsWith('.env')).map((name) => name.slice(0, -4)).sort();
}

/** Keys with masked values for display. Values never leave this redaction. */
export function redactEnv(record: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const key of Object.keys(record)) redacted[key] = '***';
  return redacted;
}
