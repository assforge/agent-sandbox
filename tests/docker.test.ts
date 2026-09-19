import { describe, expect, it } from 'vitest';

import { listWorkspaceImages, removeImage, runTerminal, type CommandRunner, type RunResult } from '../src/docker.js';
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
    runTerminal(piped, 'tmux', ['attach']);
    expect(piped.calls).toEqual(['run:tmux']);
  });
});

describe('workspace images', () => {
  const listing = (stdout: string): CommandRunner => ({
    run: (command, args) => {
      if (command === 'docker' && args[0] === 'images') return { status: 0, stdout, stderr: '' };
      throw new Error(`unexpected call: ${command} ${args.join(' ')}`);
    },
  });
  it('lists only the sandbox-workspace repository', () => {
    expect(listWorkspaceImages(listing('sandbox-workspace:a\nnode:22\nsandbox-workspace:b\n'))).toEqual([
      'sandbox-workspace:a',
      'sandbox-workspace:b',
    ]);
    expect(listWorkspaceImages(listing(''))).toEqual([]);
  });
  it('removes by tag and reports daemon errors', () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      run: (command, args) => {
        calls.push(`${command} ${args.join(' ')}`);
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    removeImage(runner, 'sandbox-workspace:stale');
    expect(calls).toEqual(['docker rmi sandbox-workspace:stale']);
    const failing: CommandRunner = { run: () => ({ status: 1, stdout: '', stderr: 'no such image' }) };
    expect(() => removeImage(failing, 'sandbox-workspace:gone')).toThrow(/no such image/);
  });
});
