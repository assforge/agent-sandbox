import { UsageError } from '../cli.js';
import { describeAction } from '../help.js';
import type { TerminalEngine } from '../engines/terminal.js';
import { CliError, type MainDeps } from './deps.js';
/** Print group or per-action help for resource groups. True when handled. */
export function printGroupHelp(deps: MainDeps, group: string, action: string, help: boolean, groupHelp: () => string): boolean {
  if (!action) {
    deps.stdout(groupHelp());
    return true;
  }
  if (help) {
    const block = describeAction(group, action);
    if (!block) throw new UsageError(`unknown ${group} action: ${action}`);
    deps.stdout(block);
    return true;
  }
  return false;
}
export function takeRestOption(rest: string[], names: string[]): string | undefined {
  const index = rest.findIndex((arg) => names.includes(arg));
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (!value || value.startsWith('-')) throw new UsageError(`option ${rest[index]} requires a value`);
  return value;
}
/** Reattach, turning a terminal-less failure into an actionable message: the window itself is already ready. */
export function reattachOrHint(deps: MainDeps, term: TerminalEngine, session: string): void {
  try {
    term.reattach(deps.runner, session, deps.insideTerminal);
  } catch (error) {
    throw new CliError(
      `cannot attach to session ${session}: ${(error as Error).message}; the window is ready, attach from a terminal with: sandbox workspace attach`,
      1,
    );
  }
}
