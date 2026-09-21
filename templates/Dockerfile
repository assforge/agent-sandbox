# Sandbox workspace image. Built without secrets. Latest-first: agents
# install at whatever the channels currently serve; a build arg pins one
# only when the caller passes an override (upgrade flows, emergencies).
# The host owns tmux windows and runs `docker exec` into this container,
# so no tmux server runs inside the image.
ARG OPENCODE_VERSION
ARG CODEX_VERSION
ARG COPILOT_VERSION
ARG PI_VERSION
ARG QWEN_VERSION
ARG KIMI_VERSION
ARG MIMO_VERSION
ARG AUGGIE_VERSION
ARG CLAUDE_VERSION
ARG GROK_VERSION
ARG AIDER_VERSION
ARG GOOSE_VERSION

FROM node:22-bookworm-slim

ARG OPENCODE_VERSION
ARG CODEX_VERSION
ARG COPILOT_VERSION
ARG PI_VERSION
ARG QWEN_VERSION
ARG KIMI_VERSION
ARG MIMO_VERSION
ARG AUGGIE_VERSION
ARG CLAUDE_VERSION
ARG GROK_VERSION
ARG AIDER_VERSION
ARG GOOSE_VERSION

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client curl unzip bzip2 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g \
    "opencode-ai${OPENCODE_VERSION:+@$OPENCODE_VERSION}" \
    "@openai/codex${CODEX_VERSION:+@$CODEX_VERSION}" \
    "@github/copilot${COPILOT_VERSION:+@$COPILOT_VERSION}" \
    "@earendil-works/pi-coding-agent${PI_VERSION:+@$PI_VERSION}" \
    "@qwen-code/qwen-code${QWEN_VERSION:+@$QWEN_VERSION}" \
    "@moonshot-ai/kimi-code${KIMI_VERSION:+@$KIMI_VERSION}" \
    "@mimo-ai/cli${MIMO_VERSION:+@$MIMO_VERSION}" \
    "@augmentcode/auggie${AUGGIE_VERSION:+@$AUGGIE_VERSION}" \
  && pip install --break-system-packages "aider-chat${AIDER_VERSION:+==$AIDER_VERSION}" \
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
  && mkdir -p /home/agent/.claude /home/agent/.codex /home/agent/.copilot /home/agent/.pi /home/agent/.grok \
    /home/agent/.gemini /home/agent/.qwen /home/agent/.kimi-code /home/agent/.augment /home/agent/.local/share/mimocode \
    /home/agent/.cursor /home/agent/.config/devin /home/agent/.local/share/devin /home/agent/.kiro /home/agent/.aider \
    /home/agent/.config/opencode /home/agent/.config/github-copilot /home/agent/.config/mimocode /home/agent/.config/goose /home/agent/work \
  && chown -R agent:agent /home/agent

COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh

# Grok ships outside npm: installer script, version-addressable, API-key auth.
# Installed under /opt/grok (outside the home volume). GROK_BIN_DIR must be
# exported in the same shell (a VAR=val prefix on `curl | bash` only reaches
# curl, not the installer); the downloads cache stays because BIN_DIR links
# into it. agy has no version selection, so it always tracks latest and
# takes no build arg.
RUN mkdir -p /opt/grok && export HOME=/opt/grok GROK_BIN_DIR=/opt/grok/bin \
  && if [ -n "${GROK_VERSION}" ]; then curl -fsSL https://x.ai/cli/install.sh | bash -s -- "${GROK_VERSION}"; else curl -fsSL https://x.ai/cli/install.sh | bash; fi \
  && rm -rf /opt/grok/.bashrc /opt/grok/.cache \
  && chown -R agent:agent /opt/grok \
  && mkdir -p /opt/agy/bin && curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /opt/agy/bin \
  && chown -R agent:agent /opt/agy
ENV PATH="/opt/grok/bin:/opt/agy/bin:${PATH}"
# Auggie self-updates by default, which would move binaries under a recorded
# image and manufacture drift. Versions change only at build in this model.
ENV AUGMENT_DISABLE_AUTO_UPDATE=true
# Cursor, Devin and Kiro are latest-only scripts into HOME-scoped dirs.
# Cursor self-updates unless launched with --disable-auto-update (baked into
# its launch vector); kiro installs kiro-cli, kiro-cli-chat and kiro-cli-term.
# Devin's installer ends by running `devin setup`, which fails headless, so
# that step's verdict is the binary's existence, not the script's exit code.
RUN mkdir -p /opt/cursor && export HOME=/opt/cursor \
  && curl -fsSL https://cursor.com/install | bash \
  && chown -R agent:agent /opt/cursor \
  && mkdir -p /opt/devin && export HOME=/opt/devin \
  && curl -fsSL https://cli.devin.ai/install.sh | bash; test -x /opt/devin/.local/bin/devin \
  && chown -R agent:agent /opt/devin \
  && mkdir -p /opt/kiro && export HOME=/opt/kiro \
  && curl -fsSL https://cli.kiro.dev/install | bash -s -- --force \
  && chown -R agent:agent /opt/kiro
ENV PATH="/opt/cursor/.local/bin:/opt/devin/.local/bin:/opt/kiro/.local/bin:${PATH}"
# Aider (pip) and goose (standalone script) complete the set. Goose honors
# GOOSE_BIN_DIR; aider takes ==pins like npm takes @pins.
RUN mkdir -p /opt/goose/bin && export GOOSE_BIN_DIR=/opt/goose/bin GOOSE_VERSION="${GOOSE_VERSION:-}" CONFIGURE=false \
  && curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash \
  && chown -R agent:agent /opt/goose
ENV PATH="/opt/goose/bin:${PATH}"
# Claude ships outside npm and must live outside the home volume: the
# volume is mounted over /home/agent at runtime and would mask anything
# baked in there. The installer lays everything under $HOME, so point it
# at /opt/claude (agent-owned, refreshed on every build). Runs as root;
# the trees are handed back below.
RUN mkdir -p /opt/claude && export HOME=/opt/claude \
  && if [ -n "${CLAUDE_VERSION}" ]; then curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_VERSION}"; else curl -fsSL https://claude.ai/install.sh | bash; fi \
  && chown -R agent:agent /opt/claude \
  && chown -R agent:agent /home/agent
ENV PATH="/opt/claude/.local/bin:${PATH}"

USER agent
WORKDIR /home/agent/work

ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint.sh"]
CMD ["sleep", "infinity"]
