// =========================================================================================================================================
// src/lib/dockerfile-builder.ts - In-memory Dockerfile assembly and temp-file build
// Combines base template + profile hook + USER devuser at build time
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- User shell config appended after USER devuser ---------------------------------------------------------------------------------------

const USER_SHELL_CONFIG = `
# ---------------------------------------------------------------------------
# User shell config (PATH, prompt, welcome message, status alias)
# ---------------------------------------------------------------------------
ENV PATH="/home/devuser/.cargo/bin:/home/devuser/.bun/bin:/home/devuser/.local/bin:/usr/local/go/bin:\${PATH}"
RUN echo 'export PS1="\\[\\033[01;32m\\][devcontainer]\\[\\033[00m\\] \\[\\033[01;34m\\]\\w\\[\\033[00m\\] \\$ "' \\
        >> /home/devuser/.bashrc && \\
    echo 'echo ""' >> /home/devuser/.bashrc && \\
    echo "echo \\"  Run 'opencode', 'claude', or 'codex' to start an agent.\\"" >> /home/devuser/.bashrc && \\
    echo 'echo ""' >> /home/devuser/.bashrc && \\
    echo 'alias status="node /home/devuser/post-start.mjs"' >> /home/devuser/.bashrc

CMD ["/bin/bash"]
`;

// --- Build Dockerfile content ------------------------------------------------------------------------------------------------------------

/**
 * Assemble a Dockerfile from the base template, optional profile hook, and USER devuser.
 * The resulting Dockerfile is never persisted — it's written to a temp file at build time.
 */
export function buildDockerfile(baseTemplatePath: string, profileHook?: string): string {
    let content = readFileSync(baseTemplatePath, "utf8");

    // Append profile hook if provided
    if (profileHook?.trim()) {
        content += `\n# ---------------------------------------------------------------------------\n`;
        content += `# Profile hook (from totopo.yaml)\n`;
        content += `# ---------------------------------------------------------------------------\n`;
        content += profileHook.endsWith("\n") ? profileHook : `${profileHook}\n`;
    }

    // USER devuser must come after profile hook and before shell config
    content += `\nUSER devuser\n`;
    content += USER_SHELL_CONFIG;

    return content;
}

// --- Build image with temp file ----------------------------------------------------------------------------------------------------------

/**
 * Write Dockerfile content to a temp file, run docker build, then clean up.
 * Build context is always the templates directory so COPY instructions resolve correctly.
 */
export function buildImageWithTempfile(
    dockerfileContent: string,
    buildContextDir: string,
    imageName: string,
    noCache = false,
    quiet = false,
): { status: number } {
    const tmpFile = join(tmpdir(), `totopo-Dockerfile-${randomBytes(8).toString("hex")}`);

    try {
        writeFileSync(tmpFile, dockerfileContent);
        const buildArgs = ["build", "--label", "totopo.managed=true", "-f", tmpFile, "-t", imageName];
        if (noCache) buildArgs.push("--no-cache");
        buildArgs.push(buildContextDir);
        const result = spawnSync("docker", buildArgs, { stdio: quiet ? "pipe" : "inherit" });
        return { status: result.status ?? 1 };
    } finally {
        try {
            unlinkSync(tmpFile);
        } catch {
            // temp file cleanup is best-effort
        }
    }
}
