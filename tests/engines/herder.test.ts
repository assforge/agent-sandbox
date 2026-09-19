import { describe, expect, it } from 'vitest';

import {
  HerderTerminalEngine,
  herderSessionAlive,
  herderShellCommand,
  herderTabId,
  runInPane,
} from '../../src/engines/herder.js';
import type { RunResult } from '../../src/docker.js';

function scripted(routes: Record<string, RunResult>): {
  runner: { run: (command: string, args: string[]) => RunResult };
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        const head = [command, ...args.slice(0, 3)].join(' ');
        for (const [route, result] of Object.entries(routes)) {
          if (route.startsWith(head)) return result;
        }
        return { status: 0, stdout: '{}', stderr: '' };
      },
    },
  };
}

const SESSION_LIST = JSON.stringify({
  sessions: [{ default: false, name: 'sandbox-w', running: true }],
});

const TAB_LIST = JSON.stringify({
  id: 'cli:tab:list',
  result: {
    tabs: [
      { tab_id: 'w1:t1', label: 'w1' },
      { tab_id: 'w1:t2', label: 'w2' },
    ],
  },
});

describe('herder engine', () => {
  it('detects sessions, tabs, and live panes from live-recorded shapes', () => {
    const { runner } = scripted({
      'herdr --session': { status: 0, stdout: SESSION_LIST, stderr: '' },
    });
    // NOTE: scripted() matches on 'command + first 3 args'; the cases below
    // override per call through dedicated routes.
    void runner;
    const alive = scripted({ 'herdr --session sandbox-w session list': { status: 0, stdout: SESSION_LIST, stderr: '' } });
    expect(herderSessionAlive(alive.runner, 'sandbox-w')).toBe(true);
    const tabs = scripted({ 'herdr --session sandbox-w tab list': { status: 0, stdout: TAB_LIST, stderr: '' } });
    expect(herderTabId(tabs.runner, 'sandbox-w', 'w2')).toBe('w1:t2');
    expect(herderTabId(tabs.runner, 'sandbox-w', 'missing')).toBeNull();
    expect(HerderTerminalEngine.name).toBe('herder');
    expect(HerderTerminalEngine.cliBinary).toBe('herdr');
  });

  it('fails closed when a mutation reports an error body with exit code 0', () => {
    // herdr answers failures as {"error": {...}} often with status 0, so a
    // status-only check reported a failed launch as a created instance and a
    // failed close as a closed window.
    const launch = { command: 'echo', args: ['hi'] };
    const ok = scripted({ 'herdr --session sandbox-w pane run': { status: 0, stdout: '{}', stderr: '' } });
    expect(() => runInPane(ok.runner, 'sandbox-w', 'w1:p1', launch)).not.toThrow();

    const refused = JSON.stringify({ error: { code: 'pane_not_found', message: 'no such pane' } });
    const run = scripted({ 'herdr --session sandbox-w pane run': { status: 0, stdout: refused, stderr: '' } });
    expect(() => runInPane(run.runner, 'sandbox-w', 'w1:p1', launch)).toThrow(/pane_not_found/);

    // `scripted` cannot separate `tab list` from `tab close` -- both reduce to the
    // same 3-arg head -- so this one dispatches on the verb itself.
    const closeRefused = JSON.stringify({ error: { code: 'tab_not_found', message: 'no such tab' } });
    const runner = {
      run: (command: string, args: string[]) =>
        `${command} ${args[2]} ${args[3]}`.endsWith('tab close')
          ? { status: 0, stdout: closeRefused, stderr: '' }
          : { status: 0, stdout: TAB_LIST, stderr: '' },
    };
    expect(() => HerderTerminalEngine.closeWindow(runner, 'sandbox-w', 'w2')).toThrow(/tab_not_found/);
  });

  it('lists windows through the terminal engine, not a tmux call', () => {
    const tabs = scripted({ 'herdr --session sandbox-w tab list': { status: 0, stdout: TAB_LIST, stderr: '' } });
    expect(HerderTerminalEngine.listWindows(tabs.runner, 'sandbox-w')).toEqual(['w1', 'w2']);
  });

  it('treats error payloads and dead servers as failed lookups', () => {
    const down = scripted({
      'herdr --session sandbox-w session list': {
        status: 0,
        stdout: '{"id":"x","error":{"code":"server_not_running","message":"down"}}',
        stderr: '',
      },
      'herdr --session sandbox-w tab list': {
        status: 0,
        stdout: '{"id":"x","error":{"code":"server_not_running","message":"down"}}',
        stderr: '',
      },
    });
    expect(herderSessionAlive(down.runner, 'sandbox-w')).toBe(false);
    expect(HerderTerminalEngine.paneAlive(down.runner, 'sandbox-w', 'w1')).toBe(false);
  });

  it('opens, reuses, and respawns windows through tabs', () => {
    const calls: string[][] = [];
    const panes = new Map([['w1', true]]);
    const runner = {
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        const tail = args.slice(2).join(' ');
        if (tail.startsWith('workspace list')) {
          return { status: 0, stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: 'w1', label: 'sandbox-w' }] } }), stderr: '' };
        }
        if (tail.startsWith('session list')) return { status: 0, stdout: SESSION_LIST, stderr: '' };
        if (tail.startsWith('tab list')) {
          const tabs = [...panes.keys()].map((label, index) => ({ tab_id: `w1:t${index + 1}`, label }));
          return { status: 0, stdout: JSON.stringify({ result: { tabs } }), stderr: '' };
        }
        if (tail.startsWith('pane list')) {
          const list = [...panes.keys()].map((label, index) => ({ pane_id: `w1:p${index + 1}`, tab_id: `w1:t${index + 1}` }));
          return { status: 0, stdout: JSON.stringify({ result: { panes: list } }), stderr: '' };
        }
        if (tail.startsWith('tab create')) {
          const label = args[args.indexOf('--label') + 1] as string;
          panes.set(label, true);
          const index = [...panes.keys()].indexOf(label) + 1;
          return {
            status: 0,
            stdout: JSON.stringify({ result: { tab: { tab_id: `w1:t${index}` }, root_pane: { pane_id: `w1:p${index}` } } }),
            stderr: '',
          };
        }
        if (tail.startsWith('pane get')) {
          const id = args[args.length - 1] as string;
          const alive = [...panes.entries()].some(([, value], index) => value && `w1:p${index + 1}` === id);
          return alive
            ? { status: 0, stdout: JSON.stringify({ result: { pane: { pane_id: id } } }), stderr: '' }
            : { status: 1, stdout: '{"error":{"code":"pane_not_found"}}', stderr: '' };
        }
        if (tail.startsWith('pane run') || tail.startsWith('tab focus')) return { status: 0, stdout: '{}', stderr: '' };
        return { status: 0, stdout: '{}', stderr: '' };
      },
    };
    const launch = { command: 'echo', args: ['hi'] };
    expect(HerderTerminalEngine.openAgentWindow(runner, 'sandbox-w', 'w9', launch, '/tmp')).toBe('created');
    expect(HerderTerminalEngine.openAgentWindow(runner, 'sandbox-w', 'w9', launch, '/tmp')).toBe('reused');
    panes.set('w9', false);
    expect(HerderTerminalEngine.openAgentWindow(runner, 'sandbox-w', 'w9', launch, '/tmp')).toBe('respawned');
    expect(calls.some((call) => call.includes('tab') && call.includes('close'))).toBe(true);
    expect(calls.some((call) => call.includes('tab') && call.includes('create'))).toBe(true);
  });

  it('quotes launch vectors for pane run without a shell of its own', () => {
    expect(herderShellCommand({ command: 'docker', args: ['exec', 'c', 'echo', 'a b'] })).toBe(
      `docker exec c echo 'a b'`,
    );
    expect(herderShellCommand({ command: 'echo', args: [`it's $(x)`] })).toContain(`'it'\\''s $(x)'`);
  });

  it('kills sessions through stop-then-delete and lists names', () => {
    const { runner, calls } = scripted({
      'herdr --session s session stop': { status: 0, stdout: 'stopped session s', stderr: '' },
      'herdr --session s session delete': { status: 0, stdout: 'deleted session s', stderr: '' },
      'herdr --session default session list': { status: 0, stdout: SESSION_LIST, stderr: '' },
    });
    HerderTerminalEngine.killSession(runner, 's');
    expect(HerderTerminalEngine.listSessions(runner)).toEqual(['sandbox-w']);
    expect(calls.filter((call) => call.includes('session')).length).toBeGreaterThanOrEqual(3);
  });
});
