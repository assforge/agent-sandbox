export type ParsedCommand =
  | { kind: 'help'; topic?: string }
  | { kind: 'version' }
  | { kind: 'bare'; workspace?: string; noAttach?: boolean }
  | { kind: 'agent'; agent: string; name?: string; workspace?: string; forwarded: string[]; noAttach?: boolean }
  | { kind: 'shell'; name?: string; workspace?: string; noAttach?: boolean }
  | { kind: 'doctor'; json: boolean; workspace?: string }
  | { kind: 'workspace'; action: string; rest: string[]; workspace?: string }
  | { kind: 'agentAdmin'; action: string; rest: string[]; workspace?: string }
  | { kind: 'image'; action: string; rest: string[]; workspace?: string };

export const SUPPORTED_AGENTS = ['claude', 'opencode', 'codex', 'copilot'] as const;

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
  const workspace = takeOption(args, ['--workspace']);
  if (takeFlag(args, ['--help', '-h'])) return { kind: 'help' };
  if (takeFlag(args, ['--version', '-V'])) return { kind: 'version' };
  const noAttach = takeFlag(args, ['--no-attach']);
  if (args.length === 0) {
    if (forwarded.length > 0) throw new UsageError('unexpected -- separator with no command');
    return { kind: 'bare', workspace, noAttach };
  }
  const [first, ...rest] = args;
  if (first === 'shell') {
    if (rest.length > 2) throw new UsageError('sandbox shell takes at most --name <name>');
    const name = takeOption(rest, ['--name']);
    if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);
    if (forwarded.length > 0) throw new UsageError('sandbox shell does not forward arguments');
    return { kind: 'shell', name, workspace, noAttach };
  }
  if (first === 'doctor') {
    const json = takeFlag(rest, ['--json']) || forwarded.includes('--json');
    if (rest.length > 0) throw new UsageError('sandbox doctor takes no positional arguments');
    return { kind: 'doctor', json, workspace };
  }
  if (first === 'workspace' || first === 'agent' || first === 'image') {
    const action = rest[0];
    if (!action) throw new UsageError(`sandbox ${first} requires an action`);
    const tail = [...rest.slice(1), ...(forwarded.length > 0 ? ['--', ...forwarded] : [])];
    if (first === 'workspace') return { kind: 'workspace', action, rest: tail, workspace };
    if (first === 'image') return { kind: 'image', action, rest: tail, workspace };
    return { kind: 'agentAdmin', action, rest: tail, workspace };
  }
  if ((SUPPORTED_AGENTS as readonly string[]).includes(first)) {
    if (rest.length > 2) throw new UsageError(`unexpected argument: ${rest[0]} (use --name for instances, -- for agent arguments)`);
    const name = takeOption(rest, ['--name']);
    if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]} (use -- to forward agent arguments)`);
    return { kind: 'agent', agent: first, name, workspace, forwarded, noAttach };
  }
  throw new UsageError(`unknown command: ${first}`);
}
