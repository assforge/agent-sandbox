#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { parseArgs, UsageError } from '../cli.js';
import { defaultRegistryPath, loadRegistry, lookupWorkspace } from '../registry.js';
import { resolveWorkspace } from '../resolve.js';
import { doctorExitCode, renderDoctorJson, renderDoctorText, runDoctor } from '../doctor.js';
import { agentHelp, imageHelp, SANDBOX_VERSION, topHelp, workspaceHelp } from '../help.js';

export interface MainDeps {
  cwd: string;
  homeDir: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  pathLookup: (name: string) => string | null;
  commandSucceeds: (command: string, args: string[]) => boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export function realDeps(): MainDeps {
  return {
    cwd: process.cwd(),
    homeDir: homedir(),
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
    stdout: (text: string): void => {
      process.stdout.write(text);
    },
    stderr: (text: string): void => {
      process.stderr.write(text);
    },
  };
}

export function main(argv: string[], deps: MainDeps): number {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`error: ${error.message}\nRun sandbox --help for usage.\n`);
      return error.exitCode;
    }
    throw error;
  }
  switch (parsed.kind) {
    case 'help':
      deps.stdout(topHelp());
      return 0;
    case 'version':
      deps.stdout(`sandbox ${SANDBOX_VERSION}\n`);
      return 0;
    case 'doctor': {
      let registry;
      try {
        registry = loadRegistry(defaultRegistryPath(deps.homeDir));
      } catch (error) {
        deps.stderr(`error: cannot read registry: ${(error as Error).message}\n`);
        return 2;
      }
      const resolution = resolveWorkspace({ explicitRoot: parsed.workspace, cwd: deps.cwd, registry });
      const current = resolution.registered ? lookupWorkspace(registry, resolution.root) : null;
      const checks = runDoctor(
        {
          nodeVersion: deps.nodeVersion,
          pathLookup: deps.pathLookup,
          commandSucceeds: deps.commandSucceeds,
          platform: deps.platform,
        },
        current?.image ?? null,
      );
      deps.stdout(parsed.json ? renderDoctorJson(checks) : renderDoctorText(checks));
      return doctorExitCode(checks);
    }
    case 'workspace':
      if (parsed.action === 'help') {
        deps.stdout(workspaceHelp());
        return 0;
      }
      deps.stderr(`workspace ${parsed.action} is not implemented in this preview.\n`);
      return 1;
    case 'agentAdmin':
      if (parsed.action === 'help') {
        deps.stdout(agentHelp());
        return 0;
      }
      deps.stderr(`agent ${parsed.action} is not implemented in this preview.\n`);
      return 1;
    case 'image':
      if (parsed.action === 'help') {
        deps.stdout(imageHelp());
        return 0;
      }
      deps.stderr(`image ${parsed.action} is not implemented in this preview.\n`);
      return 1;
    case 'agent':
      deps.stderr('agent launch requires a ready workspace and is not implemented in this preview.\n');
      return 1;
    case 'bare':
    case 'shell':
      deps.stderr('workspace startup is not implemented in this preview.\n');
      return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2), realDeps()));
}
