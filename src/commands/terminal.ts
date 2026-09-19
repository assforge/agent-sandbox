import { TERMINAL_ENGINES } from '../engines/terminal.js';
import { loadHostConfig, saveHostConfig } from '../hostconfig.js';
import { terminalHelp } from '../help.js';
import { UsageError } from '../cli.js';
import { CliError, type MainDeps } from './deps.js';
export async function terminalCommand(deps: MainDeps, action: string, rest: string[]): Promise<number> {
  switch (action) {
    case 'help':
      deps.stdout(terminalHelp());
      return 0;
    case 'list': {
      const selected = loadHostConfig(deps.homeDir).terminal;
      const rows = Object.values(TERMINAL_ENGINES).map((engine) => ({ name: engine.name, selected: engine.name === selected }));
      if ((rest.includes('--json') || rest.includes('-j'))) {
        deps.stdout(`${JSON.stringify({ terminals: rows }, null, 2)}\n`);
        return 0;
      }
      for (const row of rows) {
        deps.stdout(`${row.name}${row.selected ? ' (selected)' : ''}\n`);
      }
      return 0;
    }
    case 'use': {
      const name = rest[0];
      if (!name) throw new UsageError('terminal use requires <name>');
      if (!TERMINAL_ENGINES[name]) {
        throw new CliError(`unknown terminal engine: ${name}; run: sandbox terminal list`, 2);
      }
      const config = loadHostConfig(deps.homeDir);
      saveHostConfig(deps.homeDir, { runtime: config.runtime, terminal: name });
      deps.stdout(`selected terminal ${name} for new workspaces\n`);
      return 0;
    }
    default:
      throw new UsageError(`unknown terminal action: ${action}`);
  }
}
