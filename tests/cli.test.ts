import { describe, expect, it } from 'vitest';

import { canonicalAction, parseArgs, splitForwarded, SUPPORTED_AGENTS, UsageError } from '../src/cli.js';

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

  it('parses the short link shortcut and retired register', () => {
    expect(parseArgs(['link'])).toEqual({ kind: 'link', root: undefined, workspace: undefined, help: false });
    expect(parseArgs(['link', '/w/repo'])).toEqual({ kind: 'link', root: '/w/repo', workspace: undefined, help: false });
    expect(parseArgs(['--workspace', '/w', 'link', '/w/repo'])).toEqual({ kind: 'link', root: '/w/repo', workspace: '/w', help: false });
    expect(parseArgs(['unlink'])).toEqual({ kind: 'unlink', root: undefined, workspace: undefined, help: false });
    expect(parseArgs(['unlink', '/w/repo'])).toEqual({ kind: 'unlink', root: '/w/repo', workspace: undefined, help: false });
    expect(parseArgs(['link', '--help'])).toMatchObject({ kind: 'link', help: true });
    expect(canonicalAction('workspace', 'register')).toBe('link');
    expect(canonicalAction('workspace', 'unregister')).toBe('unlink');
    expect(canonicalAction('workspace', 'start')).toBe('start');
    for (const argv of [['link', 'a', 'b'], ['link', '--json'], ['unlink', 'a', 'b'], ['register'], ['unregister'], ['rm'], ['add'], ['forget']]) {
      try {
        parseArgs(argv);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
      }
    }
  });

  it('prints group help for bare groups and per-action help on demand', () => {
    expect(parseArgs(['workspace'])).toEqual({ kind: 'workspace', action: '', rest: [], workspace: undefined, help: false });
    expect(parseArgs(['agent'])).toEqual({ kind: 'agentAdmin', action: '', rest: [], workspace: undefined, help: false });
    expect(parseArgs(['workspace', 'restart', '--help'])).toMatchObject({ kind: 'workspace', action: 'restart', help: true });
    expect(parseArgs(['workspace', '--help'])).toMatchObject({ kind: 'workspace', action: '', help: true });
    expect(parseArgs(['image', 'build', '-h'])).toMatchObject({ kind: 'image', action: 'build', help: true });
    expect(parseArgs(['update'])).toEqual({ kind: 'update', check: false, help: false });
    expect(parseArgs(['update', '--check'])).toEqual({ kind: 'update', check: true, help: false });
    expect(parseArgs(['update', '--help'])).toMatchObject({ kind: 'update', help: true });
    try {
      parseArgs(['update', 'extra']);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
    }
  });

  it('parses runtime group commands', () => {
    expect(parseArgs(['runtime', 'list'])).toEqual({ kind: 'runtime', action: 'list', rest: [], help: false });
    expect(parseArgs(['runtime', 'use', 'apple'])).toEqual({ kind: 'runtime', action: 'use', rest: ['apple'], help: false });
    expect(parseArgs(['terminal', 'list'])).toEqual({ kind: 'terminal', action: 'list', rest: [], help: false });
    expect(parseArgs(['terminal', 'use', 'herder'])).toEqual({ kind: 'terminal', action: 'use', rest: ['herder'], help: false });
  });

  it('accepts short flags for frequent options', () => {
    expect(parseArgs(['-w', '/w'])).toMatchObject({ kind: 'bare', workspace: '/w' });
    expect(parseArgs(['claude', '-n', 'sdk'])).toMatchObject({ kind: 'agent', name: 'sdk' });
    expect(parseArgs(['shell', '-n', 's'])).toMatchObject({ kind: 'shell', name: 's' });
    expect(parseArgs(['doctor', '-j'])).toMatchObject({ kind: 'doctor', json: true });
  });

  it('parses per-instance home modes', () => {
    expect(parseArgs(['claude', '--home', 'fork'])).toMatchObject({ kind: 'agent', homeMode: 'fork' });
    expect(parseArgs(['claude', '--name', 'w1', '--home', 'shared'])).toMatchObject({ kind: 'agent', name: 'w1', homeMode: 'shared' });
    expect(parseArgs(['shell', '--home', 'fresh'])).toMatchObject({ kind: 'shell', homeMode: 'fresh' });
    expect(parseArgs(['claude'])).toMatchObject({ kind: 'agent', homeMode: undefined });
    for (const argv of [['claude', '--home', 'mansion'], ['shell', '--home', 'fork', 'extra']]) {
      try {
        parseArgs(argv);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
      }
    }
  });

  it('parses shell, doctor and resource groups', () => {
    expect(parseArgs(['shell', '--name', 's'])).toEqual({ kind: 'shell', name: 's', workspace: undefined, noAttach: false });
    expect(parseArgs(['doctor', '--json'])).toEqual({ kind: 'doctor', json: true, workspace: undefined });
    expect(parseArgs(['doctor'])).toEqual({ kind: 'doctor', json: false, workspace: undefined });
    expect(parseArgs(['workspace', 'list'])).toEqual({ kind: 'workspace', action: 'list', rest: [], workspace: undefined, help: false });
    expect(parseArgs(['workspace', 'exec', '--', 'ls', '-la'])).toEqual({
      kind: 'workspace',
      action: 'exec',
      rest: ['--', 'ls', '-la'],
      workspace: undefined,
      help: false,
    });
    expect(parseArgs(['image', 'activate', 'abc123'])).toEqual({
      kind: 'image',
      action: 'activate',
      rest: ['abc123'],
      workspace: undefined,
      help: false,
    });
  });

  it('rejects unknown commands and misplaced arguments with exit code 2', () => {
    for (const argv of [
      ['frobnicate'],
      ['claude', 'extra'],
      ['doctor', 'extra'],
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
      help: false,
    });
    expect(parseArgs(['agent', 'list'])).toEqual({ kind: 'agentAdmin', action: 'list', rest: [], workspace: undefined, help: false });
    expect(parseArgs(['agent', 'help'])).toEqual({ kind: 'agentAdmin', action: 'help', rest: [], workspace: undefined, help: false });
    expect(parseArgs(['image', 'build'])).toEqual({ kind: 'image', action: 'build', rest: [], workspace: undefined, help: false });
  });
});
