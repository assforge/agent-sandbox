import { describe, expect, it } from 'vitest';

import { AGENT_USER, dockerExec, renderSpec, tmuxHasSession, tmuxNewWindow, tmuxReattach, tmuxSelectWindow } from '../src/session.js';

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
    expect(tmuxHasSession('sandbox-w')).toEqual({ command: 'tmux', args: ['has-session', '-t', 'sandbox-w'] });
    expect(tmuxSelectWindow('sandbox-w', 'sdk')).toEqual({
      command: 'tmux',
      args: ['select-window', '-t', 'sandbox-w:sdk'],
    });
    expect(tmuxReattach('sandbox-w', false).args).toEqual(['attach-session', '-t', 'sandbox-w']);
    expect(tmuxReattach('sandbox-w', true).args).toEqual(['switch-client', '-t', 'sandbox-w']);
  });

  it('renders specs for display with POSIX shell quoting', () => {
    expect(renderSpec(dockerExec('c', '/w', ['echo', 'hello world']))).toContain(`'hello world'`);
    expect(renderSpec(dockerExec('c', '/w', ['echo', `it's $(x)`]))).toContain(`'it'\\''s $(x)'`);
  });
});
