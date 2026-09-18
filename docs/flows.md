# sandbox flows

Notation: `X --> Y: action` is a call, `X <-- Y: result` is a return.
`[confirm]` marks an interactive approval (skipped with `--yes`;
non-terminal stdin refuses). Every flow resolves the workspace first:
explicit `--workspace` wins, else the nearest registered ancestor of
the cwd, else git root or cwd as an unregistered scope. Unknown
scopes offer guided registration, never silent creation.

## 1. First launch (`sandbox` with no arguments)

```
user --> CLI: sandbox (cwd inside /w/microsb)
CLI --> registry: resolveWorkspace(cwd)
registry <-- CLI: unregistered-cwd /w/microsb
CLI --> user: [confirm] approve this workspace scope?
CLI --> registry: register (root + mounts=[root], host defaults)
CLI --> lock: acquire(microsb-xxx)
CLI --> ensureReady: state=absent
ensureReady --> docker: volume create, network create
ensureReady --> docker: run -d (cap-drop ALL, mounts, env generation)
entrypoint --> entrypoint: mkdir state dirs, write ready.json(generation)
ensureReady <-- docker: ready.json matches generation (poll)
CLI --> tmux: new-session sandbox-xxx, window shell (bash in container)
CLI --> registry: roster += shell, save
CLI <-- lock: release
CLI --> tmux: attach (needs the terminal; --no-attach skips)
```

Later launches skip registration and reuse whatever is already up.
`sandbox claude` / `sandbox codex` do the same with an agent launch
vector instead of bash.

## 2. Agent launch (`sandbox claude --name rollout --home fork`)

```
user --> CLI: sandbox claude --name rollout --home fork
CLI --> registry: resolve + lock
CLI --> ensureReady: running container, fingerprint current
CLI --> registry: roster += {rollout, claude, homeMode=fork}, save
CLI --> container: mkdir -p /home/agent/instances/rollout (as agent)
CLI --> container: seed .claude/.codex/.copilot/.config (absent only)
CLI --> tmux: new-window rollout (docker exec, env incl. HOME + secrets)
CLI --> tmux: attach (or skip with --no-attach)
```

Relaunching the same name reuses the window and keeps its recorded
mode; `--home` only applies at birth. Shell windows work the same
with `bash` as the launch vector.

## 3. Restart (`sandbox workspace restart`)

```
user --> CLI: sandbox workspace restart
CLI --> registry: resolve (no registration prompt for known scopes)
CLI --> user: [confirm] N live instances will be interrupted (if any)
CLI --> lock: acquire
CLI --> docker: stop container
CLI --> ensureReady: stopped -> start, fresh generation required
CLI <-- docker: ready
CLI --> user: workspace <id> restarted
```

Nothing is rebuilt and no pointer moves. Volumes, roster, and tmux
windows are untouched; dead panes come back through `reopen`.

## 4a. Agent upgrade (`sandbox agent upgrade all`)

Resolution and build only. Running sessions are never touched.

```
user --> CLI: sandbox agent upgrade all
CLI --> npm/curl: latest per engine (npm view; claude release feed)
CLI <-- user sees: pinned X, latest Y per engine (unknown -> keep pinned)
CLI --> docker: build candidate (NAME_VERSION args, incl. CLAUDE_VERSION)
CLI --> candidate: sh -c 'claude --version; opencode --version; ...'
CLI <-- candidate: versions must equal overrides exactly, else throw
CLI --> candidate: test -x entrypoint (independent verification)
CLI --> user: candidate verified; activate explicitly with image activate
```

## 4b. Workspace upgrade (`sandbox workspace upgrade [agent|all]`)

Same resolution, then cutover in one confirmed step. When every
latest equals its pin the command reports current and builds nothing.

```
user --> CLI: sandbox workspace upgrade
CLI --> resolve latest (as in 4a)
CLI --> user: [confirm] rebuild agents and recreate? (if instances live)
CLI --> lock: acquire
CLI --> docker: build + inspect + verify (as in 4a)
CLI --> registry: activate (previous pointer saved), save
CLI --> docker: stop, remove on image drift, create, probe ready
CLI --> user: workspace <id> upgraded to <tag>
```

## 4c. Image build (`sandbox image build`)

Builds with the target workspace's runtime when `--workspace`
resolves to a registered entry, else the host default (runtimes keep
separate image stores, so building for the wrong runtime produces an
image the workspace cannot see). Verification runs through the same
runtime seam, never hardcoded docker.

## 5. Self update (`sandbox update [--check]`)

```
user --> CLI: sandbox update
CLI --> npm: view @assforge/cogent-sandbox version
CLI <-- npm: latest
latest == current --> user: already current, exit 0
latest != current --> npm: install -g @assforge/cogent-sandbox@latest
CLI --> user: updated A -> B; run workspace upgrade to rebuild images
```

Uses the user's own npm authentication; 401/403 surfaces with a
pointer at registry auth. `--check` prints `current X, latest Y` and
changes nothing. Running workspaces are untouched: the new binary
takes effect on the next command, new templates on the next upgrade.

## 6. Migrate (`sandbox workspace migrate --source claude-relay [--apply]`)

```
user --> CLI: migrate (dry-run by default)
CLI --> docker+tmux: inventory containers, volumes, sessions
CLI <-- inventory: claude-relay-agents, claude-relay-{config,codex,...}
CLI --> user: dry-run mapping list, originals retained
user --> CLI: migrate --source claude-relay --apply
CLI --> user: [confirm] copy state and interrupt writers?
CLI --> lock: acquire
CLI --> docker: cp -a each state volume into sandbox-home-<id>
CLI --> user: copied N volumes; originals retained for recovery
```

Legacy home state lands flat at the volume root; agent-shaped
directories are relocated under `~/.claude` afterwards (one-time
surgery, documented in the task evidence log). Afterwards the source
container and volumes can be pruned by hand.

## 7. Backup and restore

```
backup:
  user --> CLI: workspace backup --output <dir>
  CLI --> lock: acquire
  CLI --> registry: write workspace.json (redacted, roster+modes+forks)
  CLI --> docker: cp container:/home/agent host:<dir>/home
  CLI --> user: written to <dir>

restore:
  user --> CLI: workspace restore --input <dir>
  CLI --> dir: refuse unless manifest id matches a known-or-new entry;
               foreign backups are refused, never adopted
  CLI --> registry: reinstate entry WITH roster, modes, and forks
  CLI --> docker: cp host:<dir>/home container:/home/agent
  CLI --> user: reopen recreates the windows
```

## 8. Close and prune

```
close (per instance):
  user --> CLI: workspace close rollout
  CLI --> user: [confirm] window goes away; data kept?
  CLI --> tmux: kill-window sandbox-<id>:rollout (missing is fine)
  CLI --> registry: drop roster entry, save
  CLI --> user: prune forks with: workspace prune --forks

prune (containers):
  user --> CLI: workspace prune [--all]
  CLI --> docker: stopped managed containers (this workspace, or all)
  CLI --> user: [confirm] remove N? volumes/networks/images kept
  CLI --> docker: rm each; registry untouched (next start recreates)

prune --forks (orphan state):
  user --> CLI: workspace prune --forks
  CLI --> registry: forks minus roster names
  CLI --> user: [confirm] remove N forks? credential files kept
  CLI --> one-shot: mount home volume at /v, rm -rf /v/instances/<fork>
  CLI --> registry: drop fork names, save
```

## 9. Link and unlink

```
link:
  user --> CLI: sandbox link [path]  (defaults to cwd)
  CLI --> registry: link root (+ alias: workspace link/register)
  CLI --> user: registered <id>

unlink:
  user --> CLI: sandbox unlink [path]
  CLI --> live check: running container, live session, or roster
  CLI --> user: [confirm] if anything is live
  CLI --> docker+tmux: stop container, remove shell, kill session
  CLI --> registry: forget mapping (volumes, networks, images,
                     credentials always kept)
```

## 10. Attach and reopen after a reboot

```
attach:
  user --> CLI: sandbox workspace attach (or top-level agent launch)
  CLI --> tmux: session alive? container running?
  CLI --> tmux: attach (inherited stdio; --no-attach skips)
  NOTE: attach needs the user's terminal. Piped stdio fails with
  "not a terminal" by tmux design; the window itself is always fine.

reopen (post-reboot recovery):
  user --> CLI: sandbox workspace reopen
  CLI --> ensureReady: recreate the container (old one is gone)
  CLI --> registry: roster is the source of truth
  CLI --> tmux: new session; respawn each roster window in place
  CLI --> user: N windows back (dead panes respawned, not duplicated)
```

## 11. Doctor

Read-only. Never installs, never mutates, exit 1 only on FAIL.

```
node >= 20 ............ FAIL otherwise (node provider)
runtime CLI + daemon .. FAIL when missing/down
runtime maturity ...... WARN while the engine is experimental
terminal .............. FAIL when missing (+ install hint)
image selected ........ WARN when none
network ............... FAIL when missing, WARN when open
dead windows .......... WARN with reopen remediation
agent drift ........... WARN per agent whose running binary differs
                        from its pin (local exec probe, no network),
                        remediation: workspace upgrade
```
