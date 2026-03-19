// =========================================================================================================================================
// src/core/commands/onboard.ts — First-time setup for a project using totopo
// Invoked by bin/totopo.js when no .totopo/ config is found in the project.
// =========================================================================================================================================

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { box, cancel, confirm, intro, isCancel, log, outro, select } from "@clack/prompts";
import { type RuntimeMode, writeSettings } from "../lib/config.js";
import { detectHostRuntimes } from "../lib/detect-host.js";
import { generateDockerfile } from "../lib/generate-dockerfile.js";
import { selectTools } from "../lib/select-tools.js";

// Returns true if onboarding completed, false if cancelled
export async function run(packageDir: string, repoRoot: string): Promise<boolean> {
    const templatesDir = join(packageDir, "templates");
    const totopoDir = join(repoRoot, ".totopo");
    const projectName = basename(repoRoot);

    // ─── Intro ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    intro("totopo — First-time setup");

    box(`project  : ${projectName}\nlocation : ${totopoDir}`, "No .totopo/ config found — totopo will create it now.", {
        contentAlign: "center",
        titleAlign: "center",
        width: "auto",
        rounded: true,
    });

    const ok = await confirm({ message: "Continue?" });

    if (isCancel(ok) || !ok) {
        cancel("Setup cancelled.");
        return false;
    }

    // ─── Copy templates ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    mkdirSync(totopoDir, { recursive: true });

    cpSync(join(templatesDir, "Dockerfile"), join(totopoDir, "Dockerfile"));
    cpSync(join(templatesDir, "post-start.mjs"), join(totopoDir, "post-start.mjs"));
    cpSync(join(templatesDir, "README.md"), join(totopoDir, "README.md"));

    log.success("Copied config templates to .totopo/");

    // ─── Runtime mode ────────────────────────────────────────────────────────────
    const modeChoice = await select({
        message: "Runtime mode:",
        options: [
            { value: "host-mirror", label: "Host-mirror  (recommended — match your installed runtimes)" },
            { value: "full", label: "Full  (latest stable versions of every tool)" },
        ],
    });

    if (isCancel(modeChoice)) {
        cancel("Setup cancelled.");
        return false;
    }

    const mode = modeChoice as RuntimeMode;
    let selectedTools: string[] = [];

    if (mode === "host-mirror") {
        const hostRuntimes = detectHostRuntimes();
        selectedTools = await selectTools(hostRuntimes);
        const dockerfile = generateDockerfile("host-mirror", templatesDir, selectedTools, hostRuntimes);
        writeFileSync(join(totopoDir, "Dockerfile"), dockerfile);
    }

    writeSettings(totopoDir, { runtimeMode: mode, selectedTools });

    // ─── Commit scope ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const scopeChoice = await select({
        message: "Commit .totopo/ config to git?",
        options: [
            { value: "shared", label: "Shared — commit config files, only .env stays private" },
            { value: "local", label: "Local only — add entire .totopo/ to .gitignore" },
        ],
    });

    if (isCancel(scopeChoice)) {
        cancel("Setup cancelled.");
        return false;
    }

    const commitScope = scopeChoice as "shared" | "local";

    // ─── Create global .env ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // ~/.totopo/.env lives outside all project repos — never mounted into containers, never readable by agents.
    const globalTotopoDir = join(homedir(), ".totopo");
    const globalEnvPath = join(globalTotopoDir, ".env");
    mkdirSync(globalTotopoDir, { recursive: true });
    if (existsSync(globalEnvPath)) {
        log.info(`${globalEnvPath} already exists — leaving it untouched`);
    } else {
        cpSync(join(templatesDir, "env"), globalEnvPath);
        log.success(`Created ${globalEnvPath}`);
    }

    // ─── Gitignore ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const gitignorePath = join(repoRoot, ".gitignore");
    const gitignoreContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : null;

    if (commitScope === "local") {
        const entry = ".totopo/";
        const addition = "\n# totopo — config is local-only for this project\n.totopo/\n";
        if (gitignoreContent?.includes(entry)) {
            log.info(".totopo/ already in .gitignore");
        } else {
            const newContent = gitignoreContent !== null ? gitignoreContent + addition : addition;
            writeFileSync(gitignorePath, newContent);
            log.success("Added .totopo/ to .gitignore");
        }
    } else {
        const agentsEntry = ".totopo/agents/";
        let content = gitignoreContent ?? "";

        if (gitignoreContent?.includes(agentsEntry)) {
            log.info(".totopo/agents/ already in .gitignore");
        } else {
            content += "\n# totopo — agent session data is local only\n.totopo/agents/\n";
            log.success("Added .totopo/agents/ to .gitignore");
        }

        if (content !== (gitignoreContent ?? "")) {
            writeFileSync(gitignorePath, content);
        }
    }

    log.info(`Add API keys to ${globalEnvPath} before starting the container.`);
    outro("Setup complete.");
    return true;
}
