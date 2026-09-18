# sandbox

Sandboxed multi-agent workbench. One workspace owns one managed container
and one host tmux session; each agent instance owns a window whose process
runs inside that workspace's container.

```sh
sandbox                          # resolve cwd, start or reconnect, open shell
sandbox claude --name rollout    # named Claude window in this workspace
sandbox codex                    # Codex window, default instance name
sandbox shell                    # plain shell window
sandbox doctor                   # read-only diagnostics
sandbox --help
sandbox --version
```

## Install

Published to GitHub Packages (`@assforge` scope, restricted access):

```sh
npm install -g @assforge/cogent-sandbox --registry=https://npm.pkg.github.com
```

Prerequisites remain host dependencies: Docker and tmux. `sandbox doctor`
reports platform-appropriate remediation commands but never installs them.

## Isolation

Containers never receive the host HOME, SSH credentials, or the Docker
socket. Same-container agents share a user and can read one another's
files; containers do not protect prompt or file content sent to providers.

## Cross-OS node_modules

The workspace root is mounted from the host. When the host OS differs
from the container OS (macOS host, Linux container), host-installed
`node_modules` with native bindings (for example rollup) do not load
inside the container. Run a container-side install into a directory
outside the shared mount before executing project tests there:

```sh
sandbox workspace exec -- npm ci --prefix /tmp/party
sandbox workspace exec -- npm --prefix /tmp/party test
```

## Release

Version with changesets, same shape as dockyard / agent-slate / agent-daemon.

```sh
npm run changeset    # record a pending bump after a user-facing change
npm run version      # consume pending files, bump package.json, write CHANGELOG
npm run release      # publish to GitHub Packages (restricted)
```

Do not hand-edit `package.json` version. See `.changeset/README.md`.

## Docs

- [docs/architecture.md](docs/architecture.md) — resource model, engine
  seams, home model, image lifecycle, security boundaries.
- [docs/flows.md](docs/flows.md) — step-by-step flows for launch,
  restart, upgrade, update, migrate, backup, close, prune, and doctor.

## Supported platforms

Developed and verified on macOS with Docker Desktop and tmux. Linux
hosts are expected to work but are not verified in CI. Windows is not
supported. Containers are always Linux; the Apple Container runtime is
capability-verified through live end-to-end runs on this machine.
