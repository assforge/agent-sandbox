export const SANDBOX_VERSION = '0.1.0';

const SHARED_HELP = `Prerequisites: Docker and tmux are host dependencies. Doctor reports
remediation commands but never installs anything automatically.

Destructive operations always ask for confirmation. Stopping a workspace
keeps volumes. There is no purge command in this release.`;

export function topHelp(): string {
  return `Usage: sandbox [--workspace <path>] [command]

Resolve the current workspace and start or reconnect its environment.
The first window is a shell. This command never starts an agent fleet.

Commands:
  sandbox [agent] [--name <name>] [-- <agent arguments...>]
    Open a named agent window in this workspace. The default instance
    name equals the agent name. Supported agents: claude, opencode,
    codex, copilot. Arguments after -- are forwarded without reparsing.
  sandbox shell [--name <name>]
    Open a shell window in the workspace container.
  sandbox doctor [--json]
    Read-only diagnostics with remediation commands.
  sandbox workspace list [--json]
  sandbox workspace status [--json]
  sandbox workspace register --root <path>
  sandbox workspace start
  sandbox workspace stop
  sandbox workspace attach
  sandbox workspace exec -- <command> [arguments...]
  sandbox workspace configure
  sandbox workspace backup --output <path>
  sandbox workspace migrate --source claude-relay [--apply]
  sandbox agent list [--json]
  sandbox agent outdated [--json]
  sandbox agent upgrade <agent|all>
  sandbox image list [--json]
  sandbox image build
  sandbox image activate <digest>
  sandbox image rollback <digest>
  sandbox --help
  sandbox --version

${SHARED_HELP}
`;
}

export function agentHelp(): string {
  return `Usage: sandbox <agent> [--name <name>] [-- <agent arguments...>]

Supported agents: claude, opencode, codex, copilot.

An existing matching instance is selected. An occupied name of another
kind is rejected. Additional instances require distinct names.

Everything after -- is forwarded to the agent without reparsing.
Provider secrets are not accepted as wrapper command-line arguments.

${SHARED_HELP}
`;
}

export function workspaceHelp(): string {
  return `Usage: sandbox workspace <action>

Actions: list, status, register, start, stop, attach, exec, configure,
backup, migrate.

start prepares the environment without attaching. attach only reconnects
and fails when the environment is absent. stop requires confirmation
when instances are live, stops only managed resources for this
workspace, and keeps volumes.

${SHARED_HELP}
`;
}

export function imageHelp(): string {
  return `Usage: sandbox image <action>

Actions: list, build, activate, rollback.

agent upgrade and image build only produce a candidate. activate is the
explicit, separate interruption and cutover step. Interrupting running
processes is disclosed and confirmed first. rollback requires explicit
activation and does not reverse a data migration.

${SHARED_HELP}
`;
}
