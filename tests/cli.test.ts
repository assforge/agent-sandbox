import { describe, expect, it } from 'vitest';

import { parseArgs, splitForwarded, SUPPORTED_AGENTS, UsageError } from '../src/cli.js';

describe('splitForwarded', () => {
  it('forwards everything after the first -- verbatim', () => {
    expect(splitForwarded(['claude', '--', '--dangerously', 'x'])).toEqual({
      head: ['claude'],
      forwarded: ['--dangerously', 'x'],
    });
    expect(splitForwarded(['doctor'])).toEqual({ head: ['doctor'], forwarded: [] });
  });
});

describe('parseArgs', () => {
  it('parses bare, help and version without side effects', () => {
    expect(parseArgs([])).toEqual({ kind: 'bare', workspace: undefined, noAttach: false });
    expect(parseArgs(['--workspace', '/w'])).toEqual({ kind: 'bare', workspace: '/w', noAttach: false });
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
  });

  it('parses agent shortcuts with names and forwarding', () => {
    expect(SUPPORTED_AGENTS).toContain('claude');
    expect(parseArgs(['claude'])).toEqual({ kind: 'agent', agent: 'claude', name: undefined, workspace: undefined, forwarded: [], noAttach: false });
    expect(parseArgs(['codex', '--name', 'sdk', '--', '-c', 'x'])).toEqual({
      kind: 'agent',
      agent: 'codex',
      name: 'sdk',
      workspace: undefined,
      forwarded: ['-c', 'x'],
      noAttach: false,
    });
    expect(parseArgs(['claude', '--no-attach'])).toMatchObject({ kind: 'agent', noAttach: true });
    expect(parseArgs(['--no-attach'])).toMatchObject({ kind: 'bare', noAttach: true });
  });

  it('parses the short register shortcut', () => {
    expect(parseArgs(['register'])).toEqual({ kind: 'register', root: undefined, workspace: undefined });
    expect(parseArgs(['register', '/w/repo'])).toEqual({ kind: 'register', root: '/w/repo', workspace: undefined });
    expect(parseArgs(['--workspace', '/w', 'register', '/w/repo'])).toEqual({ kind: 'register', root: '/w/repo', workspace: '/w' });
    expect(parseArgs(['unregister'])).toEqual({ kind: 'unregister', root: undefined, workspace: undefined });
    expect(parseArgs(['unregister', '/w/repo'])).toEqual({ kind: 'unregister', root: '/w/repo', workspace: undefined });
    for (const argv of [['register', 'a', 'b'], ['register', '--json'], ['unregister', 'a', 'b']]) {
      try {
        parseArgs(argv);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
      }
    }
  });

  it('parses runtime group commands', () => {
    expect(parseArgs(['runtime', 'list'])).toEqual({ kind: 'runtime', action: 'list', rest: [] });
    expect(parseArgs(['runtime', 'use', 'apple'])).toEqual({ kind: 'runtime', action: 'use', rest: ['apple'] });
    expect(parseArgs(['terminal', 'list'])).toEqual({ kind: 'terminal', action: 'list', rest: [] });
    expect(parseArgs(['terminal', 'use', 'herder'])).toEqual({ kind: 'terminal', action: 'use', rest: ['herder'] });
  });

  it('parses shell, doctor and resource groups', () => {
    expect(parseArgs(['shell', '--name', 's'])).toEqual({ kind: 'shell', name: 's', workspace: undefined, noAttach: false });
    expect(parseArgs(['doctor', '--json'])).toEqual({ kind: 'doctor', json: true, workspace: undefined });
    expect(parseArgs(['doctor'])).toEqual({ kind: 'doctor', json: false, workspace: undefined });
    expect(parseArgs(['workspace', 'list'])).toEqual({ kind: 'workspace', action: 'list', rest: [], workspace: undefined });
    expect(parseArgs(['workspace', 'exec', '--', 'ls', '-la'])).toEqual({
      kind: 'workspace',
      action: 'exec',
      rest: ['--', 'ls', '-la'],
      workspace: undefined,
    });
    expect(parseArgs(['image', 'activate', 'abc123'])).toEqual({
      kind: 'image',
      action: 'activate',
      rest: ['abc123'],
      workspace: undefined,
    });
  });

  it('rejects unknown commands and misplaced arguments with exit code 2', () => {
    for (const argv of [
      ['frobnicate'],
      ['claude', 'extra'],
      ['doctor', 'extra'],
      ['workspace'],
      ['--', 'x'],
      ['shell', '--name'],
      ['shell', 'extra'],
      ['shell', '--', 'x'],
      ['codex', '--name', '--json'],
      ['--workspace'],
    ]) {
      try {
        parseArgs(argv);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        expect((error as UsageError).exitCode).toBe(2);
      }
    }
  });

  it('accepts --json in the forwarded tail and --workspace with subcommands', () => {
    expect(parseArgs(['doctor', '--', '--json'])).toEqual({ kind: 'doctor', json: true, workspace: undefined });
    expect(parseArgs(['--workspace', '/w', 'image', 'list'])).toEqual({
      kind: 'image',
      action: 'list',
      rest: [],
      workspace: '/w',
    });
    expect(parseArgs(['agent', 'list'])).toEqual({ kind: 'agentAdmin', action: 'list', rest: [], workspace: undefined });
    expect(parseArgs(['agent', 'help'])).toEqual({ kind: 'agentAdmin', action: 'help', rest: [], workspace: undefined });
    expect(parseArgs(['image', 'build'])).toEqual({ kind: 'image', action: 'build', rest: [], workspace: undefined });
  });
});
