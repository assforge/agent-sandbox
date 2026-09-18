export type ParsedCommand =
  | { kind: 'help'; topic?: string }
  | { kind: 'version' }
  | { kind: 'bare'; workspace?: string; noAttach?: boolean }
  | { kind: 'agent'; agent: string; name?: string; workspace?: string; forwarded: string[]; noAttach?: boolean }
  | { kind: 'shell'; name?: string; workspace?: string; noAttach?: boolean }
  | { kind: 'doctor'; json: boolean; workspace?: string }
  | { kind: 'workspace'; action: string; rest: string[]; workspace?: string; help: boolean }
  | { kind: 'link'; root?: string; workspace?: string; help: boolean }
  | { kind: 'unlink'; root?: string; workspace?: string; help: boolean }
  | { kind: 'agentAdmin'; action: string; rest: string[]; workspace?: string; help: boolean }
  | { kind: 'credentials'; action: string; rest: string[]; workspace?: string; help: boolean }
  | { kind: 'runtime'; action: string; rest: string[]; help: boolean }
  | { kind: 'terminal'; action: string; rest: string[]; help: boolean }
  | { kind: 'image'; action: string; rest: string[]; workspace?: string; help: boolean }
  | { kind: 'update'; check: boolean; help: boolean };

export const SUPPORTED_AGENTS = ['claude', 'opencode', 'codex', 'copilot'] as const;

/** Long-standing action aliases resolve to their canonical short form. */
export function canonicalAction(group: string, action: string): string {
  if (group === 'workspace' && action === 'register') return 'link';
  if (group === 'workspace' && action === 'unregister') return 'unlink';
  return action;
}

export class UsageError extends Error {
  readonly exitCode = 2;
}

function takeOption(args: string[], names: string[]): string | undefined {
  const index = args.findIndex((arg) => names.includes(arg));
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new UsageError(`option ${args[index]} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], names: string[]): boolean {
  const index = args.findIndex((arg) => names.includes(arg));
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

/** Split argv at the first -- separator. The tail is forwarded verbatim. */
export function splitForwarded(argv: string[]): { head: string[]; forwarded: string[] } {
  const index = argv.indexOf('--');
  if (index < 0) return { head: [...argv], forwarded: [] };
  return { head: argv.slice(0, index), forwarded: argv.slice(index + 1) };
}

export function parseArgs(argv: string[]): ParsedCommand {
  const { head, forwarded } = splitForwarded(argv);
  const args = [...head];
  const workspace = takeOption(args, ['--workspace', '-w']);
  if (takeFlag(args, ['--version', '-V'])) return { kind: 'version' };
  const noAttach = takeFlag(args, ['--no-attach']);
  if (args.length === 0) {
    if (forwarded.length > 0) throw new UsageError('unexpected -- separator with no command');
    return { kind: 'bare', workspace, noAttach };
  }
  const [first, ...rest] = args;
  if (first === 'workspace' || first === 'agent' || first === 'image' || first === 'credentials' || first === 'runtime' || first === 'terminal') {
    const help = takeFlag(rest, ['--help', '-h']);
    const action = rest[0] ?? '';
    const tail = [...rest.slice(action ? 1 : 0), ...(forwarded.length > 0 ? ['--', ...forwarded] : [])];
    if (first === 'workspace') return { kind: 'workspace', action, rest: tail, workspace, help };
    if (first === 'image') return { kind: 'image', action, rest: tail, workspace, help };
    if (first === 'credentials') return { kind: 'credentials', action, rest: tail, workspace, help };
    if (first === 'runtime') return { kind: 'runtime', action, rest: tail, help };
    if (first === 'terminal') return { kind: 'terminal', action, rest: tail, help };
    return { kind: 'agentAdmin', action, rest: tail, workspace, help };
  }
  if (first === 'link' || first === 'unlink') {
    const help = takeFlag(rest, ['--help', '-h']);
    if (rest.length > 1) throw new UsageError(`sandbox ${first} takes at most one path`);
    const root = rest[0];
    if (root !== undefined && root.startsWith('-')) throw new UsageError(`unexpected option: ${root}`);
    if (forwarded.length > 0) throw new UsageError(`sandbox ${first} does not forward arguments`);
    if (first === 'link') return { kind: 'link', root, workspace, help };
    return { kind: 'unlink', root, workspace, help };
  }
  if (first === 'update') {
    const help = takeFlag(rest, ['--help', '-h']);
    const check = takeFlag(rest, ['--check']);
    if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);
    if (forwarded.length > 0) throw new UsageError('sandbox update does not forward arguments');
    return { kind: 'update', check, help };
  }
  if (takeFlag(args, ['--help', '-h'])) return { kind: 'help' };
  if (first === 'shell') {
    if (rest.length > 2) throw new UsageError('sandbox shell takes at most --name <name>');
    const name = takeOption(rest, ['--name', '-n']);
    if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);
    if (forwarded.length > 0) throw new UsageError('sandbox shell does not forward arguments');
    return { kind: 'shell', name, workspace, noAttach };
  }
  if (first === 'doctor') {
    const json = takeFlag(rest, ['--json', '-j']) || forwarded.includes('--json');
    if (rest.length > 0) throw new UsageError('sandbox doctor takes no positional arguments');
    return { kind: 'doctor', json, workspace };
  }
  if ((SUPPORTED_AGENTS as readonly string[]).includes(first)) {
    if (rest.length > 2) throw new UsageError(`unexpected argument: ${rest[0]} (use --name for instances, -- for agent arguments)`);
    const name = takeOption(rest, ['--name', '-n']);
    if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]} (use -- to forward agent arguments)`);
    return { kind: 'agent', agent: first, name, workspace, forwarded, noAttach };
  }
  throw new UsageError(`unknown command: ${first}`);
}
