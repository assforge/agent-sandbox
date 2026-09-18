import { BUILTIN_CATALOG } from './engines/agent.js';

const SHARED_HELP = `Prerequisites: a container runtime (Docker) and a terminal engine
(tmux) on the host; see sandbox runtime help and sandbox terminal help
for alternatives. Doctor reports remediation commands but never installs
anything automatically.

Destructive operations ask for confirmation unless --yes is given.
Stopping a workspace keeps volumes. There is no purge command in this
release. Processes inside one container share a user and can read one
another's files; the isolation boundary is the container, not the
window.

Short flags: -w workspace, -n name, -i instance, -f file, -t tail,
-o output, -r root, -j json, -y yes. Destructive and rare operations
keep long-only flags on purpose.`;

function agentNames(): string {
  return BUILTIN_CATALOG.map((entry) => entry.name).join(', ');
}

export function topHelp(): string {
  return `Usage: sandbox [-w <path>] [--yes] [command]

Resolve the current workspace and start or reconnect its environment.
The first window is a shell. This command never starts an agent fleet.

Global options:
  --workspace, -w <path>   Operate on another registered workspace root.
  --yes, -y                Answer yes to confirmation prompts. Scripts only;
                           never combined with unreviewed destructive runs.
  --no-attach              Open or select the window without attaching.
                           The session keeps running for later attach.
  -h, --help               Show help. --version, -V show the version.

Daily use:
  sandbox [agent] [--name, -n <name>] [--no-attach] [-- <agent arguments...>]
    Open a named agent window in this workspace. The default instance
    name equals the agent name. Supported agents: ${agentNames()}.
    Arguments after -- are forwarded without reparsing. Each instance
    gets its own credentials and HOME directory; see
    sandbox credentials help.
  sandbox shell [--name, -n <name>] [--no-attach]
    Open a shell window in the workspace container.
  sandbox register [path]
    Register a workspace root. Defaults to the current directory.
    Short for sandbox workspace register --root <path>.
  sandbox unregister [path]
    Forget a workspace root after confirmation when anything is live.
    Volumes, networks, images, and credentials are always kept.
    Short for sandbox workspace unregister.
  sandbox doctor [--json, -j]
    Read-only diagnostics with remediation commands.
  sandbox workspace attach
    Reconnect only; fails when the session is absent, warns when the
    container is stopped.

Workspace lifecycle:
  sandbox workspace list [--json, -j]
  sandbox workspace status [--json, -j]
  sandbox workspace register --root, -r <path>
  sandbox workspace start
    Prepare the environment without attaching.
  sandbox workspace stop
    Ask for confirmation when instances are live. Keeps volumes.
  sandbox workspace reopen [--no-attach]
    Recreate every registered window after a reboot. The roster in the
    registry is the source of truth; agent conversations resume with
    each CLI's own resume flags.
  sandbox workspace logs [--tail, -t <n>]
    Show container output for debugging failed startups.
  sandbox workspace exec -- <command> [arguments...]
    Run a command in the ready container without adding a window.
    Starts a stopped container first and propagates the exit status.
  sandbox workspace configure [--add-mount <p> | --drop-mount <p> | --network open|restricted]
    Show redacted configuration, or change it with explicit approval.
  sandbox workspace backup --output, -o <path>
  sandbox workspace restore --input <path>
    Restore refuses backups recorded for another workspace.
  sandbox workspace migrate --source claude-relay [--apply]
    Dry-run by default; originals are always retained.

Instances and credentials:
  sandbox credentials list [--json, -j]
  sandbox credentials show --instance, -i <name>
    Key names only; values are never printed.
  sandbox credentials set --instance, -i <name> --file, -f <path>
    Store KEY=VALUE lines host-side with owner-only permissions.
    Secrets are never accepted as command-line arguments.
  sandbox credentials clear --instance, -i <name>

Agents and images:
  sandbox agent list [--json, -j]
  sandbox agent outdated [--json, -j]
  sandbox agent upgrade <agent|all>
    Builds a verified candidate only; activate explicitly afterwards.
    Running sessions are never restarted implicitly.
    claude tracks the vendor release feed; the rest track npm.
  sandbox image list [--json, -j]
  sandbox image build
  sandbox image activate <digest>
    Ask for confirmation when instances are live; recreates the
    container on the new image at the next start.
  sandbox image rollback <digest>
    Ask for confirmation when instances are live. Does not reverse
    a data migration.

Pluggable engines:
  sandbox runtime list [--json, -j]
  sandbox runtime use <name>
  sandbox terminal list [--json, -j]
  sandbox terminal use <name>
  sandbox --help
  sandbox --version

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

${SHARED_HELP}
`;
}

export function workspaceHelp(): string {
  return `Usage: sandbox workspace <action>

Actions: list, status, register, unregister, start, stop, attach, reopen,
logs, exec, configure, backup, restore, migrate.

start prepares the environment without attaching. attach only reconnects
and fails when the environment is absent; it warns when the container
is stopped. SSH into the host and attach from there: the session
switches to the new client with no nested session, and the environment
passes through untouched. reopen recreates every registered window,
which is the recovery path after a host reboot. stop requires
confirmation when instances are live, stops only managed resources for
this workspace, and keeps volumes. exec starts a stopped container
first. restore refuses foreign backups.

${SHARED_HELP}
`;
}

export function imageHelp(): string {
  return `Usage: sandbox image <action>

Actions: list, build, activate, rollback.

agent upgrade and image build only produce a candidate. activate and
rollback are explicit, separate interruption and cutover steps and both
ask for confirmation when instances are live. rollback requires an
earlier activation and does not reverse a data migration.

${SHARED_HELP}
`;
}

export function credentialsHelp(): string {
  return `Usage: sandbox credentials <action>

Actions: list, show, set, clear. All actions take --instance, -i <name>;
set additionally takes --file, -f <path> with KEY=VALUE lines.

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

Actions: list, use.

list shows every known container runtime with its capabilities and
verification status. use <name> selects the host default for new
workspaces; existing workspaces keep their recorded runtime until
sandbox workspace configure --runtime changes them. A workspace created
by another runtime fails closed instead of being adopted.

${SHARED_HELP}
`;
}

export function terminalHelp(): string {
  return `Usage: sandbox terminal <action>

Actions: list, use.

list shows every known terminal engine. use <name> selects the host
default for new workspaces; existing workspaces keep their recorded
terminal until sandbox workspace configure --terminal changes them.

${SHARED_HELP}
`;
}
