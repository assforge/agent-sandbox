# Sandbox workspace image. Built without secrets; versions pinned via build args.
# The host owns tmux windows and runs `docker exec` into this container,
# so no tmux server runs inside the image.
ARG OPENCODE_VERSION=1.18.31
ARG CODEX_VERSION=0.154.0
ARG COPILOT_VERSION=1.0.85
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

# Non-root agent user. Installed binaries live outside the home volume;
# the home volume persists agent configuration and history per workspace.
# The agent UID varies by builder base (docker resolves 1000, the Apple
# builder already occupies it and resolves 1001). All ownership moves use
# the name, never a number; a workspace is pinned to one runtime anyway.
RUN useradd -m -s /bin/bash agent \
  && mkdir -p /home/agent/.claude /home/agent/.codex /home/agent/.copilot \
    /home/agent/.config/opencode /home/agent/.config/github-copilot /home/agent/work \
  && chown -R agent:agent /home/agent

COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh

USER agent
WORKDIR /home/agent/work

# Claude ships outside npm: the official installer lands in ~/.local/bin,
# which is outside the persisted home volume and refreshed on every build.
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_VERSION}"
ENV PATH="/home/agent/.local/bin:${PATH}"

ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint.sh"]
CMD ["sleep", "infinity"]
