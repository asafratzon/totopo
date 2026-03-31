# =============================================================================
# totopo — Secure AI Dev Container (essentials base)
# =============================================================================
# Non-root user, git remote block, AI tools: opencode, claude, codex
# Base runtime: Node.js LTS + python3 (for build scripts)
#
# Additional runtimes (Go, Rust, Java, Bun, etc.) are added via
# dockerfile_hook in totopo.yaml profiles.
# =============================================================================

FROM debian:bookworm-slim
LABEL totopo.managed=true

# ---------------------------------------------------------------------------
# Layer 1 — System packages
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core utilities
    git curl wget bash zsh make \
    # Build essentials
    build-essential pkg-config libssl-dev \
    # Utilities
    jq unzip zip tree htop procps lsb-release gnupg ca-certificates sox \
    # Modern search/navigation tools
    ripgrep fzf \
    # Database clients
    sqlite3 postgresql-client default-mysql-client redis-tools \
    # Python (needed for build scripts and as a light default)
    python3 python3-pip python3-venv pipx \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 2 — fd (GitHub release)
# ---------------------------------------------------------------------------
RUN ARCH=$(dpkg --print-architecture) && \
    FD_VERSION=$(curl -fsSL https://api.github.com/repos/sharkdp/fd/releases/latest \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'][1:])") && \
    curl -fsSL "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd_${FD_VERSION}_${ARCH}.deb" \
        -o /tmp/fd.deb && dpkg -i /tmp/fd.deb && rm /tmp/fd.deb

# ---------------------------------------------------------------------------
# Layer 3 — yq (GitHub release)
# ---------------------------------------------------------------------------
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${ARCH}" \
        -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq

# ---------------------------------------------------------------------------
# Layer 4 — GitHub CLI
# ---------------------------------------------------------------------------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
        https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 5 — Node.js LTS (via NodeSource)
# ---------------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
    apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 6 — Git remote block (security boundary)
# ---------------------------------------------------------------------------
RUN git config --system protocol.allow never && \
    git config --system protocol.file.allow always

# ---------------------------------------------------------------------------
# Layer 7 — Global npm tools (AI CLIs)
# ---------------------------------------------------------------------------
RUN npm install -g \
    pnpm \
    opencode-ai \
    @anthropic-ai/claude-code \
    @openai/codex \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Layer 8 — Non-root user
# ---------------------------------------------------------------------------
RUN groupadd --gid 1001 devuser && \
    useradd --uid 1001 --gid devuser --shell /bin/bash --create-home devuser && \
    mkdir -p /home/devuser/.local/state /home/devuser/.local/share /home/devuser/.local/bin && \
    chown -R devuser:devuser /home/devuser

# ---------------------------------------------------------------------------
# Layer 9 — Bake post-start script into image
# ---------------------------------------------------------------------------
COPY post-start.mjs /home/devuser/post-start.mjs
RUN chown devuser:devuser /home/devuser/post-start.mjs

WORKDIR /workspace

# ---------------------------------------------------------------------------
# NOTE: USER devuser is appended by totopo at build time (after profile hook)
# Do not add it here.
# ---------------------------------------------------------------------------
