import {
  assertInstanceName,
  clearCredentials,
  listCredentialInstances,
  loadCredentials,
  redactEnv,
  setCredentials,
} from '../credentials.js';
import { lookupWorkspace } from '../registry.js';
import { resolveWorkspace } from '../resolve.js';
import { readFileSync } from 'node:fs';
import { credentialsHelp } from '../help.js';
import { UsageError } from '../cli.js';
import { CliError, type MainDeps } from './deps.js';
import { loadRegistryOrThrow } from './lookup.js';
import { takeRestOption } from './ui.js';
export async function credentialsCommand(deps: MainDeps, action: string, rest: string[], workspace: string | undefined): Promise<number> {
  const registry = loadRegistryOrThrow(deps);
  if (action === 'help') {
    deps.stdout(credentialsHelp());
    return 0;
  }
  if (action === 'list') {
    const entries = Object.values(registry.workspaces);
    if ((rest.includes('--json') || rest.includes('-j'))) {
      const payload: Record<string, string[]> = {};
      for (const entry of entries) payload[entry.id] = listCredentialInstances(deps.homeDir, entry.id);
      deps.stdout(`${JSON.stringify({ credentials: payload }, null, 2)}\n`);
      return 0;
    }
    for (const entry of entries) {
      const names = listCredentialInstances(deps.homeDir, entry.id);
      deps.stdout(`${entry.id}: ${names.join(', ') || '(none)'}\n`);
    }
    return 0;
  }
  const instance = takeRestOption(rest, ['--instance', '-i']);
  if (!instance) throw new UsageError(`credentials ${action} requires --instance <name>`);
  try {
    assertInstanceName(instance);
  } catch (error) {
    throw new CliError((error as Error).message, 2);
  }
  const resolution = resolveWorkspace({ explicitRoot: workspace, cwd: deps.cwd, registry });
  const entry = resolution.registered ? lookupWorkspace(registry, resolution.root) : null;
  if (!entry) throw new CliError('no workspace in scope; register one first', 1);
  switch (action) {
    case 'show': {
      const stored = loadCredentials(deps.homeDir, entry.id, instance);
      if (!stored) {
        deps.stdout(`no credentials for instance ${instance}\n`);
        return 0;
      }
      deps.stdout(`${JSON.stringify(redactEnv(stored), null, 2)}\n`);
      return 0;
    }
    case 'set': {
      const file = takeRestOption(rest, ['--file', '-f']);
      if (!file) throw new UsageError('credentials set requires --file <path>');
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        throw new CliError(`cannot read credential file: ${file}`, 2);
      }
      if (loadCredentials(deps.homeDir, entry.id, instance) !== null) {
        const approved = await deps.confirm(`instance ${instance} already has credentials. Overwrite?`);
        if (!approved) throw new CliError('credentials set cancelled; nothing was changed', 1);
      }
      let keys: string[];
      try {
        keys = setCredentials(deps.homeDir, entry.id, instance, content);
      } catch (error) {
        throw new CliError((error as Error).message, 2);
      }
      deps.stdout(`stored ${keys.length} keys for instance ${instance} (values never shown)\n`);
      return 0;
    }
    case 'clear': {
      const removed = clearCredentials(deps.homeDir, entry.id, instance);
      deps.stdout(removed ? `cleared credentials for instance ${instance}\n` : `no credentials for instance ${instance}\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown credentials action: ${action}`);
  }
}
