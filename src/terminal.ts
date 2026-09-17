import type { CommandRunner } from './docker.js';
import { tmuxNewWindow, tmuxReattach, tmuxSelectWindow, type ExecSpec } from './session.js';

/**
 * Session lookup via list-sessions (exit 0, parsed output) because
 * `tmux has-session` writes to the terminal past pipes on a miss.
 */
export function sessionAlive(runner: CommandRunner, session: string): boolean {
  const listed = runner.run('tmux', ['list-sessions', '-F', '#{session_name}']);
  if (listed.status !== 0) return false;
  return listed.stdout.split('\n').map((line) => line.trim()).includes(session);
}

export function newSession(runner: CommandRunner, session: string, window: string, workdir: string, command: ExecSpec): void {
  const created = runner.run('tmux', ['new-session', '-d', '-s', session, '-n', window, '-c', workdir, command.command, ...command.args]);
  if (created.status !== 0) {
    throw new Error(`cannot create tmux session ${session}: ${created.stderr.trim()}`);
  }
}

export function newWindow(runner: CommandRunner, session: string, window: string, workdir: string, command: ExecSpec): void {
  const spec = tmuxNewWindow(session, window, workdir, command);
  const created = runner.run('tmux', spec.args);
  if (created.status !== 0) {
    throw new Error(`cannot create tmux window ${window}: ${created.stderr.trim()}`);
  }
}

export function windowExists(runner: CommandRunner, session: string, window: string): boolean {
  return runner.run('tmux', ['list-windows', '-t', session, '-F', '#{window_name}']).stdout
    .split('\n').map((line) => line.trim()).includes(window);
}

export function selectWindow(runner: CommandRunner, session: string, window: string): void {
  const spec = tmuxSelectWindow(session, window);
  const selected = runner.run('tmux', spec.args);
  if (selected.status !== 0) {
    throw new Error(`cannot select tmux window ${window}: ${selected.stderr.trim()}`);
  }
}

/** Reconnect: switch the client inside tmux (SSH included), attach otherwise. */
export function reattach(runner: CommandRunner, session: string, insideTmux: boolean): void {
  const spec = tmuxReattach(session, insideTmux);
  const result = runner.run('tmux', spec.args);
  if (result.status !== 0) {
    throw new Error(`cannot attach to tmux session ${session}: ${result.stderr.trim()}`);
  }
}

/** Instance names travel inside tmux target syntax (session:window). */
export function assertWindowName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.includes(':')) {
    throw new Error(`invalid instance name: ${name}; use letters, digits, dot, underscore, or hyphen`);
  }
}

/** Open an agent window: reuse the live window, create it, then select it. */
export function openAgentWindow(
  runner: CommandRunner,
  session: string,
  window: string,
  launch: ExecSpec,
  hostWorkdir: string,
): 'reused' | 'created' {
  if (!sessionAlive(runner, session)) {
    assertWindowName(window);
    newSession(runner, session, window, hostWorkdir, launch);
    return 'created';
  }
  if (windowExists(runner, session, window)) {
    selectWindow(runner, session, window);
    return 'reused';
  }
  assertWindowName(window);
  newWindow(runner, session, window, hostWorkdir, launch);
  selectWindow(runner, session, window);
  return 'created';
}
