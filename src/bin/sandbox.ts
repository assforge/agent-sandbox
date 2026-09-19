#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseArgs, UsageError } from '../cli.js';
import { migrateHomeDir } from '../paths.js';
import { agentHelp, credentialsHelp, imageHelp, runtimeHelp, terminalHelp, topHelp, updateHelp, workspaceHelp } from '../help.js';
import { agentRegistry } from '../commands/lookup.js';
import { packageVersion, realDeps, type MainDeps } from '../commands/deps.js';
import { printGroupHelp } from '../commands/ui.js';
import { openAgentWindow, openShellWindow } from '../commands/launch.js';
import { linkWorkspace, unlinkWorkspace, workspaceCommand } from '../commands/workspace.js';
import { agentCommand } from '../commands/agent.js';
import { doctorCommand } from '../commands/doctor.js';
import { updateCommand } from '../commands/update.js';
import { credentialsCommand } from '../commands/credentials.js';
import { runtimeCommand } from '../commands/runtime.js';
import { terminalCommand } from '../commands/terminal.js';
import { imageCommand } from '../commands/image.js';
import { CliError } from '../commands/deps.js';

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  try {
    return await dispatch(argv, deps);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`error: ${error.message}\nRun sandbox --help for usage.\n`);
      return error.exitCode;
    }
    if (error instanceof CliError) {
      deps.stderr(`error: ${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

async function dispatch(argv: string[], deps: MainDeps): Promise<number> {
  const parsed = parseArgs(argv);
  // The home move is a renameSync, so it belongs to commands that may
  // mutate. help and version touch nothing, and doctor is read-only by
  // contract 4: it reports a pending move through its own check instead
  // of performing one as a side effect of being asked a question.
  if (parsed.kind !== 'help' && parsed.kind !== 'version' && parsed.kind !== 'doctor') {
    if (migrateHomeDir(deps.homeDir)) {
      deps.stderr('sandbox home moved from ~/.sandbox to ~/.agent.sandbox\n');
    }
  }
  const agents = agentRegistry(deps);
  switch (parsed.kind) {
    case 'help':
      deps.stdout(topHelp());
      return 0;
    case 'version':
      deps.stdout(`sandbox ${packageVersion()}\n`);
      return 0;
    case 'doctor':
      return doctorCommand(deps, parsed.workspace, parsed.json);
    case 'bare':
      return openShellWindow(deps, 'bare', { workspace: parsed.workspace, noAttach: parsed.noAttach });
    case 'shell':
      return openShellWindow(deps, 'shell', { name: parsed.name, workspace: parsed.workspace, homeMode: parsed.homeMode, noAttach: parsed.noAttach });
    case 'agent':
      return openAgentWindow(deps, agents, {
        agent: parsed.agent,
        name: parsed.name,
        workspace: parsed.workspace,
        homeMode: parsed.homeMode,
        forwarded: parsed.forwarded,
        noAttach: parsed.noAttach,
      });
    case 'workspace':
      if (printGroupHelp(deps, 'workspace', parsed.action, parsed.help, workspaceHelp)) return 0;
      return workspaceCommand(deps, parsed.action, parsed.rest, parsed.workspace);
    case 'link':
      return linkWorkspace(deps, parsed.root, parsed.help);
    case 'unlink':
      return unlinkWorkspace(deps, parsed.root, parsed.help);
    case 'agentAdmin':
      if (printGroupHelp(deps, 'agent', parsed.action, parsed.help, agentHelp)) return 0;
      return agentCommand(deps, parsed.action, parsed.rest);
    case 'credentials':
      if (printGroupHelp(deps, 'credentials', parsed.action, parsed.help, credentialsHelp)) return 0;
      return credentialsCommand(deps, parsed.action, parsed.rest, parsed.workspace);
    case 'runtime':
      if (printGroupHelp(deps, 'runtime', parsed.action, parsed.help, runtimeHelp)) return 0;
      return runtimeCommand(deps, parsed.action, parsed.rest);
    case 'terminal':
      if (printGroupHelp(deps, 'terminal', parsed.action, parsed.help, terminalHelp)) return 0;
      return terminalCommand(deps, parsed.action, parsed.rest);
    case 'image':
      if (printGroupHelp(deps, 'image', parsed.action, parsed.help, imageHelp)) return 0;
      return imageCommand(deps, parsed.action, parsed.rest, parsed.workspace);
    case 'update': {
      if (parsed.help) {
        deps.stdout(updateHelp());
        return 0;
      }
      return updateCommand(deps, parsed.check);
    }
  }
}

function invokedAsMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  const assumeYes = process.argv.includes('--yes') || process.argv.includes('-y');
  const filtered = process.argv.slice(2).filter((arg) => arg !== '--yes' && arg !== '-y');
  main(filtered, realDeps(assumeYes)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`error: ${(error as Error).message ?? error}\n`);
      process.exit(1);
    },
  );
}

// Test surface stays put: suites import main and these helpers from the
// entry point, so the split underneath changes no test file.
export type { MainDeps } from '../commands/deps.js';
export { hasGitDir } from '../commands/lookup.js';
export { reattachOrHint } from '../commands/ui.js';
