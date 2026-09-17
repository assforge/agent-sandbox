export interface ExecSpec {
  command: string;
  args: string[];
}

export const AGENT_USER = 'agent';

/** Fixed docker exec vector. No shell is involved, so user input is never re-evaluated. */
export function dockerExec(container: string, workdir: string, argv: string[], user: string = AGENT_USER): ExecSpec {
  return { command: 'docker', args: ['exec', '-i', '-t', '-u', user, '-w', workdir, container, ...argv] };
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

/**
 * Reconnect vector. Inside tmux the client switches; outside tmux it
 * attaches (including over SSH, which needs no nested session). The child
 * inherits the environment, so SSH_AUTH_SOCK and friends pass through.
 */
export function tmuxReattach(session: string, insideTmux: boolean): ExecSpec {
  if (insideTmux) return { command: 'tmux', args: ['switch-client', '-t', session] };
  return { command: 'tmux', args: ['attach-session', '-t', session] };
}

/**
 * Render a spec for display only, using POSIX shell quoting.
 * Execution always uses the argv vector, never this string.
 */
export function renderSpec(spec: ExecSpec): string {
  const quote = (part: string): string => {
    if (/^[A-Za-z0-9_./:=-]+$/.test(part)) return part;
    return `'${part.replace(/'/g, `'\\''`)}'`;
  };
  return [spec.command, ...spec.args].map(quote).join(' ');
}
