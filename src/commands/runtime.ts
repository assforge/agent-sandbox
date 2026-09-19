import { RUNTIME_ENGINES } from '../engines/runtime.js';
import { loadHostConfig, saveHostConfig } from '../hostconfig.js';
import { runtimeHelp } from '../help.js';
import { UsageError } from '../cli.js';
import { CliError, type MainDeps } from './deps.js';
export async function runtimeCommand(deps: MainDeps, action: string, rest: string[]): Promise<number> {
  switch (action) {
    case 'help':
      deps.stdout(runtimeHelp());
      return 0;
    case 'list': {
      const selected = loadHostConfig(deps.homeDir).runtime;
      const rows = Object.values(RUNTIME_ENGINES).map((engine) => ({
        name: engine.name,
        selected: engine.name === selected,
        verified: engine.verified,
        capabilities: engine.capabilities,
      }));
      if ((rest.includes('--json') || rest.includes('-j'))) {
        deps.stdout(`${JSON.stringify({ runtimes: rows }, null, 2)}\n`);
        return 0;
      }
      for (const row of rows) {
        deps.stdout(`${row.name}${row.selected ? ' (selected)' : ''}${row.verified ? '' : ' [experimental]'}\n`);
      }
      return 0;
    }
    case 'use': {
      const name = rest[0];
      if (!name) throw new UsageError('runtime use requires <name>');
      if (!RUNTIME_ENGINES[name]) {
        throw new CliError(`unknown runtime engine: ${name}; run: sandbox runtime list`, 2);
      }
      const config = loadHostConfig(deps.homeDir);
      saveHostConfig(deps.homeDir, { runtime: name, terminal: config.terminal });
      deps.stdout(`selected runtime ${name} for new workspaces\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown runtime action: ${action}`);
  }
}
