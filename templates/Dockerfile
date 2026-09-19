# Sandbox workspace image. Built without secrets; versions pinned via build args.
# The host owns tmux windows and runs `docker exec` into this container,
# so no tmux server runs inside the image.
ARG OPENCODE_VERSION=1.18.31
ARG CODEX_VERSION=0.155.1
ARG COPILOT_VERSION=1.0.86
ARG CLAUDE_VERSION=2.1.276

FROM node:22-bookworm-slim

ARG OPENCODE_VERSION
ARG CODEX_VERSION
ARG COPILOT_VERSION
ARG CLAUDE_VERSION

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client curl \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g \
    "opencode-ai@${OPENCODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
    "@github/copilot@${COPILOT_VERSION}" \
  && npm cache clean --force

# Non-root agent user for everything inside the workspace container.
# The UID is pinned: the node base already owns 1000, and home volumes
# persist numeric ownership across image generations, so an unpinned
# UID would lock the agent out of migrated state after a base change.
# Never hard-code the number anywhere else; always use the name.
# HOME must be explicit because build steps run as root with this HOME
# (so root-owned caches land here); the whole tree is handed back below.
ENV HOME=/home/agent
RUN useradd -u 1001 -m -s /bin/bash agent \
  && mkdir -p /home/agent/.claude /home/agent/.codex /home/agent/.copilot \
    /home/agent/.config/opencode /home/agent/.config/github-copilot /home/agent/work \
  && chown -R agent:agent /home/agent

COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh

# Claude ships outside npm and must live outside the home volume: the
# volume is mounted over /home/agent at runtime and would mask anything
# baked in there. The installer lays everything under $HOME, so point it
# at /opt/claude (agent-owned, refreshed on every build). Runs as root;
# the trees are handed back below.
RUN mkdir -p /opt/claude && export HOME=/opt/claude \
  && curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_VERSION}" \
  && chown -R agent:agent /opt/claude \
  && chown -R agent:agent /home/agent
ENV PATH="/opt/claude/.local/bin:${PATH}"

USER agent
WORKDIR /home/agent/work

ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint.sh"]
CMD ["sleep", "infinity"]
