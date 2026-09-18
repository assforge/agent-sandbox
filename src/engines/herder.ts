/**
 * HerderTerminalEngine: Herdr agent multiplexer as a TerminalEngine.
 *
 * Verified live against herdr 0.9.0 on 2026-09-18 (isolated scratch
 * session, cleaned afterwards): session list/stop/delete, workspace
 * create/close, tab create/list/close/focus, pane run/read/get.
 *
 * Mapping: sandbox session -> herder named session; sandbox workspace ->
 * one herder workspace per session (labeled with the sandbox id);
 * sandbox window/instance -> herder tab (labeled with the instance
 * name) carrying --env credentials; launch runs through pane run.
 *
 * Two herder behaviors shape this mapping, both verified live:
 * - Errors arrive as JSON {"error": {...}} often with exit code 0, so
 *   every call inspects the payload, never just the exit status.
 * - Dead panes vanish with their tabs (no corpses): window absence is
 *   the dead signal, and respawn is identical to create.
 */
import type { CommandRunner } from '../docker.js';
import { runTerminal } from '../docker.js';
import { assertSafeName, type ExecSpec } from './types.js';
import type { TerminalEngine } from './terminal.js';

export interface HerderIds {
  workspace: string;
  tab: string;
  pane: string;
}

/** Run a herdr command and return the parsed result payload. Throws on any error shape. */
export function herdrCall(runner: CommandRunner, session: string, args: string[]): Record<string, unknown> {
  const result = runner.run('herdr', ['--session', session, ...args]);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`herdr ${args[0] ?? ''} failed: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`herdr ${args[0] ?? ''} returned non-JSON output`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`herdr ${args[0] ?? ''} returned an unexpected shape`);
  }
  const record = parsed as Record<string, unknown>;
  if ('error' in record) {
    const failure = record['error'] as { code?: unknown; message?: unknown };
    throw new Error(`herdr ${args[0] ?? ''} failed: ${String(failure.code ?? 'error')}: ${String(failure.message ?? '')}`);
  }
  return record;
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('herdr returned an unexpected shape');
  return value as Record<string, unknown>[];
}

function resultList(payload: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  // The herder CLI mixes two shapes: bare {"sessions": [...]} for some
  // list commands and {"result": {...}} wrappers for mutating calls.
  const scopes: Record<string, unknown>[] = [payload];
  const result = payload['result'];
  if (typeof result === 'object' && result !== null) scopes.push(result as Record<string, unknown>);
  for (const scope of scopes) {
    for (const key of keys) {
      const value = scope[key];
      if (value !== undefined) return asArray(value);
    }
  }
  throw new Error('herdr returned an unexpected shape');
}

export function herderSessionAlive(runner: CommandRunner, session: string): boolean {
  let payload: Record<string, unknown>;
  try {
    payload = herdrCall(runner, session, ['session', 'list', '--json']);
  } catch (error) {
    if ((error as Error).message.includes('server_not_running')) return false;
    throw error;
  }
  const sessions = resultList(payload, ['sessions']);
  return sessions.some((entry) => entry['name'] === session && entry['running'] !== false);
}

export function herderEnsureWorkspace(runner: CommandRunner, session: string, label: string, cwd: string): string {
  const listed = herdrCall(runner, session, ['workspace', 'list']);
  const workspaces = resultList(listed, ['workspaces']);
  const found = workspaces.find((entry) => entry['label'] === label);
  if (found && typeof found['workspace_id'] === 'string') return found['workspace_id'];
  const created = herdrCall(runner, session, ['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus']);
  const createdResult = created['result'] as Record<string, unknown>;
  const workspace = createdResult['workspace'] as { workspace_id?: unknown };
  if (!workspace || typeof workspace.workspace_id !== 'string') {
    throw new Error('herdr workspace create returned an unexpected shape');
  }
  return workspace.workspace_id;
}

function isServerDown(error: unknown): boolean {
  return (error as Error).message.includes('server_not_running');
}

export function herderTabId(runner: CommandRunner, session: string, label: string): string | null {
  let listed: Record<string, unknown>;
  try {
    listed = herdrCall(runner, session, ['tab', 'list']);
  } catch (error) {
    if (isServerDown(error)) return null;
    throw error;
  }
  const tabs = resultList(listed, ['tabs']);
  const found = tabs.find((entry) => entry['label'] === label);
  return typeof found?.['tab_id'] === 'string' ? (found['tab_id'] as string) : null;
}

/** First pane cwd of a tab, used to recreate it in place. Falls back to /tmp. */
export function herderTabCwd(runner: CommandRunner, session: string, tabId: string): string {
  let listed: Record<string, unknown>;
  try {
    listed = herdrCall(runner, session, ['pane', 'list']);
  } catch (error) {
    if (isServerDown(error)) return '/tmp';
    throw error;
  }
  const panes = resultList(listed, ['panes']);
  const found = panes.find((entry) => entry['tab_id'] === tabId);
  const cwd = (found as Record<string, unknown> | undefined)?.['cwd'];
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : '/tmp';
}

export function herderRootPane(runner: CommandRunner, session: string, tabId: string): string | null {
  let listed: Record<string, unknown>;
  try {
    listed = herdrCall(runner, session, ['pane', 'list']);
  } catch (error) {
    if (isServerDown(error)) return null;
    throw error;
  }
  const panes = resultList(listed, ['panes']);
  const found = panes.find((entry) => entry['tab_id'] === tabId);
  return typeof found?.['pane_id'] === 'string' ? (found['pane_id'] as string) : null;
}

/** Submit a launch command to a pane. Unlike tmux respawn, herder pane
 * run never kills first: callers must close a dead tab before recreating
 * it, never submit into a possibly-live pane. */
export function runInPane(runner: CommandRunner, session: string, pane: string, command: ExecSpec): void {
  const launched = runner.run('herdr', ['--session', session, 'pane', 'run', pane, herderShellCommand(command)]);
  if (launched.status !== 0) {
    throw new Error(`herdr pane run failed: ${launched.stderr.trim() || launched.stdout.trim()}`);
  }
}
export function herderShellCommand(command: ExecSpec): string {
  // POSIX single-quote escaping shared with the tmux display renderer:
  // values stay inert when the pane shell parses them.
  const quote = (part: string): string => {
    if (/^[A-Za-z0-9_./:=-]+$/.test(part)) return part;
    return `'${part.replace(/'/g, `'\\''`)}'`;
  };
  return [command.command, ...command.args].map(quote).join(' ');
}

export const HerderTerminalEngine: TerminalEngine = {
  name: 'herder',
  cliBinary: 'herdr',
  installHint: (platform) => {
    if (platform === 'darwin' || platform === 'linux') return 'installation command: brew install herdr';
    return 'Install herdr from https://herdr.dev/docs/install/, then run this check again';
  },

  assertWindowName(name: string): void {
    assertSafeName('instance', name);
  },

  sessionAlive(runner, session) {
    return herderSessionAlive(runner, session);
  },

  newSession(runner, session, window, workdir, command) {
    HerderTerminalEngine.assertWindowName(window);
    herderEnsureWorkspace(runner, session, session, workdir);
    const tabId = herderTabId(runner, session, window);
    if (tabId) {
      HerderTerminalEngine.respawnWindow(runner, session, window, command);
      return;
    }
    HerderTerminalEngine.newWindow(runner, session, window, workdir, command);
  },

  newWindow(runner, session, window, workdir, command) {
    HerderTerminalEngine.assertWindowName(window);
    const workspace = herderEnsureWorkspace(runner, session, session, workdir);
    const created = herdrCall(runner, session, ['tab', 'create', '--workspace', workspace, '--label', window, '--cwd', workdir, '--no-focus']);
    const createdResult = created['result'] as Record<string, unknown>;
    const pane = createdResult['root_pane'] as { pane_id?: unknown };
    if (!pane || typeof pane.pane_id !== 'string') {
      throw new Error('herdr tab create returned an unexpected shape');
    }
    runInPane(runner, session, pane.pane_id, command);
  },

  windowExists(runner, session, window) {
    return herderTabId(runner, session, window) !== null;
  },

  selectWindow(runner, session, window) {
    const tabId = herderTabId(runner, session, window);
    if (!tabId) throw new Error(`herdr tab not found: ${window}`);
    herdrCall(runner, session, ['tab', 'focus', tabId]);
  },

  paneAlive(runner, session, window) {
    const tabId = herderTabId(runner, session, window);
    if (!tabId) return false;
    const pane = herderRootPane(runner, session, tabId);
    if (!pane) return false;
    try {
      herdrCall(runner, session, ['pane', 'get', pane]);
      return true;
    } catch {
      return false;
    }
  },

  respawnWindow(runner, session, window, launch) {
    // Unlike tmux respawn-pane -k, herder pane run never kills first:
    // submitting into a possibly-live pane would type into it. Close the
    // dead tab and recreate it instead. Callers only reach here after the
    // pane read as dead.
    HerderTerminalEngine.assertWindowName(window);
    const tabId = herderTabId(runner, session, window);
    if (!tabId) {
      throw new Error(`herdr tab not found: ${window}`);
    }
    const workdir = herderTabCwd(runner, session, tabId);
    const closed = runner.run('herdr', ['--session', session, 'tab', 'close', tabId]);
    if (closed.status !== 0) {
      throw new Error(`herdr tab close failed: ${closed.stderr.trim() || closed.stdout.trim()}`);
    }
    HerderTerminalEngine.newWindow(runner, session, window, workdir, launch);
  },

  reattach(runner, session, insideHerder) {
    if (insideHerder) return;
    const result = runTerminal(runner, 'herdr', ['session', 'attach', session]);
    if (result.status !== 0) {
      throw new Error(`cannot attach to herder session ${session}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  },

  killSession(runner, session) {    // stop/delete answer in plain text, not JSON: exit status decides.
    const stopped = runner.run('herdr', ['--session', session, 'session', 'stop', session]);
    if (stopped.status !== 0) {
      const text = `${stopped.stdout} ${stopped.stderr}`;
      if (!/not running|not found|no herdr server is running/.test(text)) {
        throw new Error(`herdr session stop failed: ${text.trim()}`);
      }
    }
    const deleted = runner.run('herdr', ['--session', session, 'session', 'delete', session]);
    if (deleted.status !== 0) {
      const text = `${deleted.stdout} ${deleted.stderr}`;
      if (!/not found|no herdr server is running/.test(text)) {
        throw new Error(`herdr session delete failed: ${text.trim()}`);
      }
    }
  },

  closeWindow(runner, session, window) {
    const tabId = herderTabId(runner, session, window);
    if (!tabId) return;
    const closed = runner.run('herdr', ['--session', session, 'tab', 'close', tabId]);
    if (closed.status !== 0) {
      throw new Error(`herdr tab close failed: ${closed.stderr.trim() || closed.stdout.trim()}`);
    }
  },

  listSessions(runner) {
    const payload = herdrCall(runner, 'default', ['session', 'list', '--json']);
    return resultList(payload, ['sessions'])
      .map((entry) => entry['name'])
      .filter((name): name is string => typeof name === 'string');
  },

  openAgentWindow(runner, session, window, launch, hostWorkdir) {
    if (!HerderTerminalEngine.sessionAlive(runner, session)) {
      HerderTerminalEngine.assertWindowName(window);
      HerderTerminalEngine.newSession(runner, session, window, hostWorkdir, launch);
      return 'created';
    }
    if (HerderTerminalEngine.windowExists(runner, session, window)) {
      if (HerderTerminalEngine.paneAlive(runner, session, window)) {
        HerderTerminalEngine.selectWindow(runner, session, window);
        return 'reused';
      }
      HerderTerminalEngine.respawnWindow(runner, session, window, launch);
      HerderTerminalEngine.selectWindow(runner, session, window);
      return 'respawned';
    }
    HerderTerminalEngine.assertWindowName(window);
    HerderTerminalEngine.newWindow(runner, session, window, hostWorkdir, launch);
    HerderTerminalEngine.selectWindow(runner, session, window);
    return 'created';
  },
};
