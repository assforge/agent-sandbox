import type { CommandRunner } from './docker.js';
import { tmuxNewWindow, tmuxReattach, tmuxSelectWindow } from './session.js';
import { assertSafeName, type ExecSpec } from './engines/types.js';
/**
 * Session lookup via list-sessions (exit 0, parsed output) because
 * `tmux has-session` writes to the terminal past pipes on a miss.
 * Retried: long-lived servers under heavy polling have been observed
 * to intermittently omit fresh sessions from a single listing.
 */
export function sessionAlive(runner: CommandRunner, session: string, attempts = 3): boolean {
  for (let i = 0; i < attempts; i += 1) {
    const listed = runner.run('tmux', ['list-sessions', '-F', '#{session_name}']);
    if (listed.status === 0 && listed.stdout.split('\n').map((line) => line.trim()).includes(session)) {
      return true;
    }
    if (i + 1 < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return false;
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

/** True when the window's active pane is alive. A surviving window name with a dead pane must not be reused as-is. */
export function paneAlive(runner: CommandRunner, session: string, window: string): boolean {
  const probed = runner.run('tmux', ['list-panes', '-t', `${session}:${window}`, '-F', '#{pane_dead}']);
  if (probed.status !== 0) return false;
  const flags = probed.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return flags.length > 0 && flags.every((flag) => flag === '0');
}

/** Relaunch the command in a dead window instead of attaching to a corpse. */
export function respawnWindow(runner: CommandRunner, session: string, window: string, launch: ExecSpec): void {
  const respawned = runner.run('tmux', ['respawn-pane', '-t', `${session}:${window}`, '-k', launch.command, ...launch.args]);
  if (respawned.status !== 0) {
    throw new Error(`cannot respawn tmux window ${window}: ${respawned.stderr.trim()}`);
  }
}

/** Destroy a session and all its windows. Used only by unregister. */
export function killSession(runner: CommandRunner, session: string): void {
  const killed = runner.run('tmux', ['kill-session', '-t', session]);
  if (killed.status !== 0) {
    throw new Error(`cannot kill tmux session ${session}: ${killed.stderr.trim()}`);
  }
}

/** Reconnect: switch the client inside tmux (SSH included), attach otherwise. */
export function reattach(runner: CommandRunner, session: string, insideTerminal: boolean): void {
  const spec = tmuxReattach(session, insideTerminal);
  const result = runner.run('tmux', spec.args);
  if (result.status !== 0) {
    throw new Error(`cannot attach to tmux session ${session}: ${result.stderr.trim()}`);
  }
}

/** Instance names travel inside tmux target syntax (session:window). */
export function assertWindowName(name: string): void {
  assertSafeName('instance', name);
}

/** Open an agent window: reuse the live window, respawn a dead one, or create it. */
export function openAgentWindow(
  runner: CommandRunner,
  session: string,
  window: string,
  launch: ExecSpec,
  hostWorkdir: string,
): 'reused' | 'respawned' | 'created' {
  if (!sessionAlive(runner, session)) {
    assertWindowName(window);
    try {
      newSession(runner, session, window, hostWorkdir, launch);
      return 'created';
    } catch (error) {
      // The session appeared between the lookup and the creation
      // (concurrent creator or flaky listing): fall through to it.
      if (!sessionAlive(runner, session)) throw error;
    }
  }
  if (windowExists(runner, session, window)) {
    if (paneAlive(runner, session, window)) {
      selectWindow(runner, session, window);
      return 'reused';
    }
    assertWindowName(window);
    respawnWindow(runner, session, window, launch);
    selectWindow(runner, session, window);
    return 'respawned';
  }
  assertWindowName(window);
  newWindow(runner, session, window, hostWorkdir, launch);
  selectWindow(runner, session, window);
  return 'created';
}
