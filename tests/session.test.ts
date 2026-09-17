import { describe, expect, it } from 'vitest';

import { dockerExec, renderSpec, tmuxAttach, tmuxNewWindow, tmuxSelectWindow, tmuxSwitchClient } from '../src/session.js';

describe('session vectors', () => {
  it('builds fixed docker exec vectors without a shell', () => {
    expect(dockerExec('sandbox-w-abc', '/home/agent/work', ['claude'])).toEqual({
      command: 'docker',
      args: ['exec', '-i', '-t', '-w', '/home/agent/work', 'sandbox-w-abc', 'claude'],
    });
  });

  it('builds tmux window and attach vectors', () => {
    const exec = dockerExec('c', '/w', ['codex']);
    expect(tmuxNewWindow('sandbox-w', 'sdk', '/tmp', exec).args).toContain('new-window');
    expect(tmuxSelectWindow('sandbox-w', 'sdk')).toEqual({
      command: 'tmux',
      args: ['select-window', '-t', 'sandbox-w:sdk'],
    });
    expect(tmuxAttach('sandbox-w').args).toEqual(['attach-session', '-t', 'sandbox-w']);
    expect(tmuxSwitchClient('sandbox-w').args).toEqual(['switch-client', '-t', 'sandbox-w']);
  });

  it('renders specs for display with quoting', () => {
    expect(renderSpec(dockerExec('c', '/w', ['echo', 'hello world']))).toContain('"hello world"');
  });
});
