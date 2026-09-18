import { BUILTIN_CATALOG } from './engines/agent.js';
import { canonicalAction } from './cli.js';

const SHARED_HELP = `Prerequisites: a container runtime (Docker) and a terminal engine
(tmux) on the host; see sandbox runtime help and sandbox terminal help
for alternatives. Doctor reports remediation commands but never installs
anything automatically.

Destructive operations ask for confirmation unless --yes is given.
Stopping a workspace keeps volumes. There is no purge command in this
release. Processes inside one container share a user and can read one
another's files; the isolation boundary is the container, not the
window.

Short flags are shown next to the option they abbreviate in each
usage line; destructive and rare operations keep long-only flags
on purpose.`;

function agentNames(): string {
  return BUILTIN_CATALOG.map((entry) => entry.name).join(', ');
}

export function topHelp(): string {
  return `Usage: sandbox [OPTIONS] COMMAND

A sandboxed multi-agent workbench: one workspace owns one container
and one host tmux session; each agent instance owns a window.

Options:
  -w, --workspace <path>   Operate on another workspace. Defaults to the
                           workspace containing the current directory.
  -y, --yes                Answer yes to confirmation prompts. Scripts only;
                           never combined with unreviewed destructive runs.
      --no-attach          Open or select the window without attaching.
  -h, --help               Show help. --version, -V show the version.

Commands:
  agent        Open agent windows (claude, opencode, codex, copilot)
  shell        Open a shell window in this workspace
  link         Link a workspace root into management
  unlink       Unlink a workspace root, keep all data
  workspace    Manage workspace environments
  image        Build, activate, and roll back workspace images
  credentials  Manage per-instance secrets on the host
  runtime      Select the container backend (docker, apple)
  terminal     Select the terminal backend (tmux, herder)
  doctor       Read-only diagnostics with remediation commands
  update       Upgrade this CLI in place

Run 'sandbox COMMAND --help' for more information on a command.

${SHARED_HELP}
`;
}

export function agentHelp(): string {
  return `Usage: sandbox <agent> [--name, -n <name>] [--no-attach] [-- <agent arguments...>]

Supported agents: ${agentNames()} (see sandbox agent list for the live registry).

An existing matching instance is selected. An occupied name of another
kind is rejected. Additional instances require distinct names.
Instance names use letters, digits, dot, underscore, or hyphen.

Everything after -- is forwarded to the agent without reparsing.
Provider secrets are not accepted as wrapper command-line arguments;
store them with sandbox credentials set instead.

See also: sandbox agent list, sandbox agent outdated, sandbox agent upgrade.

${SHARED_HELP}
`;
}

export function workspaceHelp(): string {
  return `Usage: sandbox workspace <action>

Commands:
  list         List registered workspaces
  status       Show container, session, and instance state
  link         Link a workspace root (register is an alias)
  unlink       Unlink a workspace root, keep all data (unregister is an alias)
  start        Prepare the environment without attaching
  stop         Stop the container, keep volumes
  restart      Stop and bring the same image back
  upgrade      Rebuild agents and recreate in one step
  prune        Remove stopped containers, keep everything else
  attach       Reconnect to the terminal session
  reopen       Recreate every registered window
  logs         Show container output for debugging
  exec         Run a command in the ready container
  configure    Show or change redacted configuration
  mount        Add a mount for the next start
  unmount      Drop a mount for the next start
  backup       Copy workspace state host-side
  restore      Restore a workspace backup
  migrate      Move state from the legacy prototype

Run 'sandbox workspace ACTION --help' for more information on an action.
SSH into the host and attach from there: the session switches to the
new client with no nested session, and the environment passes through
untouched.

${SHARED_HELP}
`;
}

export function imageHelp(): string {
  return `Usage: sandbox image <action>

Commands:
  list         List local workspace images
  build        Build a verified candidate from pinned versions
  activate     Cut over to a candidate at the next start
  rollback     Re-activate the previous image

Run 'sandbox image ACTION --help' for more information on an action.
agent upgrade and image build only produce a candidate. activate and
rollback are explicit, separate interruption and cutover steps and both
ask for confirmation when instances are live. rollback requires an
earlier activation and does not reverse a data migration.

${SHARED_HELP}
`;
}

export function credentialsHelp(): string {
  return `Usage: sandbox credentials <action>

Commands:
  list         List instances holding credential files
  show         Show key names with masked values
  set          Store a KEY=VALUE file with owner-only permissions
  clear        Delete the instance credential file

All actions take --instance, -i <name>; set additionally takes
--file, -f <path> with KEY=VALUE lines. Run
'sandbox credentials ACTION --help' for more information on an action.

Credential files live host-side under ~/.agent.sandbox/<workspace>/ and are
injected as process environment only into that instance's window. They
are never accepted as command-line arguments, never baked into images,
and never printed: show displays key names with masked values.

Each instance also gets its own HOME directory inside the container,
so agent configuration and history do not cross between instances of
one workspace. Instances of one container can still read one another's
files; the isolation boundary is the container, not the window.

${SHARED_HELP}
`;
}

export function runtimeHelp(): string {
  return `Usage: sandbox runtime <action>

Commands:
  list         Show runtimes with capabilities and verification status
  use          Select the host default for new workspaces

Run 'sandbox runtime ACTION --help' for more information on an action.
Existing workspaces keep their recorded runtime until
sandbox workspace configure --runtime changes them. A workspace created
by another runtime fails closed instead of being adopted.

${SHARED_HELP}
`;
}

export function terminalHelp(): string {
  return `Usage: sandbox terminal <action>

Commands:
  list         Show every known terminal engine
  use          Select the host default for new workspaces

Run 'sandbox terminal ACTION --help' for more information on an action.
Existing workspaces keep their recorded terminal until
sandbox workspace configure --terminal changes them.

${SHARED_HELP}
`;
}

export function linkHelp(): string {
  return `Usage: sandbox link [path]

Link a workspace root into sandbox management. Defaults to the current
directory. Long form: sandbox workspace link --root <path>.
`;
}

export function unlinkHelp(): string {
  return `Usage: sandbox unlink [path]

Unlink a workspace root after confirmation when anything is live.
Volumes, networks, images, and credentials are always kept, exactly
like unlinking a name without deleting its content.
Long form: sandbox workspace unlink.
`;
}

export function updateHelp(): string {
  return `Usage: sandbox update [--check]

Upgrade this CLI in place from the package registry. --check reports
current and latest versions without changing anything. Uses your own
npm authentication; running workspaces are untouched.
`;
}

const ACTION_HELP: Record<string, Record<string, string>> = {
  workspace: {
    list: 'Usage: sandbox workspace list [--json, -j]\n\nList registered workspaces.\n',
    status: 'Usage: sandbox workspace status [--json, -j]\n\nShow container, session, and instance state.\n',
    link: 'Usage: sandbox workspace link --root, -r <path>\n\nLink a workspace root into management. Short form: sandbox link [path]. register is an accepted alias.\n',
    unlink: 'Usage: sandbox workspace unlink\n\nUnlink the workspace after confirmation when anything is live. Volumes, networks, images, and credentials are always kept. Short form: sandbox unlink [path]. unregister is an accepted alias.\n',
    start: 'Usage: sandbox workspace start\n\nPrepare the environment without attaching.\n',
    stop: 'Usage: sandbox workspace stop\n\nAsk for confirmation when instances are live. Keeps volumes.\n',
    restart: 'Usage: sandbox workspace restart\n\nStop and bring the same image back. Asks for confirmation when instances are live.\n',
    upgrade: 'Usage: sandbox workspace upgrade [agent|all]\n\nResolve latest agent versions, skip the build when everything is current, and otherwise build, activate, and recreate in one confirmed step.\n',
    prune: 'Usage: sandbox workspace prune [--all]\n\nRemove stopped containers of this workspace (or every registered workspace with --all) after one confirmation. Volumes, networks, images, and the registry are kept.\n',
    attach: 'Usage: sandbox workspace attach\n\nReconnect only; fails when the session is absent, warns when the container is stopped.\n',
    reopen: 'Usage: sandbox workspace reopen [--no-attach]\n\nRecreate every registered window after a reboot. The roster in the registry is the source of truth.\n',
    logs: 'Usage: sandbox workspace logs [--tail, -t <n>]\n\nShow container output for debugging failed startups.\n',
    exec: 'Usage: sandbox workspace exec -- <command> [arguments...]\n\nRun a command in the ready container without adding a window. Starts a stopped container first and propagates the exit status.\n',
    configure: 'Usage: sandbox workspace configure [--add-mount <p> | --drop-mount <p> | --network open|restricted | --runtime <name> | --terminal <name>]\n\nShow redacted configuration, or change it with explicit approval.\n',
    mount: 'Usage: sandbox workspace mount <path>\n\nShort for configure --add-mount. Applies on next start.\n',
    unmount: 'Usage: sandbox workspace unmount <path>\n\nShort for configure --drop-mount. Applies on next start. Cannot drop the workspace root.\n',
    backup: 'Usage: sandbox workspace backup --output, -o <path>\n\nCopy workspace state host-side for recovery.\n',
    restore: 'Usage: sandbox workspace restore --input <path>\n\nRestore refuses backups recorded for another workspace.\n',
    migrate: 'Usage: sandbox workspace migrate --source claude-relay [--apply]\n\nDry-run by default; originals are always retained.\n',
  },
  agent: {
    list: 'Usage: sandbox agent list [--json, -j]\n\nList supported agents with their install channel and pinned version.\n',
    outdated: 'Usage: sandbox agent outdated [--json, -j]\n\nCompare installed, pinned, and latest versions. claude tracks the vendor release feed; the rest track npm.\n',
    upgrade: 'Usage: sandbox agent upgrade <agent|all>\n\nBuild a verified candidate only; activate explicitly afterwards. Running sessions are never restarted implicitly.\n',
  },
  image: {
    list: 'Usage: sandbox image list [--json, -j]\n\nList local workspace images.\n',
    build: 'Usage: sandbox image build\n\nBuild a verified candidate from pinned versions; activate explicitly afterwards.\n',
    activate: 'Usage: sandbox image activate <digest>\n\nAsk for confirmation when instances are live; recreates the container on the new image at the next start.\n',
    rollback: 'Usage: sandbox image rollback <digest>\n\nAsk for confirmation when instances are live. Requires an earlier activation and does not reverse a data migration.\n',
  },
  credentials: {
    list: 'Usage: sandbox credentials list [--json, -j]\n\nList instances holding credential files.\n',
    show: 'Usage: sandbox credentials show --instance, -i <name>\n\nKey names only; values are never printed.\n',
    set: 'Usage: sandbox credentials set --instance, -i <name> --file, -f <path>\n\nStore KEY=VALUE lines host-side with owner-only permissions. Secrets are never accepted as command-line arguments.\n',
    clear: 'Usage: sandbox credentials clear --instance, -i <name>\n\nDelete the instance credential file.\n',
  },
  runtime: {
    list: 'Usage: sandbox runtime list [--json, -j]\n\nShow every known container runtime with capabilities and verification status.\n',
    use: 'Usage: sandbox runtime use <name>\n\nSelect the host default for new workspaces; existing workspaces keep theirs until configured otherwise.\n',
  },
  terminal: {
    list: 'Usage: sandbox terminal list [--json, -j]\n\nShow every known terminal engine.\n',
    use: 'Usage: sandbox terminal use <name>\n\nSelect the host default for new workspaces; existing workspaces keep theirs until configured otherwise.\n',
  },
};

/** Per-action help block, or null when the action is unknown. */
export function describeAction(group: string, action: string): string | null {
  return ACTION_HELP[group]?.[canonicalAction(group, action)] ?? null;
}
