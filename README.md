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
