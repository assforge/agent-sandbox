/**
 * TerminalEngine seam (D8). Window orchestration depends on this
 * interface; tmux syntax lives in the tmux implementation only.
 */
import {
  assertWindowName,
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
  sessionAlive: (runner: CommandRunner, session: string) => boolean;
  newSession: (runner: CommandRunner, session: string, window: string, workdir: string, command: ExecSpec) => void;
  newWindow: (runner: CommandRunner, session: string, window: string, workdir: string, command: ExecSpec) => void;
  windowExists: (runner: CommandRunner, session: string, window: string) => boolean;
  selectWindow: (runner: CommandRunner, session: string, window: string) => void;
  paneAlive: (runner: CommandRunner, session: string, window: string) => boolean;
  respawnWindow: (runner: CommandRunner, session: string, window: string, launch: ExecSpec) => void;
  reattach: (runner: CommandRunner, session: string, insideTmux: boolean) => void;
  killSession: (runner: CommandRunner, session: string) => void;
  openAgentWindow: (
    runner: CommandRunner,
    session: string,
    window: string,
    launch: ExecSpec,
    hostWorkdir: string,
  ) => 'reused' | 'respawned' | 'created';
}

export const TmuxTerminalEngine: TerminalEngine = {
  name: 'tmux',
  sessionAlive,
  newSession,
  newWindow,
  windowExists,
  selectWindow,
  paneAlive,
  respawnWindow,
  reattach: reattachSpec,
  killSession,
  openAgentWindow: openWindow,
};

export { assertWindowName };

export const TERMINAL_ENGINES: Record<string, TerminalEngine> = {
  tmux: TmuxTerminalEngine,
};

export function terminalEngine(name: string): TerminalEngine {
  const found = TERMINAL_ENGINES[name];
  if (!found) throw new Error(`unknown terminal engine: ${name}`);
  return found;
}
