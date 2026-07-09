// =========================================================================================================================================
// src/lib/dockerfile-builder.ts - In-memory Dockerfile assembly and temp-file build
// Combines base template + profile hook + USER instruction at build time
// =========================================================================================================================================

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spinner } from "@clack/prompts";
import { CONTAINER_HOME, CONTAINER_NAME_PREFIX, CONTAINER_STARTUP, CONTAINER_USER, LABEL_BUILD_HASH, LABEL_MANAGED } from "./constants.js";

// --- User shell config appended after USER instruction -----------------------------------------------------------------------------------

const USER_SHELL_CONFIG = `
# ---------------------------------------------------------------------------
# User shell config (PATH, prompt, welcome message, status alias)
# ---------------------------------------------------------------------------
ENV PATH="${CONTAINER_HOME}/.cargo/bin:${CONTAINER_HOME}/.bun/bin:${CONTAINER_HOME}/.local/bin:/usr/local/go/bin:\${PATH}"
# Prompt helper: print the working directory relative to the workspace root, so /workspace shows as
# "/" and /workspace/src shows as "/src". Paths outside the workspace fall back to their full path.
RUN echo '__totopo_pwd() { local p="\${PWD#/workspace}"; printf "/%s" "\${p#/}"; }' >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'export PS1="\\[\\033[01;32m\\][totopo@\${TOTOPO_WORKSPACE}]\\[\\033[00m\\] \\[\\033[01;34m\\]\\$(__totopo_pwd)\\[\\033[00m\\] \\[\\033[01;32m\\]❯\\[\\033[00m\\] "' \\
        >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'echo ""' >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'echo -e "\\033[32m●\\033[0m  \\033[1mYou'"'"'re now in a totopo sandbox\\033[0m \\033[90m·\\033[0m \\033[1m\${TOTOPO_WORKSPACE}\\033[0m"' >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'echo ""' >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'echo -e "   \\033[90m▸ Run \\033[38;5;208mclaude\\033[90m, \\033[38;5;208mopencode\\033[90m, or \\033[38;5;208mcodex\\033[90m to start an agent.\\033[0m"' >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'echo -e "   \\033[90m▸ Run \\033[97mstatus\\033[90m to see container details & installed versions.\\033[0m"' >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'echo -e "   \\033[90m▸ Run \\033[97mexit\\033[90m to end the session and return to the host.\\033[0m"' >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'echo ""' >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'alias status="node ${CONTAINER_STARTUP}"' >> ${CONTAINER_HOME}/.bashrc && \\
    echo '' >> ${CONTAINER_HOME}/.bashrc && \\
    echo '# Auto-start the configured agent. TOTOPO_AUTOSTART is set by docker run when the host-global setting is on.' >> ${CONTAINER_HOME}/.bashrc && \\
    echo '# The exported TOTOPO_AUTOSTARTED guard makes nested shells and the post-exit shell skip relaunching.' >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'if [ -n "$TOTOPO_AUTOSTART" ] && [ -z "$TOTOPO_AUTOSTARTED" ]; then' >> ${CONTAINER_HOME}/.bashrc && \\
    echo '    export TOTOPO_AUTOSTARTED=1' >> ${CONTAINER_HOME}/.bashrc && \\
    echo '    echo -e "\\033[32m●\\033[0m  \\033[90mAuto-start enabled: launching \\033[38;5;208m\${TOTOPO_AUTOSTART}\\033[90m.\\033[0m"' >> ${CONTAINER_HOME}/.bashrc && \\
    echo '    echo ""' >> ${CONTAINER_HOME}/.bashrc && \\
    echo '    "$TOTOPO_AUTOSTART"' >> ${CONTAINER_HOME}/.bashrc && \\
    echo 'fi' >> ${CONTAINER_HOME}/.bashrc

CMD ["/bin/bash"]
`;

// --- Build Dockerfile content ------------------------------------------------------------------------------------------------------------

/**
 * Assemble a Dockerfile from the base template, optional profile hook, and USER instruction.
 * The resulting Dockerfile is never persisted - it's written to a temp file at build time.
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

// --- Build hash for image staleness detection --------------------------------------------------------------------------------------------

// Filenames (relative to the templates dir) of every artifact that the Dockerfile bakes into the image
// via COPY. Edits to any of these change the build hash and trigger a rebuild prompt at session start.
// Kept in sync with templates/Dockerfile by the bidirectional test in tests/dockerfile-builder.test.ts.
export const BAKED_TEMPLATE_FILES: ReadonlyArray<string> = [
    "claude-statusline.sh",
    "git-readonly-wrapper.mjs",
    "npmrc",
    "pnpm-config.yaml",
    "runtime-constants.mjs",
    "startup-git-mode.mjs",
    "startup.mjs",
];

/**
 * Fingerprint everything the package contributes to the image: the assembled Dockerfile content
 * plus every file in BAKED_TEMPLATE_FILES, hashed in deterministic order.
 *
 * Tolerates missing files in buildContextDir. In production (real package install) all baked files
 * exist, so the existsSync branch never fires. In tests that build minimal images from a temp
 * contextDir, missing files naturally produce a different hash than production - exactly the
 * contract the staleness tests rely on.
 */
export function computeBuildHash(dockerfileContent: string, buildContextDir: string): string {
    const h = createHash("sha256");
    h.update("dockerfile:\n");
    h.update(dockerfileContent);
    for (const name of [...BAKED_TEMPLATE_FILES].sort()) {
        h.update(`\nfile:${name}\n`);
        const path = join(buildContextDir, name);
        if (existsSync(path)) {
            h.update(readFileSync(path));
        }
    }
    return h.digest("hex");
}

// --- Build image with temp file ----------------------------------------------------------------------------------------------------------

// Grey ANSI for the inline build percentage on the spinner line.
const grey = (s: string): string => `\x1b[90m${s}\x1b[0m`;

/**
 * Run docker build behind a single clack spinner for interactive sessions.
 * All raw buildx output is captured, never streamed. BuildKit "[ n/N ]" step markers (from
 * --progress=plain) are parsed into a grey percentage on the spinner line when available; if nothing
 * parses, the spinner just keeps animating with the plain text. The captured log is written to stderr
 * only on failure, so a broken build stays diagnosable.
 */
function runBuildWithSpinner(buildArgs: string[]): Promise<{ status: number }> {
    return new Promise((resolve) => {
        const s = spinner();
        const baseMessage = "Docker rebuilding container..";
        s.start(baseMessage);

        let captured = "";
        let lastStep = 0;
        let totalSteps = 0;

        const onData = (chunk: Buffer): void => {
            const text = chunk.toString();
            captured += text;
            try {
                for (const m of text.matchAll(/\[\s*(\d+)\/(\d+)\]/g)) {
                    const cur = Number(m[1]);
                    const total = Number(m[2]);
                    if (total > 0) totalSteps = total;
                    if (cur > lastStep) lastStep = cur;
                }
                if (totalSteps > 0) {
                    const pct = Math.min(100, Math.round((lastStep / totalSteps) * 100));
                    s.message(`${baseMessage}  ${grey(`${pct}%`)}`);
                }
            } catch {
                // Parsing must never affect the build; fall back to the plain animated spinner.
            }
        };

        const child = spawn("docker", buildArgs, { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
            s.stop("Docker build failed");
            process.stderr.write(`${err.message}\n`);
            resolve({ status: 1 });
        });

        child.on("close", (code) => {
            const status = code ?? 1;
            if (status === 0) {
                s.stop("Container image ready");
            } else {
                s.stop("Docker build failed");
                process.stderr.write(captured);
            }
            resolve({ status });
        });
    });
}

/**
 * Write Dockerfile content to a temp file, run docker build, then clean up.
 * Build context is always the templates directory so COPY instructions resolve correctly.
 * Quiet mode (tests) runs synchronously with captured output; interactive mode shows a spinner.
 */
export async function buildImageWithTempfile(
    dockerfileContent: string,
    buildContextDir: string,
    imageName: string,
    noCache = false,
    quiet = false,
): Promise<{ status: number }> {
    const tmpFile = join(tmpdir(), `${CONTAINER_NAME_PREFIX}Dockerfile-${randomBytes(8).toString("hex")}`);

    try {
        writeFileSync(tmpFile, dockerfileContent);
        const buildHash = computeBuildHash(dockerfileContent, buildContextDir);
        const buildArgs = [
            "build",
            "--label",
            `${LABEL_MANAGED}=true`,
            "--label",
            `${LABEL_BUILD_HASH}=${buildHash}`,
            "-f",
            tmpFile,
            "-t",
            imageName,
        ];
        if (noCache) buildArgs.push("--no-cache");

        // Quiet mode (tests): synchronous, output captured, no spinner.
        if (quiet) {
            buildArgs.push(buildContextDir);
            const result = spawnSync("docker", buildArgs, { stdio: "pipe" });
            return { status: result.status ?? 1 };
        }

        // Interactive mode: line-oriented progress so step markers are parseable, hidden behind a spinner.
        buildArgs.push("--progress=plain", buildContextDir);
        return await runBuildWithSpinner(buildArgs);
    } finally {
        try {
            unlinkSync(tmpFile);
        } catch {
            // temp file cleanup is best-effort
        }
    }
}
