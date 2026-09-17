# Sandbox workspace image. Built without secrets; versions pinned via build args.
# The host owns tmux windows and runs `docker exec` into this container,
# so no tmux server runs inside the image.
ARG OPENCODE_VERSION=1.18.31
ARG CODEX_VERSION=0.154.0
ARG COPILOT_VERSION=1.0.85

FROM node:22-bookworm-slim

ARG OPENCODE_VERSION
ARG CODEX_VERSION
ARG COPILOT_VERSION

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g \
    "opencode-ai@${OPENCODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
    "@github/copilot@${COPILOT_VERSION}" \
  && npm cache clean --force

# Non-root agent user. Installed binaries live outside the home volume;
# the home volume persists agent configuration and history per workspace.
RUN useradd -m -s /bin/bash agent \
  && mkdir -p /home/agent/.claude /home/agent/.codex /home/agent/.copilot \
    /home/agent/.config/opencode /home/agent/.config/github-copilot /home/agent/work \
  && chown -R agent:agent /home/agent

COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh

USER agent
WORKDIR /home/agent/work

ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint.sh"]
CMD ["sleep", "infinity"]
