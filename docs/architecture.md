# sandbox architecture

Sandboxed multi-agent workbench. One workspace owns one managed
container and one host tmux session; each agent instance owns a window
whose process runs inside that workspace's container.

```
                                HOST
  +----------------------------------------------------------+
  |  sandbox CLI (node, @assforge/cogent-sandbox)            |
  |    |                                                     |
  |    +-- registry  ~/.agent.sandbox/registry.json          |
  |    +-- locks     ~/.agent.sandbox/locks/<id>             |
  |    +-- secrets   ~/.agent.sandbox/<id>/instances/*.env   |
  |                                                          |
  |  tmux server                                             |
  |    +-- session sandbox-<id>                              |
  |          +-- window claude   (docker exec into container)|
  |          +-- window codex    (docker exec into container)|
  |          +-- window shell    (docker exec into container)|
  +----------------------------------------------------------+
          |                              |
          | docker exec / logs / cp      | tmux control
          v                              v
  +----------------------+     +----------------------+
  | container            |     | (same tmux server,   |
  | sandbox-<id>         |     |  host-side windows)  |
  |  /Users/.../microsb  |     +----------------------+
  |  (same-path bind)    |
  |  /home/agent         | <-- home volume sandbox-home-<id>
  |  /home/agent/instances/<name>  (fork/fresh homes) |
  |  sandbox-ready/ready.json (readiness token)       |
  +----------------------+
```

## 1. Resource ownership

```
workspace (registry entry)
  |-- container        sandbox-<id>      (one, recreated on drift)
  |-- tmux session     sandbox-<id>      (one, survives container restarts)
  |-- home volume      sandbox-home-<id> (agent state, survives everything)
  |-- network          sandbox-net-<id>  (open | restricted)
  |-- image pointer    current tag + previous tag (rollback target)
  |-- mounts           workspace root + extra read-only binds
  |-- roster           instances [{name, kind, window, homeMode?}]
  |-- forks            fork names with state under instances/
```

The workspace id is the first 12 hex characters of the sha256 of the
canonical root. Container, session, volume, and network names all
derive from it deterministically, so nothing needs to be remembered
beyond the registry file. There is deliberately no purge command:
unlink forgets the mapping; volumes, networks, images, and
credentials are always kept.

## 2. Host state layout

```
~/.agent.sandbox/
  registry.json            all workspaces (atomic rewrites)
  config.json              host defaults: runtime, terminal
  locks/<id>               per-workspace mutex for mutations
  <id>/instances/<n>.env   KEY=VALUE secrets, owner-only permissions
  engines/*.json           user-supplied agent catalogs (optional)
```

First run after upgrade moves a legacy `~/.sandbox` tree here exactly
once and says so on stderr. It never merges: if the new directory
already exists, the old one is left untouched.

## 3. Engine seams (D8)

Core logic depends on interfaces; vendor specifics live in engine
modules. Adding an agent, terminal, or runtime means adding data plus
one implementation, never touching orchestration.

```
AgentEngine       which agent runs (install channel + launch shape)
  npm      opencode  opencode-ai@1.18.31
           codex     @openai/codex@0.154.0
           copilot   @github/copilot@1.0.85
  native   claude    official installer under /opt/claude, pinned
                     (e.g. 2.1.276), latest tracked through the vendor
                     release feed. grok/agy have no verified linux
                     channel and stay unsupported.

TerminalEngine    where windows live
  tmux     default: sessions, windows, panes, attach, close
  herder   herdr 0.9.x: sessions, tabs, panes, attach, close

RuntimeEngine     where containers live
  docker   default, capability-verified
  apple    Apple Container, capability-verified (live e2e incl.
           same-path binds)

Each engine declares capabilities; missing capabilities fail closed
instead of degrading silently.

...[truncated 6151 chars]## 4. Container anatomy

```
image (built from templates/Dockerfile, no secrets)
  base                     node:22-bookworm-slim
  npm globals              opencode-ai, @openai/codex, @github/copilot (pinned)
  /opt/claude              claude via official installer (pinned, agent-owned)
  agent user               uid 1001 (pinned), everything runs as agent
  entrypoint               setup state dirs, write ready.json, exec CMD

container (per workspace, cap-drop ALL)
  mounts                   root-to-root rw + extra mounts ro
  home volume              mounted at /home/agent
  env                      SANDBOX_GENERATION + SANDBOX_CONFIG_FINGERPRINT
  readiness                /tmp/sandbox-ready/ready.json, polled by ensureReady
```

The workspace root binds at its own path inside the container, so
absolute paths, editor links, and cwd-keyed agent state survive the
boundary. The home volume is mounted over `/home/agent`, which is why
installed binaries live outside it (`/usr/local`, `/opt/claude`).
Fresh volumes inherit image ownership; migrated or foreign-owned trees
are repaired by a full-capability chown one-shot at creation time,
because the cap-dropped entrypoint cannot chown (no CAP_CHOWN).

ensureReady states: absent creates and probes the generation token;
stopped starts and requires a fresh timestamp; image or network drift
recreates. A failed startup keeps data but never reports ready and
never launches an agent.

## 5. Home model

```
/home/agent                        shared home (the volume root)
  .claude/ .codex/ .copilot/       agent state (migrated, then lived-in)
  instances/<name>/                fork and fresh homes
```

Per-instance HOME modes, recorded on the roster entry at birth:

```
shared   HOME=/home/agent. Default, including old entries without
         a recorded mode. Full continuity; do not run concurrent
         writers against the same files.
fork     Clones .claude/.codex/.copilot/.config once on first launch
         (absent paths only, caches excluded), then diverges. The fork
         name is tracked for later pruning.
fresh    Empty room. Nothing is copied, nothing is shared.
```

Secrets stay orthogonal: credential files live host-side and inject as
process environment regardless of home mode. Closing an instance drops
its roster entry and window while keeping data; `prune --forks`
removes orphan fork directories (credential files never).

## 6. Image lifecycle

```
pins (code) --> build args (NAME_VERSION, incl. CLAUDE_VERSION)
  --> docker/apple build --> inspect (4 CLI versions must match exactly)
  --> verify (entrypoint + independent ready.json)
  --> candidate tag --> activate (previous pointer saved)
  --> recreate on next start --> rollback re-activates previous
```

`image build` uses the target workspace's runtime when `--workspace`
resolves to a registered entry, else the host default. `agent upgrade`
only resolves and builds; `workspace upgrade` resolves, skips the
build when everything is current, and otherwise builds, activates,
and recreates under one confirmation.

## 7. Resolution, locks, and generations

Resolution precedence: explicit `--workspace`, nearest registered
ancestor of the cwd, git root, cwd. Unknown scopes offer guided
registration, never silent creation. Every mutation takes the
per-workspace lock. Each creation mints a fresh generation token plus
a configuration fingerprint (root, image, network, mounts); only the
entrypoint, rerun on every real start, can write a matching ready
file, so stale state can never satisfy a new generation.

## 8. Network and mounts

Per workspace: `open` (default route) or `restricted` (internal-only,
verified by probing for the absence of an external route). Switching policy
recreates the container on next start. Extra mounts are read-only
same-path binds; the workspace root itself can never be dropped.

## 9. Security boundaries

- The isolation boundary is the container, not the window: agents in
  one container share a user and can read one another's files.
- Containers never receive the host HOME, SSH credentials, or the
  Docker socket. Provider secrets are never CLI arguments and never
  baked into images.
- Containers start as the agent user with ALL capabilities dropped;
  privileged preparation (ownership repair) happens in throwaway
  one-shots outside the workload container.
- Registry files are data, never shell-sourced, never mounted in.
  Execution uses argv vectors; user input is never shell-evaluated.

## 10. Supported platforms

Developed and verified on macOS with Docker Desktop and tmux. Linux
hosts are expected to work but are not verified in CI. Windows is not
supported. Containers are always Linux.
