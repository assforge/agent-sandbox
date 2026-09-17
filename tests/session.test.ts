import { describe, expect, it } from 'vitest';

import { AGENT_USER, dockerExec, renderSpec, tmuxNewWindow, tmuxReattach, tmuxSelectWindow } from '../src/session.js';
import { openAgentWindow, paneAlive } from '../src/terminal.js';

describe('session vectors', () => {
  it('builds fixed docker exec vectors without a shell, as the agent user', () => {
    expect(dockerExec('sandbox-w-abc', '/home/agent/work', ['claude'])).toEqual({
      command: 'docker',
      args: ['exec', '-i', '-t', '-u', AGENT_USER, '-w', '/home/agent/work', 'sandbox-w-abc', 'claude'],
    });
    expect(dockerExec('c', '/w', ['sh'], 'root').args).toContain('root');
  });

  it('builds tmux window and reattach vectors', () => {
    const exec = dockerExec('c', '/w', ['codex']);
    expect(tmuxNewWindow('sandbox-w', 'sdk', '/tmp', exec).args).toContain('new-window');
    expect(tmuxSelectWindow('sandbox-w', 'sdk')).toEqual({
      command: 'tmux',
      args: ['select-window', '-t', 'sandbox-w:sdk'],
    });
    expect(tmuxReattach('sandbox-w', false).args).toEqual(['attach-session', '-t', 'sandbox-w']);
    expect(tmuxReattach('sandbox-w', true).args).toEqual(['switch-client', '-t', 'sandbox-w']);
  });

  it('omits the tty flag for non-terminal exec', () => {
    expect(dockerExec('c', '/w', ['ls'], 'agent', false).args).not.toContain('-t');
    expect(dockerExec('c', '/w', ['ls']).args).toContain('-t');
  });

  it('renders specs for display with POSIX shell quoting', () => {
    expect(renderSpec(dockerExec('c', '/w', ['echo', 'hello world']))).toContain(`'hello world'`);
    expect(renderSpec(dockerExec('c', '/w', ['echo', `it's $(x)`]))).toContain(`'it'\\''s $(x)'`);
  });

  it('respawns dead panes instead of reusing corpses', () => {    const calls: string[][] = [];
    const panes = new Map([['w-live', true], ['w-dead', false]]);
    const runner = {
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (args[0] === 'list-sessions') return { status: 0, stdout: 's', stderr: '' };
        if (args[0] === 'list-windows') return { status: 0, stdout: 'w-live\nw-dead', stderr: '' };
        if (args[0] === 'list-panes') {
          const window = (args[args.indexOf('-t') + 1] as string).split(':')[1];
          return { status: 0, stdout: panes.get(window as string) === true ? '0' : '1', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const launch = dockerExec('c', '/w', ['bash']);
    expect(paneAlive(runner, 's', 'w-live')).toBe(true);
    expect(paneAlive(runner, 's', 'w-dead')).toBe(false);
    expect(openAgentWindow(runner, 's', 'w-live', launch, '/tmp')).toBe('reused');
    expect(openAgentWindow(runner, 's', 'w-dead', launch, '/tmp')).toBe('respawned');
    expect(calls.some((call) => call.includes('respawn-pane'))).toBe(true);
  });

  it('survives a session that appears between lookup and creation', () => {
    let lists = 0;
    const calls: string[][] = [];
    const runner = {
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (args[0] === 'list-sessions') {
          lists += 1;
          return { status: 0, stdout: lists < 4 ? '' : 's', stderr: '' };
        }
        if (args[0] === 'new-session') return { status: 1, stdout: '', stderr: 'duplicate session: s' };
        if (args[0] === 'list-windows') return { status: 0, stdout: 'w', stderr: '' };
        if (args[0] === 'list-panes') return { status: 0, stdout: '0', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    expect(openAgentWindow(runner, 's', 'w', dockerExec('c', '/w', ['bash']), '/tmp')).toBe('reused');
  });
});
