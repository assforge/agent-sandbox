# sandbox flows

Notation: `X --> Y: action` is a call, `X <-- Y: result` is a return.
`[confirm]` marks an interactive approval (skipped with `--yes`;
non-terminal stdin refuses). `[txn]` marks a **registry write**: it
happens inside one transaction that takes `locks/registry.lock` *before*
it reads, so the object written was loaded under the lock and a
concurrent invocation on any other workspace cannot be overwritten
(`architecture.md` §7). Every flow also resolves the workspace first, and
that is where the **restore freeze** is enforced: while a workspace
carries an unfinished `restore`, every flow below except §7's `restore`
refuses at that point, and only `status` and `doctor` report the claim
instead of refusing (`architecture.md` §7). Resolution precedence:
explicit `--workspace` wins, else the nearest registered ancestor of
the cwd, else git root or cwd as an unregistered scope. Unknown
scopes offer guided registration, never silent creation.

Scope: every command that **changes** something — the registry, a
container, a session, a volume, a host config file, or the installed CLI —
plus doctor, drawn because it is the one read-only command with a contract
worth stating. The inventory is exhaustive, so a reader can tell whether a
command is covered.

**Drawn here.** §1 bare / shell launch · §2 agent launch · §3 `workspace
start` / `stop` / `restart` · §4a `agent upgrade` · §4b `workspace
upgrade` · §4c `image build` · §5 `update` · §6 `workspace migrate` · §7
`workspace backup` / `restore` · §8 `workspace close` / `prune` · §9
`link` / `unlink` · §10 `workspace attach` / `exec` / `reopen` · §11
`doctor` · §12 `workspace configure` · §13 `workspace mount` / `unmount` ·
§14 `image activate` / `rollback` / `prune` · §15 `runtime use` / `terminal use` /
`credentials set` / `clear`.

**Read-only — `sandbox <group> help` is the reference.** `workspace list`,
`status`, `logs`; `agent list`, `outdated`; `image list`; `credentials
list`, `show`; `runtime list`; `terminal list`; `help`, `version`.

Derived from source, so the coverage claim is checkable. The counting rule:
a `case` label in one of the seven `switch` statements (the entry
dispatch in `src/bin/sandbox.ts` plus one per resource group in
`src/commands/`), with `help` excluded. That gives **55 arms**. Two of
them are labels sharing one body (`bare` and `shell`), so this counts
labels rather than distinct behaviours; `agentAdmin` is an internal
forwarder to the `agent` group rather than a command anyone types; and
`credentials list` is written as `if (action === 'list')`, so an arm-only
count misses it. Every arm is listed above.

Sections 12–15 were added on 2026-09-19 to cover flows the document had
been missing — precisely the ones that had been changing engines, mounts,
image pointers and host defaults with no written description to check
against.

## 1. First launch (`sandbox` with no arguments)

```
user --> CLI: sandbox (cwd inside /w/microsb)
CLI --> terminal: assertWindowName('shell'), before anything resolves
CLI --> registry: resolveWorkspace(cwd)
registry <-- CLI: unregistered-cwd /w/microsb
CLI --> user: [confirm] approve this workspace scope?
CLI --> registry: [txn] register (root + mounts=[root], host defaults)
CLI --> lock: acquire workspace lock (id)
CLI --> ensureReady: state=absent
ensureReady --> docker: volume create, network create
ensureReady --> docker: run -d (cap-drop ALL, mounts, env generation)
entrypoint --> entrypoint: mkdir state dirs, write ready.json(generation)
ensureReady <-- docker: ready.json matches generation (poll)
CLI --> registry: [txn] roster += shell, and read the mode back out of
                     that same transaction
CLI --> tmux: openAgentWindow('shell', bash in container)
               creates the session when it is absent, else the window
CLI <-- lock: release
CLI --> tmux: attach (needs the terminal; --no-attach skips)
```

The window name is validated against the terminal engine **before**
resolution, so an invalid name exits 2 without touching the registry or
a resource.

Registration is a registry transaction and is **not** held under the
workspace lock — it does no resource work, and holding a per-workspace
lock there would protect nothing. The workspace lock opens immediately
after, around the slow part (volume, container, readiness, session). The
roster write is a second, independent transaction, taken while that lock
is held, and the mode it returns is the one the window is launched with —
nothing here reads the pre-lock snapshot.

The roster entry is written **before** the window opens, so a crash
between the two leaves a registered instance with no window. That is the
recoverable direction: `reopen` respawns every roster window.

Later launches skip registration and reuse whatever is already up.
`sandbox claude` / `sandbox codex` do the same with an agent launch
vector instead of bash.

## 2. Agent launch (`sandbox claude --name rollout --home fork`)

```
user --> CLI: sandbox claude --name rollout --home fork
CLI --> registry: resolve
CLI --> user: refuse if the name is taken by a different agent
CLI --> lock: acquire workspace lock
CLI --> ensureReady: running container, fingerprint current
CLI --> registry: [txn] roster += {rollout, claude, homeMode=fork};
                     forks += rollout when the mode is fork
CLI --> container: mkdir -p /home/agent/instances/rollout (as agent)
CLI --> container: seed .claude/.codex/.copilot/.pi/.grok/.gemini/.qwen/.kimi-code/.local/share/mimocode/.augment/.cursor/.config/devin/.local/share/devin/.kiro/.config (absent only)
CLI --> tmux: new-window rollout (exec vector, env incl. HOME + secrets)
CLI <-- lock: release
CLI --> tmux: attach (or skip with --no-attach)
```

The roster entry is written **before** the home is prepared and the window
opens, and the name-collision check runs again inside the transaction: the
pre-lock check may be stale. The lock covers preparation only — reattach
blocks for the life of the session and must never hold it.

Relaunching the same name reuses the window and keeps its recorded
mode; `--home` only applies at birth. Shell windows work the same
with `bash` as the launch vector.

## 3. Start, stop, and restart (`workspace start` / `stop` / `restart`)

Container operations with no registry write and no pointer move.

```
start:
  user --> CLI: sandbox workspace start
  CLI --> registry: resolve (no registration prompt for known scopes)
  CLI --> lock: acquire workspace lock
  CLI --> ensureReady: create, start, or recreate as the config requires
  CLI <-- lock: release
  NOTE: needs a selected image; without one it refuses and names
  `sandbox image build`.

stop:
  user --> CLI: sandbox workspace stop
  CLI --> registry: resolve (no registration prompt for known scopes)
  CLI --> user: [confirm] N live instances will be interrupted (if any)
  CLI --> lock: acquire workspace lock
  CLI --> docker: stop container
  CLI <-- lock: release

restart:
  user --> CLI: sandbox workspace restart
  CLI --> registry: resolve (no registration prompt for known scopes)
  CLI --> user: [confirm] N live instances will be interrupted (if any)
  CLI --> lock: acquire workspace lock
  CLI --> docker: stop container
  CLI --> ensureReady: stopped -> start, fresh generation required
  CLI <-- docker: ready
  CLI <-- lock: release
  CLI --> user: workspace <id> restarted
```

Nothing is rebuilt and no pointer moves. Volumes, roster, and tmux
windows are untouched; dead panes come back through `reopen`. `stop`
leaves the container present-but-stopped, so the next start must prove a
fresh timestamp rather than a fresh creation. One exception: a stopped
container cannot be exec'd, so drift that happened while it was down is
only visible after start, when its recorded fingerprint can be read. The
first fingerprint seen that does not match recreates the container once
instead of waiting out the probes on a file that can never match.

## 4a. Agent upgrade (`sandbox agent upgrade all`)

Resolution and build only. Running sessions are never touched.

```
user --> CLI: sandbox agent upgrade all
CLI --> npm/curl: latest per engine (npm view; claude release feed)
CLI <-- user sees: minimum X, latest Y per engine (unknown -> keep minimum)
CLI --> docker: build candidate (NAME_VERSION args only for overrides)
CLI --> candidate: keyed version probe (key=$(binary --version)),
                    one line per engine, unknown lines ignored
CLI <-- candidate: versions must clear their floors, else throw
CLI --> candidate: test -x /usr/local/bin/sandbox-entrypoint.sh
CLI --> user: candidate verified + build receipt; activate explicitly with image activate
```

"Verified" on this path means the sixteen versions cleared their floors and the
entrypoint is executable — nothing more. It is the weaker of the two
build paths: `image build` (§4c) runs the same checks and then reads a
generation back out of a throwaway `ready.json`, which is what makes its
verification independent of the build's own exit status. Both paths
report the same word.

## 4b. Workspace upgrade (`sandbox workspace upgrade [agent|all]`)

Same resolution, then cutover in one confirmed step. When every
latest is already recorded on the entry the command reports current and builds nothing.

```
user --> CLI: sandbox workspace upgrade
CLI --> resolve latest (as in 4a)
nothing resolvable at all --> CLI --> user: could not resolve latest versions; nothing built
every latest == recorded, all recorded --> CLI --> user: nothing to build, exit 0
CLI --> user: [confirm] rebuild agents and recreate? (if instances live)
CLI --> lock: acquire
CLI --> docker: build + inspect + verify (as in 4a)
CLI --> registry: [txn] activate (previous pointer saved, versions recorded)
CLI --> docker: stop, remove on image drift, create, probe ready
CLI --> user: workspace <id> upgraded to <tag> + build receipt
```

The pointer moves **before** the slow work, deliberately: it is the
recorded intent. A crash between the two leaves registry = new image /
container = old image, and the recreation condition on the image id makes
the next start self-healing — no extra state, no recovery prompt.

## 4c. Image build (`sandbox image build`)

Builds with the target workspace's runtime when `--workspace`
resolves to a registered entry, else the host default (runtimes keep
separate image stores, so building for the wrong runtime produces an
image the workspace cannot see). Verification runs through the same
runtime seam, never hardcoded docker.

This is the stronger of the two build paths. After the version and
entrypoint checks it makes a throwaway run and reads the generation back
out of the `ready.json` that run wrote, comparing it to the generation it
passed in — so a candidate that builds and starts but never signals is
caught here and not by `agent upgrade` (§4a), which stops at the
entrypoint.

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
user --> CLI: workspace migrate --source claude-relay [--apply]
CLI --> runtime+terminal: list containers, volumes, sessions
CLI <-- inventory: everything the host has
CLI --> CLI: map only the known legacy names; ignore everything else
             containers  claude-relay-agents, pedantic_snyder
             volumes     claude-relay-{config,m2,pub,codex,xdg}
             state       config, codex, xdg -- only these copy data
CLI --> user: dry-run mapping list, originals retained
CLI <-- CLI: without --apply, stop here and exit 0
user --> CLI: workspace migrate --source claude-relay --apply
CLI --> user: [confirm] copy approved agent state and interrupt writers?
CLI --> lock: acquire
CLI --> one-shot: mount the source ro at /from and the destination at
                   /to, then alpine sh -c 'cp -a /from/. /to/'
CLI --> user: copied N state volumes; originals retained for recovery
```

The dry run is not a mode: the mapping is always printed, and `--apply`
is what continues past it.

Only the three state volumes are copied. Containers and sessions are
listed in the mapping and then **skipped** — the copy loop takes
`kind === 'volume' && copiesState` and nothing else — so the output can
name a container that was never touched. The copy is a volume-to-volume
copy in a throwaway `alpine` container, not `docker cp`: it mounts the
source read-only and runs `cp -a /from/. /to/`, so the volume root's
contents land flat in `sandbox-home-<id>`. Nothing is moved out of the
legacy resources and nothing is deleted — they stay for recovery, and
pruning them is a manual act.

## 7. Backup and restore

```
backup:
  user --> CLI: workspace backup --output <dir>
  CLI --> lock: acquire workspace lock
  CLI --> dir: write workspace.json (redacted entry: roster+modes+forks)
  CLI --> docker: cp container:/home/agent/. host:<dir>/home
  CLI --> user: written to <dir>
  NOTE: no confirmation, and no readiness step. The state is read
  THROUGH the container, so a workspace whose container is absent
  fails on the copy instead of producing an empty snapshot.
  NOTE: the registry is NOT written. A backup changes nothing in use.

restore:
  user --> CLI: workspace restore --input <dir>
  CLI --> dir: refuse unless the manifest id equals this workspace's id;
               a foreign backup is refused, never adopted
  CLI --> user: [confirm] running state will be overwritten
  CLI --> lock: acquire workspace lock
  CLI --> registry: [txn 1] refuse any manifest root or mount the guard
                    would refuse at registration, then reinstate the entry
                    WHOLESALE from the backup and record
                    pendingOperation = {restore, source, pid};
                    a bad backup fails before any claim is written
  CLI --> docker: cp host:<dir>/home/. container:/home/agent   (slow half,
                  deliberately outside the transaction)
  CLI --> registry: [txn 2] clear pendingOperation
  CLI --> user: restart the workspace to cut over

  death between txn 1 and txn 2 leaves the claim in place; every other
  command then refuses at resolution until the re-run completes
```

Both copies carry a trailing `/.` — `cp -a`-style semantics that copy the
*directory's contents*. Without it the destination directory already
exists, so the runtime nests the source inside it and a restore would
reproduce `/home/agent/home/agent/...`.

`restore` resolves with the freeze lifted — it is exempt from the claim it
is about to write, and from one left by a crashed predecessor, because it
is the command that clears it. The manifest-id check runs before the
confirmation and before the lock, so a backup belonging to another
workspace is refused without a prompt and without touching anything.

`restore` replaces the entry **whole**, not field by field: the workspace
becomes whatever the backup recorded — roster, modes, forks, mounts,
network, and engine choice included. A change made between the backup and
the restore is therefore discarded, which is why the restore window is a
period to keep short. The prompt says only "running state will be
overwritten", which is narrower than what the command does.

The claim exists for **death**, not for concurrency. A live restore is
serialised by the workspace lock, so a concurrent command waits and then
finds a complete home; a crashed one releases that lock through the
pid-liveness reclaim and would otherwise leave a half-copied home with
nothing to report it. Hence the freeze: every other flow in this document
refuses while a claim is outstanding, and the message names the backup to
re-run from. `restore` itself is exempt because it is what clears the
claim, and `status` and `doctor` are exempt because they only report it —
`status` prints `restore-interrupted` for a dead holder or `restore in
progress (pid N)` for a live one, and `doctor` raises `workspace-restore`
as a WARN. Read-only commands that still resolve a workspace (`logs`) are
frozen with everything else, since the rule is applied at one choke point
rather than by classifying commands. Nothing clears a claim automatically.

## 8. Close and prune

```
close (per instance):
  user --> CLI: workspace close rollout
  CLI --> registry: resolve; an unknown instance is exit 1
  CLI --> tmux: does the window exist?
  existed --> CLI --> user: [confirm] window goes away; data kept
  CLI --> lock: acquire workspace lock
  CLI --> registry: re-read the entry under the lock (authoritative)
  absent at the probe but live now --> refuse; re-run the command
  CLI --> tmux: kill-window sandbox-<id>:rollout (absent is the
               already-closed case, not an error)
  CLI --> registry: [txn] drop the roster entry
  CLI --> user: prune forks with: workspace prune --forks

prune (containers):
  user --> CLI: workspace prune [--all]
  CLI --> registry: this workspace, or every registered one with --all
  CLI --> runtime: which of them are in state `stopped`?
                   a running container is left alone, and so is a
                   foreign or absent one
  none stopped --> CLI --> user: nothing to prune, exit 0
  CLI --> user: [confirm] remove N? volumes/networks/images kept
  per container: acquire its lock, re-check the claim, then remove it
  CLI --> user: registry untouched (next start recreates)

prune --forks (orphan state):
  user --> CLI: workspace prune --forks
  CLI --> registry: forks minus roster names
  CLI --> user: [confirm] remove N forks? credential files kept
  per fork:
    CLI --> lock: acquire workspace lock
    CLI --> registry: re-check it is still orphaned; skip if it went live
    CLI --> one-shot: mount home volume at /v, rm -rf -- /v/instances/<fork>
    CLI --> registry: [txn] drop the fork name
```

The close race guard fires in one direction only: a window that was
**absent** when the probe ran — so no prompt was shown — and is live by
the time the lock is held. If the window existed and the prompt was
accepted, nothing re-checks it; the window is closed.

The delete comes **before** the claim, deliberately: `rm -rf` exits 0 on
an absent path, so a crash between the two is repaired by re-running.
Claiming first would leave a name recorded while its state was still on
the volume, which nothing would ever prune again.

## 9. Link and unlink

```
link:
  user --> CLI: sandbox link [path]  (defaults to cwd)
  CLI --> registry: [txn] register root (idempotent: an existing entry
                    is returned rather than duplicated)
  CLI --> user: registered <id>
  NOTE: no workspace lock. Registering does no resource work, so a
  per-workspace lock here would serialise nothing.

unlink:
  user --> CLI: sandbox unlink [path]
  CLI --> registry: refuse an unregistered root, and refuse a restore
                    claim (both before any prompt is shown)
  CLI --> live check: running container, live session, or a non-empty
                     roster
  CLI --> user: [confirm] if anything is live
  CLI --> lock: acquire workspace lock
  CLI --> registry: re-check the claim under the lock, before any
                    resource change
  CLI --> runtime+terminal: stop the container, remove it, kill the
                           session
  CLI --> registry: [txn] forget the mapping (volumes, networks, images,
                    and credentials are always kept)
```

`workspace link` / `workspace unlink` are the same two operations under
the group. `workspace register` and `workspace unregister` are
long-standing aliases: they resolve to `link` and `unlink` before
dispatch, so they are the same commands under an older name — not
retired, and not an error.

## 10. Attach, exec, and reopen after a reboot

```
attach:
  user --> CLI: sandbox workspace attach (or top-level agent launch)
  CLI --> tmux: session alive? no -> refuse and name `workspace start`
  CLI --> runtime: container running? no -> WARN on stderr; the attach
                   still happens and the windows are dead
  CLI --> tmux: attach (inherited stdio; --no-attach skips)
  NOTE: attach needs the user's terminal. Piped stdio fails with
  "not a terminal" by tmux design; the window itself is always fine.

exec:
  user --> CLI: sandbox workspace exec [--] <argv...>
  CLI --> lock: acquire workspace lock
  CLI --> ensureReady: container up and current
  CLI --> docker: exec argv in the container, workdir = workspace root,
                  tty when stdin is a tty, and no env injected
  CLI <-- docker: the command's own stdout, stderr, and exit status
  CLI <-- lock: release
  NOTE: `--` is optional -- everything after it, or everything left, is
  the argv vector. It is never a shell string.
  NOTE: exec injects no environment. It runs with the container's
  defaults (HOME=/home/agent) and no credentials, and it is not scoped
  to an instance, so it cannot reproduce what a window sees.

reopen (post-reboot recovery):
  user --> CLI: sandbox workspace reopen
  CLI --> lock: acquire workspace lock
  CLI --> ensureReady: recreate the container (old one is gone)
  CLI --> registry: roster is the source of truth (read only)
  empty roster --> CLI --> tmux: open one `shell` window and say so
  per roster entry: skip an unknown agent kind with a message, then
                    respawn its window in place
  CLI <-- lock: release
  CLI --> user: N windows back (dead panes respawned, not duplicated)
  CLI --> tmux: attach (or skip with --no-attach)
```

`exec` runs arbitrary argv as the agent user, which is why it holds the
workspace lock across the call: a concurrent recreate would otherwise
pull the container out from under it. Its exit code is the command's —
and it is not the only command that passes a status through: `logs`
returns the runtime's own status too, so a failing `docker logs` is a
failing `sandbox workspace logs`. What is unique to `exec` is that it
runs an argv the caller chose.

## 11. Doctor

Read-only. Never installs, never mutates, exit 1 only on FAIL. Check ids
are stable and appear verbatim in `doctor --json`:

```
id                    group              status
--------------------  -----------------  --------------------------------
node                  Toolchain          FAIL below major 20
runtime-cli           Container runtime  FAIL when the CLI is off PATH
container-runtime     Container runtime  FAIL when the daemon is down
runtime-maturity      Container runtime  WARN while the engine is
                                         experimental
terminal              Terminal           FAIL when missing (+ hint)
home-dir              Host               WARN while ~/.sandbox has not
                                         moved; read-only, it reports
                                         the pending move rather than
                                         performing it
workspace-image       Workspace          WARN when none is selected
workspace-restore     Workspace          WARN while an unfinished restore
                                         leaves the home indeterminate;
                                         names the backup to re-run from
workspace-network     Workspace          FAIL missing; otherwise reads the
                                         LIVE network, not the policy
workspace-windows     Workspace          WARN per dead roster window
agent-drift-<agent>   Workspace          WARN when the running binary
                                         disagrees with the image recording
                                         (or the catalog floor without one)
workspace-hooks       Workspace          WARN per project hook/MCP command
                                         missing in the container (exec
                                         probe of command -v, no network)
```

`workspace-network` is the check worth reading closely: it is the only
one whose answer must be a **measurement**, because the registry field it
used to read is a record of intent.

The table is the full set of ids, not the set in any one run.
`home-dir` appears only while the legacy move is pending;
`workspace-restore` only while a claim is outstanding; and everything
from `workspace-network` down is skipped when no workspace is in scope,
so a bare `sandbox doctor` reports the host checks alone.

```
network absent ....................... FAIL; start the workspace
live flag unreadable ................. WARN "cannot determine" — never
                                       claims an isolation it did not see
live flag internal ................... OK; no external route
policy restricted, live route open ... WARN; the switch has not been
                                       applied, and it flips on next start
otherwise ............................ WARN; egress is unrestricted
```

A workspace switched to `restricted` before its next start is still open,
and doctor says so instead of reporting it isolated.

`workspace-restore` is deliberately a WARN and not a FAIL, so a frozen
workspace still exits 0: the workspace is blocked, but nothing about the
host is broken, and `doctor` is one of the two commands a claim does not
freeze.

## 12. Configure (`sandbox workspace configure`)

The only command that changes what the container *is*. Bare
`configure` prints the redacted entry and exits — it is the read form.

```
user --> CLI: workspace configure [--add-mount P] [--drop-mount P]
                                  [--network open|restricted]
                                  [--runtime NAME] [--terminal NAME]
CLI --> registry: resolve + ensure
no options given --> CLI --> user: redacted entry as JSON, exit 0
CLI --> user: one plan line per change
CLI --> user: [confirm] apply these changes?
CLI --> docker: retire the PREVIOUS engine's resources (see below)
CLI --> registry: [txn] re-resolve, apply mounts/network/runtime/terminal
```

A plan line is printed only for an actual change, but the confirmation
covers the whole invocation: passing a flag whose value already holds
prints nothing, still prompts, and the transaction then rewrites the same
value. Which form runs is decided by whether any flag was passed at all,
not by whether any of them changes anything.

Retirement runs **before** the transaction, so a failed retirement cannot
record a switch that never happened:

```
runtime switch   containerState -> stopContainer (if running)
                 -> removeContainer (if running or stopped)
                 -> killSession (if alive)
terminal switch  killSession (if alive)
```

A runtime switch kills the session **even when the terminal engine does
not change**: the window's launch vector embeds the old runtime's binary,
so the windows are invalid either way. Nothing is migrated — the plan
line says so, and the container and windows are recreated on next start.

## 13. Mounts (`workspace mount` / `unmount`, `configure --add-mount`)

```
mount <path>:
  CLI --> registry: resolve + ensure
  CLI --> path: canonicalise, refuse a forbidden path (HOME, /, ...)
  already present --> CLI --> user: "already present", exit 0
  CLI --> user: [confirm] add mount <path>? Applies on next start.
  CLI --> registry: [txn] re-resolve, push the canonical path

unmount <path>:
  CLI --> registry: resolve + ensure
  CLI --> path: refuse the workspace root (validated on the phase-1
                snapshot; the authoritative drop is the transaction)
  CLI --> user: [confirm] drop mount <path>? Applies on next start.
  CLI --> registry: [txn] re-resolve, filter the path out
```

Extra mounts are read-only same-path binds and the workspace root can
never be dropped. Because `mounts` feeds the configuration fingerprint, a
mount change makes the next start **recreate** the container rather than
leave one whose recorded environment the readiness loop could never
match.

## 14. Image pointer (`image build` / `activate` / `rollback` / `prune`)

```
build:
  CLI --> runtime: build candidate (target workspace's runtime when
                   --workspace resolves, else the host default)
  CLI --> candidate: inspect 16 CLI versions (must clear their floors)
  CLI --> candidate: entrypoint + independent ready.json check
  CLI --> user: candidate verified; activate explicitly
  NOTE: no registry write. A build changes nothing that is in use.

activate <digest>:
  CLI --> runtime: image must exist locally
  CLI --> user: [confirm] if any instance is live
  CLI --> lock: acquire workspace lock
  CLI --> registry: [txn] activate (previous pointer saved)
  CLI <-- lock: release
  NOTE: does not touch the running container. The recreate happens on
  next start, when ensureReady compares the container's image id.

rollback:
  CLI --> user: [confirm] if any instance is live
  CLI --> lock: acquire workspace lock
  CLI --> registry: [txn] swap the current and previous pointers;
                    refuses when no previous tag was recorded
  CLI <-- lock: release
  CLI --> user: rolled back to <tag>; data migrations are not reversed
  NOTE: unlike `activate`, it does not check that the tag exists
  locally. It only swaps pointers, so a previous tag that has been
  removed from the image store is still recorded -- and then fails at
  the next start, when ensureReady asks the runtime for its id.

prune:
  CLI --> runtimes: list sandbox-workspace images on every runtime in use
  CLI --> registry: keep current + previous of every workspace
  CLI --> user: [confirm] remove the unreferenced remainder
  CLI --> runtime: rmi each; first failure aborts with exit 1
  NOTE: no registry write. A pruned previous tag stays recorded (see
  the rollback NOTE above).
```

`workspace upgrade` (§4b) is the one command that does activate **and**
recreate under a single confirmation; `image activate` deliberately does
not, so the two can be reasoned about separately.

## 15. Host defaults and credentials

The two writers that touch neither the registry nor a container.

```
runtime use <name> / terminal use <name>:
  CLI --> host: load ~/.agent.sandbox/config.json
  CLI --> host: write it back with that one field changed
  CLI --> user: "selected <engine> for new workspaces"
  NOTE: applies to NEW workspaces only. An existing workspace keeps the
  engine recorded on its own entry -- change that with configure (§12).

credentials set --instance <n> --file <path>:
  CLI --> user: [confirm] only if that instance already has credentials
  CLI --> host: write ~/.agent.sandbox/<id>/instances/<n>.env
                (directory 0700, file 0600)
  CLI --> user: "stored N keys"; values are never printed or logged

credentials clear --instance <n>:
  CLI --> host: remove that file; reports whether one was there
```

Credentials are orthogonal to HOME mode: the file lives host-side and is
injected as process environment at launch. Closing an instance keeps it,
and `prune --forks` never touches it.

**Known limitation, recorded and not fixed.** `config.json` holds exactly
two fields, written by two different commands, each preserving the other
from its own load, with **no lock**. Concurrent `runtime use` and
`terminal use` runs can therefore lose one selection — the same
read-modify-write shape as the registry, on a much smaller file with no
slow work between the read and the write. It has not been reviewed as a
finding and no fix is applied here; it is recorded so the next reader does
not have to rediscover it.
