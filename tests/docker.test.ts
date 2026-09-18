import { describe, expect, it } from 'vitest';

import { runTerminal, type CommandRunner, type RunResult } from '../src/docker.js';
import { TmuxTerminalEngine } from '../src/engines/terminal.js';

const ok: RunResult = { status: 0, stdout: '', stderr: '' };

function recordingRunner(attached: boolean): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const runner: CommandRunner & { calls: string[] } = {
    calls,
    run: (command: string) => {
      calls.push(`run:${command}`);
      return ok;
    },
  };
  if (attached) {
    runner.runAttached = (command: string) => {
      calls.push(`attached:${command}`);
      return ok;
    };
  }
  return runner;
}

describe('runTerminal', () => {
  it('prefers inherited stdio and falls back to piped runs', () => {
    expect(runTerminal(recordingRunner(true), 'tmux', ['attach']).status).toBe(0);
    const withAttached = recordingRunner(true);
    runTerminal(withAttached, 'tmux', ['attach']);
    expect(withAttached.calls).toEqual(['attached:tmux']);
    const piped = recordingRunner(false);
    runTerminal(piped, 'tmux', ['attach']);
    expect(piped.calls).toEqual(['run:tmux']);
  });

  it('routes engine reattach through the terminal when offered', () => {
    const withAttached = recordingRunner(true);
    TmuxTerminalEngine.reattach(withAttached, 'sandbox-w-1', false);
    expect(withAttached.calls).toEqual(['attached:tmux']);
    const piped = recordingRunner(false);
    TmuxTerminalEngine.reattach(piped, 'sandbox-w-1', false);
    expect(piped.calls).toEqual(['run:tmux']);
  });
});
