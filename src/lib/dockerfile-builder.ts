// =========================================================================================================================================
// src/lib/dockerfile-builder.ts - In-memory Dockerfile assembly and temp-file build
// Combines base template + profile hook + USER instruction at build time
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER_HOME, CONTAINER_NAME_PREFIX, CONTAINER_STARTUP, CONTAINER_USER, LABEL_MANAGED } from "./constants.js";

// --- User shell config appended after USER instruction -----------------------------------------------------------------------------------

const USER_SHELL_CONFIG = `
# ---------------------------------------------------------------------------
# User shell config (PATH, prompt, welcome message, status alias)
# ---------------------------------------------------------------------------
ENV PATH="${CONTAINER_HOME}/.cargo/bin:${CONTAINER_HOME}/.bun/bin:${CONTAINER_HOME}/.local/bin:/usr/local/go/bin:\${PATH}"
RUN echo 'export PS1="\\[\\033[01;32m\\][devcontainer]\\[\\033[00m\\] \\[\\033[01;34m\\]\\w\\[\\033[00m\\] \\$ "' \\
        >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'echo ""' >> ${CONTAINER_HOME}/.bashrc && \\
    echo "echo \\"  Run 'opencode', 'claude', or 'codex' to start an agent.\\"" >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'echo ""' >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'alias status="node ${CONTAINER_STARTUP}"' >> ${CONTAINER_HOME}/.bashrc

CMD ["/bin/bash"]
`;

// --- Build Dockerfile content ------------------------------------------------------------------------------------------------------------

/**
 * Assemble a Dockerfile from the base template, optional profile hook, and USER instruction.
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

    // USER must come after profile hook and before shell config
    content += `\nUSER ${CONTAINER_USER}\n`;
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
    const tmpFile = join(tmpdir(), `${CONTAINER_NAME_PREFIX}Dockerfile-${randomBytes(8).toString("hex")}`);

    try {
        writeFileSync(tmpFile, dockerfileContent);
        const buildArgs = ["build", "--label", `${LABEL_MANAGED}=true`, "-f", tmpFile, "-t", imageName];
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
