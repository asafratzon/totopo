# =============================================================================
# Secure AI Dev Container — host-mirror mode
# =============================================================================
# Non-root user, no git remote access, AI tools: claude, kilo, opencode, codex
# Runtimes: selected by totopo host-mirror (regenerated on each session start)
# =============================================================================

FROM debian:bookworm-slim
LABEL totopo.managed=true

# ---------------------------------------------------------------------------
# Layer 1 — System packages
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core utilities
    git curl wget bash zsh make \
    # Build essentials (needed for Rust compilation, C extensions, etc.)
    build-essential pkg-config libssl-dev \
    # Utilities
    jq unzip zip tree htop procps lsb-release gnupg ca-certificates sox \
    # Modern search/navigation tools
    ripgrep fzf \
    # Database clients
    sqlite3 postgresql-client default-mysql-client redis-tools \
    # Python (system runtime — required by build scripts)
    python3 python3-pip python3-venv pipx \
    # Java build tools
    maven \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 2 — fd (not available as fd-find in bookworm; install from GitHub)
# ---------------------------------------------------------------------------
RUN ARCH=$(dpkg --print-architecture) && \
    FD_VERSION=$(curl -fsSL https://api.github.com/repos/sharkdp/fd/releases/latest \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'][1:])") && \
    curl -fsSL "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd_${FD_VERSION}_${ARCH}.deb" \
        -o /tmp/fd.deb && dpkg -i /tmp/fd.deb && rm /tmp/fd.deb

# ---------------------------------------------------------------------------
# Layer 3 — yq (not in apt)
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
# Layer 5 — Node.js (via NodeSource — always included for AI tools)
# ---------------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 6 — Eclipse Temurin 17 JDK (Adoptium apt repo)
# ---------------------------------------------------------------------------
RUN curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public \
        | gpg --dearmor -o /usr/share/keyrings/adoptium.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] \
        https://packages.adoptium.net/artifactory/deb $(lsb_release -cs) main" \
        > /etc/apt/sources.list.d/adoptium.list && \
    apt-get update && apt-get install -y temurin-17-jdk && rm -rf /var/lib/apt/lists/*
RUN echo 'export JAVA_HOME=$(dirname $(dirname $(readlink -f $(which java))))' \
        > /etc/profile.d/java.sh

# ---------------------------------------------------------------------------
# Layer 7 — Go 1.20.3 (host version, official tarball)
# ---------------------------------------------------------------------------
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://go.dev/dl/go1.20.3.linux-${ARCH}.tar.gz" \
        | tar -xz -C /usr/local && \
    echo 'export PATH=/usr/local/go/bin:$PATH' > /etc/profile.d/go.sh

# ---------------------------------------------------------------------------
# Layer 8 — Git remote block
# ---------------------------------------------------------------------------
RUN git config --system protocol.allow never && \
    git config --system protocol.file.allow always

# ---------------------------------------------------------------------------
# Layer 9 — Global npm tools
# ---------------------------------------------------------------------------
RUN npm install -g \
    pnpm \
    @anthropic-ai/claude-code \
    @kilocode/cli \
    opencode-ai \
    @openai/codex \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Layer 10 — Non-root user
# ---------------------------------------------------------------------------
RUN groupadd --gid 1001 devuser && \
    useradd --uid 1001 --gid devuser --shell /bin/bash --create-home devuser

USER devuser
WORKDIR /workspace

# ---------------------------------------------------------------------------
# Layer 11 — Rust 1.93.0 (installed as devuser via rustup)
# ---------------------------------------------------------------------------
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --default-toolchain 1.93.0 && \
    /home/devuser/.cargo/bin/rustup component add rustfmt clippy

# ---------------------------------------------------------------------------
# Layer 13 — Python user tools (uv + poetry via pipx)
# ---------------------------------------------------------------------------
RUN pipx install uv && pipx install poetry
RUN /home/devuser/.local/bin/uv python install 3.12

ENV PATH="/home/devuser/.cargo/bin:/home/devuser/.local/bin:/usr/local/go/bin:${PATH}"
RUN echo 'export PS1="\[\033[01;32m\][devcontainer]\[\033[00m\] \[\033[01;34m\]\w\[\033[00m\] \$ "' \
        >> /home/devuser/.bashrc && \
    echo 'echo ""' >> /home/devuser/.bashrc && \
    echo "echo \"  Type 'status' to re-run the readiness check.\"" >> /home/devuser/.bashrc && \
    echo 'alias status="node /workspace/.totopo/post-start.mjs"' >> /home/devuser/.bashrc

CMD ["/bin/bash"]
