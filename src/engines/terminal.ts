/**
 * TerminalEngine seam (D8). Window orchestration depends on this
 * interface; tmux syntax lives in the tmux implementation only.
 */
import {
  assertWindowName,
  closeWindow,
  killSession,
  newSession,
  newWindow,
  openAgentWindow as openWindow,
  paneAlive,
  reattach as reattachSpec,
  respawnWindow,
  selectWindow,
  sessionAlive,
  windowExists,
} from '../terminal.js';
import type { ExecSpec } from '../session.js';
import type { CommandRunner } from '../docker.js';

export interface TerminalEngine {
  readonly name: string;
  readonly cliBinary: string;
  installHint: (platform: NodeJS.Platform) => string;
  assertWindowName: (name: string) => void;
  sessionAlive: (runner: CommandRunner, session: string) => boolean;
  newSession: (runner: CommandRunner, session: string, window: string, workdir: string, command: ExecSpec) => void;
  newWindow: (runner: CommandRunner, session: string, window: string, workdir: string, command: ExecSpec) => void;
  windowExists: (runner: CommandRunner, session: string, window: string) => boolean;
  selectWindow: (runner: CommandRunner, session: string, window: string) => void;
  paneAlive: (runner: CommandRunner, session: string, window: string) => boolean;
  respawnWindow: (runner: CommandRunner, session: string, window: string, launch: ExecSpec) => void;
  reattach: (runner: CommandRunner, session: string, insideTerminal: boolean) => void;
  killSession: (runner: CommandRunner, session: string) => void;
  closeWindow: (runner: CommandRunner, session: string, window: string) => void;
  listSessions: (runner: CommandRunner) => string[];
  openAgentWindow: (
    runner: CommandRunner,
    session: string,
    window: string,
    launch: ExecSpec,
    hostWorkdir: string,
  ) => 'reused' | 'respawned' | 'created';
}

function hintInstallTmux(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS installation command: brew install tmux';
  if (platform === 'linux') return 'Debian/Ubuntu installation command: sudo apt-get install tmux';
  return 'Install tmux with your platform package manager, then run this check again';
}

export const TmuxTerminalEngine: TerminalEngine = {
  name: 'tmux',
  cliBinary: 'tmux',
  installHint: hintInstallTmux,
  assertWindowName,
  sessionAlive,
  newSession,
  newWindow,
  windowExists,
  selectWindow,
  paneAlive,
  respawnWindow,
  reattach: reattachSpec,
  killSession,
  closeWindow,
  listSessions: (runner) => {
    const listed = runner.run('tmux', ['list-sessions', '-F', '#{session_name}']);
    if (listed.status !== 0) return [];
    return listed.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  },
  openAgentWindow: openWindow,
};

export { assertWindowName };

import { HerderTerminalEngine } from './herder.js';

export const TERMINAL_ENGINES: Record<string, TerminalEngine> = {
  tmux: TmuxTerminalEngine,
  herder: HerderTerminalEngine,
};

export function terminalEngine(name: string): TerminalEngine {
  const found = TERMINAL_ENGINES[name];
  if (!found) throw new Error(`unknown terminal engine: ${name}`);
  return found;
}
