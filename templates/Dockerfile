# =============================================================================
# totopo - Secure AI Dev Container (essentials base)
# =============================================================================
# Non-root user, git remote block, AI tools: opencode, claude, codex
# Base runtime: Node.js LTS + python3 (for build scripts)
#
# Additional runtimes (Go, Rust, Java, Bun, etc.) are added via
# dockerfile_hook in totopo.yaml profiles.
# =============================================================================

# ---------------------------------------------------------------------------
# Version pinning policy
# Infra tools whose major versions can change behavior are pinned exact so that
# fresh and --no-cache builds stay reproducible; bumping a pin edits this file,
# busts the build hash, and auto-prompts a rebuild. Deliberately left floating:
# apt packages (pinned by the Debian trixie release), Node (major-pinned via
# setup_24.x; minors carry security fixes), and the AI CLIs (always latest).
# ---------------------------------------------------------------------------

FROM debian:trixie-slim
LABEL totopo.managed=true

# Enable 24-bit color support for AI CLIs (suppresses color upgrade prompts)
ENV COLORTERM=truecolor

# ---------------------------------------------------------------------------
# Layer 1 - System packages
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core utilities
    git curl wget bash zsh make \
    # Build essentials
    build-essential pkg-config libssl-dev \
    # Utilities (libsox-fmt-pulse + pulseaudio-utils let SoX 'rec' reach a host PulseAudio server for Claude Code /voice; dormant unless wired at runtime)
    jq unzip zip tree htop procps lsb-release gnupg ca-certificates sox libsox-fmt-pulse pulseaudio-utils file bubblewrap \
    # Modern search/navigation tools (fd-find installs the binary as 'fdfind'; symlinked to 'fd' below)
    ripgrep fzf fd-find \
    # Database clients
    sqlite3 postgresql-client default-mysql-client redis-tools \
    # Python (needed for build scripts and as a light default)
    python3 python3-pip python3-venv pipx \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 2 - fd (from apt fd-find; Debian names the binary 'fdfind')
# Symlink to 'fd' so the tool is callable by its upstream name.
# ---------------------------------------------------------------------------
RUN ln -sf "$(command -v fdfind)" /usr/local/bin/fd

# ---------------------------------------------------------------------------
# Layer 3 - yq (GitHub release, pinned)
# ---------------------------------------------------------------------------
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mikefarah/yq/releases/download/v4.53.3/yq_linux_${ARCH}" \
        -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq

# ---------------------------------------------------------------------------
# Layer 4 - GitHub CLI
# ---------------------------------------------------------------------------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
        https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 5 - Node.js 24 LTS (via NodeSource)
# Trixie's apt nodejs is 20.x; NodeSource is pinned to the current Active LTS (24.x).
# ---------------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 6 - Git remote block (security boundary)
# ---------------------------------------------------------------------------
RUN git config --system protocol.allow never && \
    git config --system protocol.file.allow always

# ---------------------------------------------------------------------------
# Layer 7 - Global npm tools (pnpm pinned; AI CLIs always latest)
# pnpm is pinned exact: pnpm 11 changed where global settings are read from
# (~/.config/pnpm/config.yaml, no longer ~/.npmrc), so an unpinned major bump
# can silently break the baked store-dir config.
# ---------------------------------------------------------------------------
RUN npm install -g \
    pnpm@11.6.0 \
    opencode-ai \
    @anthropic-ai/claude-code \
    @openai/codex \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Layer 8 - Non-root user
# ---------------------------------------------------------------------------
RUN groupadd --gid 1001 devuser && \
    useradd --uid 1001 --gid devuser --shell /bin/bash --create-home devuser && \
    mkdir -p /home/devuser/.local/state /home/devuser/.local/share /home/devuser/.local/share/pnpm /home/devuser/.local/bin /home/devuser/.config/pnpm && \
    date -u +"%Y-%m-%dT%H:%M:%S.000Z" > /home/devuser/.ai-cli-updated && \
    chown -R devuser:devuser /home/devuser

# ---------------------------------------------------------------------------
# Layer 9 - Bake startup script + git mode helper + shared constants + pnpm config into image
# pnpm 11+ reads settings from ~/.config/pnpm/config.yaml; ~/.npmrc covers anyone pinning pnpm <= 10.
# ---------------------------------------------------------------------------
COPY npmrc /home/devuser/.npmrc
COPY pnpm-config.yaml /home/devuser/.config/pnpm/config.yaml
COPY startup.mjs /home/devuser/startup.mjs
COPY startup-git-mode.mjs /home/devuser/startup-git-mode.mjs
COPY runtime-constants.mjs /home/devuser/runtime-constants.mjs
RUN chown devuser:devuser /home/devuser/.npmrc /home/devuser/.config/pnpm/config.yaml /home/devuser/startup.mjs /home/devuser/startup-git-mode.mjs /home/devuser/runtime-constants.mjs

# ---------------------------------------------------------------------------
# Layer 10 - Bake git read-only wrapper into image
# Symlinked to /usr/local/bin/git by startup.mjs when git_mode=strict.
# ---------------------------------------------------------------------------
RUN mkdir -p /usr/local/share/totopo
COPY git-readonly-wrapper.mjs /usr/local/share/totopo/git-readonly
RUN chmod +x /usr/local/share/totopo/git-readonly

# ---------------------------------------------------------------------------
# Layer 11 - Bake Claude default status line script
# Referenced from ~/.claude/settings.json (statusLine.command) at session start.
# ---------------------------------------------------------------------------
COPY claude-statusline.sh /usr/local/share/totopo/claude-statusline.sh
RUN chmod +x /usr/local/share/totopo/claude-statusline.sh

# ---------------------------------------------------------------------------
# Layer 12 - Bake context-usage helper
# Prints the context/quota snapshot written by the status line script, so
# agents can inspect their own usage. On PATH via the symlink.
# ---------------------------------------------------------------------------
COPY context-usage.sh /usr/local/share/totopo/context-usage.sh
RUN chmod +x /usr/local/share/totopo/context-usage.sh && \
    ln -sf /usr/local/share/totopo/context-usage.sh /usr/local/bin/context-usage

WORKDIR /workspace

# ---------------------------------------------------------------------------
# NOTE: USER devuser is appended by totopo at build time (after profile hook)
# Do not add it here.
# ---------------------------------------------------------------------------
