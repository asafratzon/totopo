# =============================================================================
# Secure AI Dev Container — Next.js / Node.js
# =============================================================================
# Non-root user, no git remote access, AI tools: claude, kilo, opencode
# =============================================================================

FROM node:22-bookworm-slim

# ---------------------------------------------------------------------------
# System packages
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    bash \
    jq \
    unzip \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Create non-root user
# ---------------------------------------------------------------------------
RUN groupadd --gid 1001 devuser \
    && useradd --uid 1001 --gid devuser --shell /bin/bash --create-home devuser

# ---------------------------------------------------------------------------
# Git remote block — enforced via git's own system-level config.
# protocol.allow never  -> blocks https, ssh, git:// and ALL other transports
# protocol.file.allow   -> keeps local operations (commit, branch, log) working
#
# This is set in /etc/gitconfig (system scope) so it applies to every user
# and every process — including direct calls to /usr/bin/git. It cannot be
# bypassed without overwriting /etc/gitconfig, which requires root.
# ---------------------------------------------------------------------------
RUN git config --system protocol.allow never && \
    git config --system protocol.file.allow always

# ---------------------------------------------------------------------------
# Global npm tools — installed as root so they land in /usr/local/bin
# ---------------------------------------------------------------------------
RUN npm install -g \
    @anthropic-ai/claude-code \
    @kilocode/cli \
    opencode-ai \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Switch to non-root user for remainder
# ---------------------------------------------------------------------------
USER devuser
WORKDIR /workspace

# ---------------------------------------------------------------------------
# Shell experience
# ---------------------------------------------------------------------------
RUN echo 'export PS1="\[\033[01;32m\][devcontainer]\[\033[00m\] \[\033[01;34m\]\w\[\033[00m\] \$ "' \
    >> /home/devuser/.bashrc && \
    echo 'echo ""' >> /home/devuser/.bashrc && \
    echo "echo \"  Type 'status' to re-run the readiness check.\"" >> /home/devuser/.bashrc && \
    echo 'alias status="node /workspace/.totopo/post-start.mjs"' >> /home/devuser/.bashrc

CMD ["/bin/bash"]