# sandbox architecture

Sandboxed multi-agent workbench. One workspace owns one managed
container and one host tmux session; each agent instance owns a window
whose process runs inside that workspace's container.

```
                                HOST
  +----------------------------------------------------------------+
  |  sandbox CLI   node, @assforge/cogent-sandbox                  |
  |                                                                |
  |  host state   ~/.agent.sandbox/                                |
  |    +-- registry.json          every workspace, written whole   |
  |    +-- config.json            host defaults: runtime, terminal |
  |    +-- locks/registry.lock    guards the registry write        |
  |    +-- locks/<id>.lock        one workspace's slow work        |
  |    +-- <id>/instances/*.env   secrets, owner-only perms        |
  |    +-- engines/*.json         user-supplied agent catalogs     |
  |                                                                |
  |  terminal engine   tmux (default) or herder                    |
  |    +-- session sandbox-<id>                                    |
  |          +-- window <instance>   docker exec into the container|
  |          +-- window <instance>   one window per roster entry   |
  +----------------------------------------------------------------+
          |
          |  docker exec / logs / cp, volume and network calls
          v
  +----------------------------------------------------------------+
  |  container   sandbox-<id>                                      |
  |    label sandbox.runtime=<engine>   cap-drop ALL   uid 1001    |
  |                                                                |
  |    /Users/.../microsb             same-path bind, read-write   |
  |    /home/agent                    home volume sandbox-home-<id>|
  |    /home/agent/instances/<n>      fork and fresh homes         |
  |    /tmp/sandbox-ready/ready.json  readiness token              |
  |                                                                |
  |    network sandbox-net-<id>       open | restricted            |
  +----------------------------------------------------------------+
```

## 1. Resource ownership

```
workspace  one registry entry, and these are its fields
  id                first 12 hex of sha256(canonical root)
  root              canonical absolute path
  container         sandbox-<id>          (one, recreated on drift)
  session           sandbox-<id>          (one, survives restarts)
  homeVolume        sandbox-home-<id>     (agent state, survives all)
  network           open | restricted
  image             current tag, or null before the first build
  previousImage     rollback target, or null
  mounts            workspace root + extra read-only binds
  runtime           container engine that owns this workspace
  terminal          terminal engine that owns this workspace
  instances         roster [{name, kind, window, homeMode?}]
  forks             fork names with state under instances/
  pendingOperation  {kind, source, startedAt, pid}, only while a
                    restore is unfinished (see §7)
```

Three of those fields are not stored at all: `container`, `session`, and
`homeVolume` are derived from the id — `sandbox-<id>`, `sandbox-<id>`,
`sandbox-home-<id>` — and the network name `sandbox-net-<id>` the same
way. The id is the first 12 hex characters of the sha256 of the canonical
root, so nothing needs to be remembered beyond the registry file. What
those resources have in common is that they outlive the container: the
container is recreated on drift, the session survives a container
restart, and the home volume survives everything.

`runtime` and `terminal` are recorded per workspace, not per host: a
container labelled with a different runtime is **cut over** — removed and
recreated by the runtime that now owns the workspace — while a container
name owned by anything that is not a labelled sandbox container is
refused without mutation. A window's launch vector embeds the runtime
binary, so switching either engine retires the previous one's resources
(see §3).

There is deliberately no purge command: `unlink` forgets the mapping;
volumes, networks, images, and credentials are always kept.

## 2. Host state layout

```
~/.agent.sandbox/
  registry.json            all workspaces (atomic rewrites)
  config.json              host defaults: runtime, terminal
  locks/registry.lock      mutex for the registry file's read-modify-write
  locks/<id>.lock          per-workspace mutex for resource work
  <id>/instances/<n>.env   KEY=VALUE secrets, owner-only permissions
  engines/*.json           user-supplied agent catalogs (optional)
```

`locks/` is a directory, and both lock files live in it. They are not
interchangeable — see §7 for which state each one protects.

First run after upgrade moves a legacy `~/.sandbox` tree here exactly
once and says so on stderr. It never merges: if the new directory
already exists, the old one is left untouched.

## 3. Engine seams (D8)

Core logic depends on interfaces; vendor specifics live in engine
modules. Adding an agent, terminal, or runtime means adding data plus
one implementation, never touching orchestration.

The three families are not chosen at the same scope. `runtime` and
`terminal` are recorded on the workspace entry at registration, so a
switch is a per-workspace act. The agent is not an engine the workspace
selects at all: the roster records an instance by agent *name*, and the
engine is looked up by that name at launch.

```
family     selected by                         recorded
---------  ----------------------------------  -----------------------------
agent      the instance's name                 per instance, in the roster
terminal   entry.terminal ?? config.json       per workspace, at registration
runtime    entry.runtime  ?? config.json       per workspace, at registration
```

**AgentEngine — which agent runs in a window**

```
AgentEngine     name, statePaths, launch, installSpec(), latestVersion()
  installSpec   { channel: npm|native, npmPackage, minimumVersion }
  statePaths    home-relative dirs this agent owns (fork seeds, see §5)
  launch        argv vector, never a shell string

built-in catalog — eleven entries, held as data. Versions are floors, not
pins: the image installs whatever the channels currently serve
(latest-first), and the build gate demands every binary report at or
above its floor. The resolved set is printed as the build receipt and
recorded on the registry entry at activation, which is what doctor
compares the running container against.
  claude    native  minimum 2.1.276       .claude
            latest read from the vendor release feed
            https://downloads.claude.ai/claude-code-releases/latest
  opencode  npm     opencode-ai>=1.18.31   .config/opencode
  codex     npm     @openai/codex>=0.155.1 .codex
  copilot   npm     @github/copilot>=1.0.86
                                          .copilot, .config/github-copilot
  pi        npm     @earendil-works/pi-coding-agent>=0.85.1
                                          .pi/agent
  grok      native  script>=1.0.34, latest read from
            https://x.ai/cli/stable      .grok
  agy       native  script, latest-only, no version selection
                                          .gemini
  qwen      npm     @qwen-code/qwen-code>=0.24.1
                                          .qwen
  kimi      npm     @moonshot-ai/kimi-code>=2.0.2
                                          .kimi
  mimo      npm     @mimo-ai/cli>=0.1.14  .mimo
  auggie    npm     @augmentcode/auggie>=0.36.0
                                          .auggie

  grok, agy  supported since 0.26.0; kiro stays out (latest-only
             script plus social-login-only auth does not fit containers)

```

`claude` was the first native channel; grok and agy joined it. A native

`claude` was the first native channel — the vendor installer under
`/opt/claude` — and it carries a floor like any other agent. A native
engine reads its `latestEndpoint` for the latest release and returns
null rather than guessing when the feed is unreadable or malformed; npm
engines ask the registry instead. `agent outdated` is that call for
every engine, and an engine that cannot answer reports `(unknown)`
rather than a stale number.

User catalogs are data too: `~/.agent.sandbox/engines/*.json`, read in
filename order, and an invalid file fails closed naming its path.
Built-ins win a name conflict, so no catalog can redefine `claude`.

Names with no verified install channel are refused in **two** places on
purpose — at catalog load as well as at lookup. A catalog that declares
one registers it under its own name, so the lookup would *succeed* and
the lookup guard would never run; the load-boundary check is what closes
that path. The list is empty today; the guard stays for future names.

**TerminalEngine — where windows live**

```
tmux     default. sessions, windows, panes, attach, close
herder   herdr 0.9.x: one herder workspace per session, labelled with
         the sandbox id; one tab per instance, labelled with the
         instance name; launch runs through pane run
```

The herder mapping is shaped by two behaviours verified live against
herdr 0.9.0, and both are why this interface is not a rename of tmux's:

- Errors arrive as JSON with **exit code 0**, so every call inspects the
  payload and never the exit status alone.
- Dead panes vanish with their tabs — there are no corpses. A missing
  window *is* the dead signal, so respawn is the same operation as
  create.

`openAgentWindow` reports which of the three things happened — `reused`,
`respawned`, or `created` — so a caller states what occurred instead of
assuming it launched something.

**RuntimeEngine — where containers live**

```
           name     verified  doctor probe             display
docker     docker   yes       docker info              Docker
apple      apple    yes       container system status  Apple Container
```

`verified` is not a synonym for working. It marks a runtime whose **full
live lifecycle** has been exercised — container, image, volume, network,
and a same-path bind — and `apple` carries it because that run happened.
A runtime without it is not refused: `doctor` raises a
`runtime-maturity` WARN and `runtime list` appends `[experimental]`, so
an unverified runtime is visible rather than blocked.

Capabilities are declared per runtime, and there are four of them:

```
labels   internalNetworks   capDrop   vectorExec
```

Both shipped runtimes declare all four true, and **only
`internalNetworks` is read**. `requireCapabilities` consults that one
flag and nothing else, and it is called with
`entry.network === 'restricted'` — so the enforced contract today is
exactly "a runtime that cannot make an internal network cannot host a
restricted workspace". The other three are declarations of what the
container mapping assumes, not gates; a future runtime missing `capDrop`
would not be stopped by this code. Recorded here so the four-flag set is
not mistaken for four enforced checks.

**Switching an engine is a cutover, not a relabel**

A switch moves no data — the home volume is not runtime-specific and is
untouched — but it invalidates what the previous engine made.

```
workspace configure --runtime <r> --terminal <t>

  1  validate each name against RUNTIME_ENGINES / TERMINAL_ENGINES
     with no flags at all: print the redacted entry and exit 0
  2  print one plan line per actual change
       runtime  -> stops and removes the old container, kills session
       terminal -> kills the old session
     then a single confirmation covers the whole set
  3  retire the previous engine's resources
       runtime changed    stop the container if running, then remove it
       either changed     kill the session
  4  [txn] write the new names into the entry
```

The retirement is step 3 and the record is step 4, **in that order**: a
failed retirement must not record a switch that never happened.

A runtime switch kills the session even when the terminal engine is
unchanged, because a window's launch vector embeds the old runtime's
binary — that window would be pointing at a CLI which no longer owns the
container. "Either changed" is therefore not a convenience: both changes
invalidate the windows, so one rule covers both.

The container is not recreated here; the next start does that. Nor is
this retirement the only thing that handles a stale container:
`ensureReady` treats a container owned by *another* runtime as a cutover
— it removes and recreates it — while a name owned by anything that is
not a labelled sandbox container is refused without mutation. The
retirement above is what makes the switch deterministic, not the last
line of defence.

## 4. Container anatomy

```
image (built from templates/Dockerfile, no secrets)
  base                     node:22-bookworm-slim
  apt                      git, ca-certificates, openssh-client, curl
  npm globals (latest)   opencode-ai, @openai/codex, @github/copilot,
                             @earendil-works/pi-coding-agent
                             (NAME_VERSION build args pin one only as an
                             override: upgrade flows, emergencies)
  /opt/claude              claude via the vendor installer (latest unless
                           CLAUDE_VERSION overrides), agent-owned;
                           PATH gains /opt/claude/.local/bin
  /opt/grok                grok via its installer (GROK_VERSION overrides),
                           agent-owned; binary at /opt/grok/bin/grok with
                           a 130MB downloads cache alongside (runtime
                           symlinks into it, so it stays); PATH gains
                           /opt/grok/bin
  /opt/agy                 agy via its installer (latest-only), agent-owned;
                           single 213MB binary at /opt/agy/bin/agy;
                           PATH gains /opt/agy/bin
  agent user               uid 1001 (pinned); USER agent for the workload
  workdir                  /home/agent/work
  entrypoint               /usr/local/bin/sandbox-entrypoint.sh
  cmd                      sleep infinity

container (per workspace, --cap-drop ALL, user agent)
  mounts                   workspace root rw at its own path
                           + extra same-path binds, read-only
  home volume              mounted at /home/agent
  env                      SANDBOX_GENERATION + SANDBOX_CONFIG_FINGERPRINT
  readiness                $SANDBOX_READY_DIR/ready.json, default
                           /tmp/sandbox-ready, polled by ensureReady
```

`sandbox-entrypoint.sh` is where a home's shape is decided: it deletes any
stale `ready.json`, creates `.claude`, `.codex`, `.copilot`, `.pi`,
`.grok`, `.gemini`, `.qwen`, `.kimi`, `.mimo`, `.auggie`,
`.config/opencode`, `.config/github-copilot`, `work`, and `instances`
under `$HOME`, and only then writes the token and `exec`s the command. It
refuses to run without `SANDBOX_GENERATION` and
`SANDBOX_CONFIG_FINGERPRINT` (`:?` expansion), so a container that lost
its environment exits instead of reporting ready.

The workspace root binds at its own path inside the container, so
absolute paths, editor links, and cwd-keyed agent state survive the
boundary. The home volume is mounted over `/home/agent`, which is why
installed binaries live outside it (`/usr/local`, `/opt/claude`).
Fresh volumes inherit image ownership; migrated or foreign-owned trees
are repaired by a full-capability chown one-shot at creation time,
because the cap-dropped entrypoint cannot chown (no CAP_CHOWN).

`ensureReady` discards the existing container along four distinct paths,
checked in this order:

```
foreign container
   the runtime label names another runtime -> remove it, treat as absent
   the label is unreadable, or names the
   runtime already in charge                 -> refuse; never mutate
network policy
   the network's actual internal flag disagrees with the entry
      -> remove the container (a policy switch orphans it, and it must
         go before the network itself can be recreated)
configuration drift
   image id differs, or the container is not attached to the expected
   network, or the fingerprint it recorded in ready.json differs
      -> remove it
absent    create, then poll ready.json for the generation token
stopped   start, then require the current fingerprint and a fresh
          started_at (the entrypoint rewrites ready.json every start)
running   already ready once the fingerprint matches
```

The second path is why a policy switch is described as recreate-on-next-
start rather than as a network edit: the container holding the old
network has to go before the network can. The third is why `mounts`
feeds the fingerprint — a mount change recreates, rather than leaving a
container whose environment the readiness loop could never match. A
container that predates fingerprints records none, reads as unknown, and
is left alone. A failed startup keeps data but never reports ready and
never launches an agent.

## 5. Home model

```
/home/agent                    the home volume, mounted over the image's
                               own /home/agent
  .claude/                     claude state
  .codex/                      codex state
  .copilot/                    copilot state
  .pi/                         pi state
  .grok/                       grok state (includes a downloads cache;
                               fork copies it whole)
  .gemini/                     agy state
  .qwen/                       qwen state
  .kimi/                       kimi state
  .mimo/                       mimo state
  .auggie/                     auggie state
  .config/opencode/            opencode state
  .config/github-copilot/      copilot state
  work/                        the image's WORKDIR
  instances/<name>/            fork and fresh homes
```

The entrypoint creates all of those on every start, so a fresh volume
needs no seeding step. The list is hard-coded there — it is not derived
from the engines. An engine's `statePaths` field is validated at catalog
load and reported by `agent list --json`, and **nothing else reads it**:
a user catalog declaring a new agent gets no directory created and no
fork behaviour from it, only an entry in that listing. The fork list is a
second hard-coded constant, and it is not the same list.

Per-instance HOME modes, recorded on the roster entry at birth:

```
shared   HOME=/home/agent. Default, including old entries without
         a recorded mode. Full continuity; do not run concurrent
         writers against the same files.
fork     On first launch, for each of .claude, .codex, .copilot, .pi, .grok, .gemini,
         .qwen, .kimi, .mimo, .auggie and .config: if the instance does not have that directory yet,
         create it and copy the shared one in. Per directory, not per
         file — a directory that already exists is never topped up.
         A failed copy is swallowed, so a fork can launch with an
         empty room and say nothing. The fork name is tracked for
         later pruning.
fresh    Empty room. Nothing is copied, nothing is shared.
```

The copy is unfiltered. A comment in `lifecycle.ts` calls the fork list
"caches excluded", and no code excludes them: everything under those eleven
directories is copied. Read that comment as intent, not as behaviour.

Secrets stay orthogonal: credential files live host-side and inject as
process environment regardless of home mode. Closing an instance drops
its roster entry and window while keeping data; `prune --forks`
removes orphan fork directories (credential files never).

## 6. Image lifecycle

```
overrides (upgrade flows, emergencies) --> build args <AGENT>_VERSION
  --> build (docker or apple)
  --> inspect: the eleven CLI versions must clear their catalog floors;
      the resolved set is the build receipt
  --> verify: the entrypoint is executable, and -- on the `image build`
      path only -- a throwaway run wrote a ready.json carrying the
      generation it was given
  --> candidate tag
  --> activate: the tag in use becomes the rollback target
  --> recreate on next start
  --> rollback re-activates the previous tag
  --> prune: images no workspace references (current + previous kept)
      are removed after confirmation, on every runtime in use
```

`image build` uses the target workspace's runtime when `--workspace`
resolves to a registered entry, else the host default. `agent upgrade`
only resolves and builds; `workspace upgrade` resolves, skips the
build when everything is current, and otherwise builds, activates,
and recreates under one confirmation.

`agent upgrade` never activates — it prints the tag and points at
`image activate`. Both build paths report "verified", and they do not
mean the same thing: the upgrade path tests only that the entrypoint
exists and is executable, while the image-build path also reads the
generation back out of a throwaway `ready.json`, which is what makes its
verification independent of the build's own exit status.

Activation is recorded only after the candidate verifies, and it
interrupts live instances: both `activate` and `rollback` confirm first
when the roster is non-empty. `rollback` refuses when no previous tag was
recorded, and re-activating an earlier image does not reverse a data
migration — it says so in its own output.

## 7. Resolution, locks, and generations

Resolution precedence: explicit `--workspace`, nearest registered
ancestor of the cwd, git root, cwd. Unknown scopes offer guided
registration, never silent creation.

**Two locks, because two kinds of state are shared at two different
granularities.** Lock granularity has to match write granularity: the
registry is one file written *whole*, so a per-workspace lock over it
would not be a weaker guarantee — it would be no guarantee at all, since
two runs on different workspaces take different lock files and never
contend.

```
state            lock identity      held for
---------------  -----------------  ------------------------------------
registry file    the constant       one read-modify-write, never across
                 'registry'         slow work
workspace        the workspace id   the slow work: startup, readiness,
                                    one-shot, volume copy
```

- **The registry lock is taken before the read.** No write may be derived
  from a snapshot read outside it. A read taken earlier is resolution
  input only: the entry that gets mutated is re-resolved from the object
  the transaction hands back, never from the caller's snapshot.
- **The registry lock is always innermost.** The transaction's callback
  is synchronous, so it cannot acquire the workspace lock; the nesting
  order is guaranteed by the type rather than by discipline, and no cycle
  exists. A command needing both takes the workspace lock and runs the
  transaction inside it.
- A long hold is the *workspace* lock doing its job. Startup, the
  readiness loop, and the volume copy must be held, or two commands fight
  over the same container and home volume. What must not sit inside that
  hold is the registry write, and it no longer does.

**One operation records that it started: `restore`.** The workspace lock
serialises a *live* restore against every other command, so a concurrent
run simply waits and then finds a complete home. It protects nothing once
the process **dies**: `acquireLock` reclaims a dead holder's lock by pid
liveness, so a crash mid-copy would leave a half-copied home and an
already-replaced entry with nothing on disk to say so.
`entry.pendingOperation` is that record, and it exists for death, not for
concurrency. It is written in the transaction that reinstates the entry
and cleared in a second transaction after the copy — never held across
the copy.

It is the only such record, and the two operations that need none need it
for different reasons. `upgrade` needs none because the recorded image
pointer **is** the intent: a crash leaves the registry pointing at the new
image and the container running the old one, and the next start recreates
on the image-id mismatch — self-healing, and no worse than before. Fork
pruning needs none because it does the idempotent work first (`rm -rf`
exits 0 on an absent path) and records the claim after, so a crash between
the two is repaired by re-running.

**A claim freezes the workspace.** Every command except `restore` refuses
while one is outstanding, and the refusal names the backup to re-run from.
The rule is deliberately one rule with two carve-outs rather than a
per-command judgement about which writes are independent of a restore:
because a re-run rebuilds the entry **wholesale**, a `mount` or a
`configure` accepted in the window would be *guaranteed* to be discarded,
and handing a user a change that is certain to be lost is worse than
refusing it. The carve-outs are `restore` itself, which clears the claim,
and the two reports that never write — `status` states the claim and
`doctor` warns about it. Read-only commands that still resolve a workspace
(`logs`) are frozen with everything else: the rule is applied at one choke
point instead of by classifying commands, and one over-broad refusal is
cheaper than a classification that gets one wrong. Nothing is ever cleared
automatically — a blocked workspace is the intended behaviour until the
re-run completes, which is what makes stop-and-re-run safe: copying over a
half-copy completes it.

A malformed claim fails the registry load rather than being dropped.
Dropping it would unblock a workspace whose home is still indeterminate,
which is the defect the record exists to prevent.

Each creation mints a fresh generation token plus a configuration
fingerprint over (root, recorded image, target image, network, mounts);
only the entrypoint, rerun on every real start, can write a matching
ready file, so stale state can never satisfy a new generation.

## 8. Network and mounts

Per workspace: `open` (default route) or `restricted` (internal-only,
verified by probing for the absence of an external route). Switching
policy recreates the container on next start — see §4 for why the
container has to go before the network can.

```
mount              path                       mode
workspace root     its own absolute path      rw   (never droppable)
extra mounts       their own absolute paths   ro
home volume        /home/agent                rw   (a volume, not a bind)
```

Extra mounts are read-only same-path binds, and the workspace root can
never be dropped: both `configure --drop-mount` and `unmount` refuse it.

The guard that vets a new mount refuses `/`, HOME, the sandbox state
directory, and **every ancestor of those two**, plus every **descendant
of the state directory** (a child of HOME stays allowed: workspace roots
live there). The ancestor rule is the load-bearing part — refusing only
the exact paths was not enough, since binding `/Users` or `/home` hands
over HOME, the registry and every dotfile without ever naming HOME.
The descendant rule closes the mirror image: mounting
`~/.agent.sandbox/registry.json` directly would do by name what the
ancestor rule exists to prevent. Registration and restore both store the
vetted canonical path, not the spelling the user or manifest gave: vetting
one spelling while storing another would let a symlink swapped afterwards
redirect the next bind. Two limits are worth stating plainly:
the check is lexical, run on a best-effort `realpath` (a path that cannot
be resolved falls through uncanonicalized), and it names no container
runtime socket — a socket bind is not refused by this guard.

## 9. Security boundaries

- The isolation boundary is the container, not the window: agents in
  one container share a user and can read one another's files.
- The mount guard keeps the host HOME as a whole, the sandbox state
  directory, every ancestor of both, and every descendant of the state
  directory out of the container — so the
  registry, the credential files and every dotfile are unreachable by a
  path that names them. It is a path guard, not a capability boundary:
  it does not refuse a bind of the container runtime's socket, and
  nothing else does either.
- Provider secrets live host-side in
  `~/.agent.sandbox/<id>/instances/<name>.env` (file mode 0600,
  directory mode 0700), never in the registry, and are redacted
  wherever the CLI displays them. They are injected as process
  environment, which for this CLI means `-e KEY=VALUE` on the
  `docker exec` that launches a window: while that command runs, its
  arguments — values included — are visible to anything that can read
  the host's process list. They are never written into an image, and
  the workload container itself is created with no provider secrets at
  all, only the generation and fingerprint.
- Containers start as the agent user with ALL capabilities dropped;
  privileged preparation (ownership repair) happens in throwaway
  one-shots outside the workload container.
- Registry files are data, never shell-sourced, never mounted in.
  Execution uses argv vectors. Where a `sh -c` script is assembled at
  all, every interpolated value is first constrained to the shared
  safe-name charset `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/` (colon excluded) —
  instance names and fork names both, the latter re-validated at the
  registry load boundary so neither a hand-edited registry nor a
  restored backup can seed one. An interpolated value that is not a
  safe name is a defect even when today's callers happen to pass one.

## 10. Supported platforms

Developed and verified on macOS with Docker Desktop and tmux; that is
where a live container lifecycle has actually been exercised. Linux is
covered at unit level only — the publish workflow runs the test suite on
`ubuntu-latest` before publishing, but no live container lifecycle is
verified there. Windows is not supported. Containers are always Linux.

## 11. Npm release

Releases after 0.22.1 go through changesets (`npm run changeset`,
`npm run version`, `npm run release`) on `main`, matching dockyard /
agent-slate / agent-daemon. Access is restricted GitHub Packages.
Do not hand-edit `package.json` version.
