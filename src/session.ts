export interface ExecSpec {
  command: string;
  args: string[];
}

/** Fixed docker exec vector. No shell is involved, so user input is never re-evaluated. */
export function dockerExec(container: string, workdir: string, argv: string[]): ExecSpec {
  return { command: 'docker', args: ['exec', '-i', '-t', '-w', workdir, container, ...argv] };
}

export function tmuxHasSession(session: string): ExecSpec {
  return { command: 'tmux', args: ['has-session', '-t', session] };
}

export function tmuxNewWindow(session: string, window: string, workdir: string, command: ExecSpec): ExecSpec {
  return {
    command: 'tmux',
    args: ['new-window', '-t', `${session}:`, '-n', window, '-c', workdir, command.command, ...command.args],
  };
}

export function tmuxSelectWindow(session: string, window: string): ExecSpec {
  return { command: 'tmux', args: ['select-window', '-t', `${session}:${window}`] };
}

export function tmuxAttach(session: string): ExecSpec {
  return { command: 'tmux', args: ['attach-session', '-t', session] };
}

export function tmuxSwitchClient(session: string): ExecSpec {
  return { command: 'tmux', args: ['switch-client', '-t', session] };
}

/** Render a spec for display. Quoting is display-only; execution uses argv vectors. */
export function renderSpec(spec: ExecSpec): string {
  const parts = [spec.command, ...spec.args];
  return parts.map((part) => (/^[A-Za-z0-9_./:=-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}
