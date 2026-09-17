#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

import { parseArgs, UsageError } from '../cli.js';
import { defaultRegistryPath, loadRegistry } from '../registry.js';
import { renderDoctorJson, renderDoctorText, runDoctor, doctorExitCode } from '../doctor.js';
import { agentHelp, imageHelp, SANDBOX_VERSION, topHelp, workspaceHelp } from '../help.js';

function realPathLookup(name: string): string | null {
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
}

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${error.message}\nRun sandbox --help for usage.\n`);
      return error.exitCode;
    }
    throw error;
  }
  switch (parsed.kind) {
    case 'help':
      process.stdout.write(topHelp());
      return 0;
    case 'version':
      process.stdout.write(`sandbox ${SANDBOX_VERSION}\n`);
      return 0;
    case 'doctor': {
      const checks = runDoctor(
        {
          nodeVersion: process.version,
          pathLookup: realPathLookup,
          commandSucceeds: (command, args) => {
            try {
              execFileSync(command, args, { stdio: 'ignore', timeout: 10000 });
              return true;
            } catch {
              return false;
            }
          },
          platform: process.platform,
        },
        loadRegistry(defaultRegistryPath(homedir())).workspaces['default']?.image ?? null,
      );
      process.stdout.write(parsed.json ? renderDoctorJson(checks) : renderDoctorText(checks));
      return doctorExitCode(checks);
    }
    case 'workspace':
      if (parsed.action === 'help') {
        process.stdout.write(workspaceHelp());
        return 0;
      }
      process.stderr.write(`workspace ${parsed.action} is not implemented in this preview.\n`);
      return 1;
    case 'agentAdmin':
      process.stderr.write(`agent ${parsed.action} is not implemented in this preview.\n`);
      return 1;
    case 'image':
      if (parsed.action === 'help') {
        process.stdout.write(imageHelp());
        return 0;
      }
      process.stderr.write(`image ${parsed.action} is not implemented in this preview.\n`);
      return 1;
    case 'agent':
      process.stderr.write(`agent launch requires a ready workspace and is not implemented in this preview.\n`);
      return 1;
    case 'bare':
    case 'shell':
      process.stderr.write(`workspace startup is not implemented in this preview.\n`);
      return 1;
    default:
      process.stderr.write(agentHelp());
      return 2;
  }
}

process.exit(main(process.argv.slice(2)));
