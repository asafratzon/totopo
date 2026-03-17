// =============================================================================
// src/core/generate-dockerfile.ts — generate .totopo/Dockerfile content
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostRuntimes } from "./detect-host.ts";

export function generateDockerfile(mode: "full", templatesDir: string): string;
export function generateDockerfile(mode: "host-mirror", templatesDir: string, selectedTools: string[], hostRuntimes: HostRuntimes): string;
export function generateDockerfile(
    mode: "full" | "host-mirror",
    templatesDir: string,
    selectedTools?: string[],
    hostRuntimes?: HostRuntimes,
): string {
    if (mode === "full") {
        return readFileSync(join(templatesDir, "Dockerfile"), "utf8");
    }
    return buildHostMirrorDockerfile(selectedTools ?? [], hostRuntimes ?? {});
}

// ---------------------------------------------------------------------------
// host-mirror Dockerfile generator
// ---------------------------------------------------------------------------
// NOTE: String.raw`` is used throughout to preserve backslash characters
// verbatim (Dockerfile line continuations, PS1 escape sequences, etc.).
// Shell variable references like ${ARCH} use the DOLLAR trick to avoid
// being interpreted as TypeScript template interpolations.
// ---------------------------------------------------------------------------

function buildHostMirrorDockerfile(selectedTools: string[], host: HostRuntimes): string {
    const hasJava = selectedTools.includes("java");
    const hasGo = selectedTools.includes("go");
    const hasRust = selectedTools.includes("rust");
    const hasBun = selectedTools.includes("bun");
    const hasPython = selectedTools.includes("python");

    const nodeChannel = host.node ? `setup_${host.node}.x` : "setup_lts.x";
    const javaVersion = host.java ?? "21";
    const rustToolchain = host.rust ?? "stable";

    // Used to produce literal ${VAR} shell references in the output
    // (TypeScript template literals would otherwise try to interpolate them)
    const D = "$";

    const sections: string[] = [];

    // ── Header ──────────────────────────────────────────────────────────────
    sections.push(
        `# =============================================================================
# Secure AI Dev Container — host-mirror mode
# =============================================================================
# Non-root user, no git remote access, AI tools: claude, kilo, opencode
# Runtimes: selected by totopo host-mirror (regenerated on each session start)
# =============================================================================

FROM debian:bookworm-slim
LABEL totopo.managed=true`,
    );

    // ── Layer 1 — System packages ────────────────────────────────────────────
    let layer1 = String.raw`# ---------------------------------------------------------------------------
# Layer 1 — System packages
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core utilities
    git curl wget bash zsh make \
    # Build essentials (needed for Rust compilation, C extensions, etc.)
    build-essential pkg-config libssl-dev \
    # Utilities
    jq unzip zip tree htop procps lsb-release gnupg ca-certificates \
    # Modern search/navigation tools
    ripgrep fzf \
    # Database clients
    sqlite3 postgresql-client default-mysql-client redis-tools \
    # Python (system runtime — required by build scripts)
    python3 python3-pip python3-venv pipx`;

    if (hasJava) {
        layer1 += String.raw` \
    # Java build tools
    maven`;
    }

    layer1 += String.raw` \
    && rm -rf /var/lib/apt/lists/*`;

    sections.push(layer1);

    // ── Layer 2 — fd ────────────────────────────────────────────────────────
    sections.push(
        String.raw`# ---------------------------------------------------------------------------
# Layer 2 — fd (not available as fd-find in bookworm; install from GitHub)
# ---------------------------------------------------------------------------
RUN ARCH=$(dpkg --print-architecture) && \
    FD_VERSION=$(curl -fsSL https://api.github.com/repos/sharkdp/fd/releases/latest \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'][1:])") && \
    curl -fsSL "https://github.com/sharkdp/fd/releases/download/v${D}{FD_VERSION}/fd_${D}{FD_VERSION}_${D}{ARCH}.deb" \
        -o /tmp/fd.deb && dpkg -i /tmp/fd.deb && rm /tmp/fd.deb`,
    );

    // ── Layer 3 — yq ────────────────────────────────────────────────────────
    sections.push(
        String.raw`# ---------------------------------------------------------------------------
# Layer 3 — yq (not in apt)
# ---------------------------------------------------------------------------
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${D}{ARCH}" \
        -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq`,
    );

    // ── Layer 4 — GitHub CLI ────────────────────────────────────────────────
    sections.push(
        String.raw`# ---------------------------------------------------------------------------
# Layer 4 — GitHub CLI
# ---------------------------------------------------------------------------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
        https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*`,
    );

    // ── Layer 5 — Node.js ───────────────────────────────────────────────────
    sections.push(
        String.raw`# ---------------------------------------------------------------------------
# Layer 5 — Node.js (via NodeSource — always included for AI tools)
# ---------------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/${nodeChannel} | bash - && \
    apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*`,
    );

    // ── Layer 6 — Java (conditional) ────────────────────────────────────────
    if (hasJava) {
        sections.push(
            String.raw`# ---------------------------------------------------------------------------
# Layer 6 — Eclipse Temurin ${javaVersion} JDK (Adoptium apt repo)
# ---------------------------------------------------------------------------
RUN curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public \
        | gpg --dearmor -o /usr/share/keyrings/adoptium.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] \
        https://packages.adoptium.net/artifactory/deb $(lsb_release -cs) main" \
        > /etc/apt/sources.list.d/adoptium.list && \
    apt-get update && apt-get install -y temurin-${javaVersion}-jdk && rm -rf /var/lib/apt/lists/*
RUN echo 'export JAVA_HOME=$(dirname $(dirname $(readlink -f $(which java))))' \
        > /etc/profile.d/java.sh`,
        );
    }

    // ── Layer 7 — Go (conditional) ──────────────────────────────────────────
    if (hasGo) {
        if (host.go) {
            const goVersion = host.go;
            sections.push(
                String.raw`# ---------------------------------------------------------------------------
# Layer 7 — Go ${goVersion} (host version, official tarball)
# ---------------------------------------------------------------------------
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://go.dev/dl/go${goVersion}.linux-${D}{ARCH}.tar.gz" \
        | tar -xz -C /usr/local && \
    echo 'export PATH=/usr/local/go/bin:$PATH' > /etc/profile.d/go.sh`,
            );
        } else {
            sections.push(
                String.raw`# ---------------------------------------------------------------------------
# Layer 7 — Go (official tarball, latest stable, multi-arch)
# ---------------------------------------------------------------------------
RUN ARCH=$(dpkg --print-architecture) && \
    GO_VERSION=$(curl -fsSL 'https://go.dev/dl/?mode=json' \
        | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['version'].lstrip('go'))") && \
    curl -fsSL "https://go.dev/dl/go${D}{GO_VERSION}.linux-${D}{ARCH}.tar.gz" \
        | tar -xz -C /usr/local && \
    echo 'export PATH=/usr/local/go/bin:$PATH' > /etc/profile.d/go.sh`,
            );
        }
    }

    // ── Layer 8 — Git remote block ──────────────────────────────────────────
    sections.push(
        String.raw`# ---------------------------------------------------------------------------
# Layer 8 — Git remote block
# ---------------------------------------------------------------------------
RUN git config --system protocol.allow never && \
    git config --system protocol.file.allow always`,
    );

    // ── Layer 9 — Global npm tools ──────────────────────────────────────────
    sections.push(
        String.raw`# ---------------------------------------------------------------------------
# Layer 9 — Global npm tools
# ---------------------------------------------------------------------------
RUN npm install -g \
    pnpm \
    @anthropic-ai/claude-code \
    @kilocode/cli \
    opencode-ai \
    && npm cache clean --force`,
    );

    // ── Layer 10 — Non-root user ─────────────────────────────────────────────
    sections.push(
        String.raw`# ---------------------------------------------------------------------------
# Layer 10 — Non-root user
# ---------------------------------------------------------------------------
RUN groupadd --gid 1001 devuser && \
    useradd --uid 1001 --gid devuser --shell /bin/bash --create-home devuser

USER devuser
WORKDIR /workspace`,
    );

    // ── Layer 11 — Rust (conditional, installed as devuser) ─────────────────
    if (hasRust) {
        sections.push(
            String.raw`# ---------------------------------------------------------------------------
# Layer 11 — Rust ${rustToolchain} (installed as devuser via rustup)
# ---------------------------------------------------------------------------
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --default-toolchain ${rustToolchain} && \
    /home/devuser/.cargo/bin/rustup component add rustfmt clippy`,
        );
    }

    // ── Layer 12 — Bun (conditional, installed as devuser) ──────────────────
    if (hasBun) {
        if (host.bun) {
            const bunVersion = host.bun;
            sections.push(
                `# ---------------------------------------------------------------------------
# Layer 12 — Bun ${bunVersion} (installed as devuser via official installer)
# ---------------------------------------------------------------------------
ENV BUN_INSTALL_VERSION=${bunVersion}
RUN curl -fsSL https://bun.sh/install | bash`,
            );
        } else {
            sections.push(
                `# ---------------------------------------------------------------------------
# Layer 12 — Bun (installed as devuser via official installer)
# ---------------------------------------------------------------------------
RUN curl -fsSL https://bun.sh/install | bash`,
            );
        }
    }

    // ── Layer 13 — Python user tools (conditional, installed as devuser) ────
    if (hasPython) {
        let pythonLayer = `# ---------------------------------------------------------------------------
# Layer 13 — Python user tools (uv + poetry via pipx)
# ---------------------------------------------------------------------------
RUN pipx install uv && pipx install poetry`;

        if (host.python) {
            pythonLayer += `\nRUN /home/devuser/.local/bin/uv python install ${host.python}`;
        }

        sections.push(pythonLayer);
    }

    // ── Layer 14 — PATH + shell experience ──────────────────────────────────
    const pathComponents: string[] = [];
    if (hasRust) pathComponents.push("/home/devuser/.cargo/bin");
    if (hasBun) pathComponents.push("/home/devuser/.bun/bin");
    pathComponents.push("/home/devuser/.local/bin");
    if (hasGo) pathComponents.push("/usr/local/go/bin");
    // Append existing PATH — use D trick so ${PATH} is literal in the Dockerfile
    const envPathLine = `ENV PATH="${pathComponents.join(":")}:${D}{PATH}"`;

    sections.push(
        envPathLine +
            "\n" +
            String.raw`RUN echo 'export PS1="\[\033[01;32m\][devcontainer]\[\033[00m\] \[\033[01;34m\]\w\[\033[00m\] \$ "' \
        >> /home/devuser/.bashrc && \
    echo 'echo ""' >> /home/devuser/.bashrc && \
    echo "echo \"  Type 'status' to re-run the readiness check.\"" >> /home/devuser/.bashrc && \
    echo 'alias status="node /workspace/.totopo/post-start.mjs"' >> /home/devuser/.bashrc

CMD ["/bin/bash"]`,
    );

    return `${sections.join("\n\n")}\n`;
}
