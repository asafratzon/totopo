// =========================================================================================================================================
// src/core/commands/onboard.ts — First-time project setup for totopo v2
// Invoked by bin/totopo.js when no registered project is found in ~/.totopo/projects/
// Returns the registered ProjectContext on success, or null if cancelled.
// =========================================================================================================================================

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cancel, confirm, intro, isCancel, log, outro, select, text } from "@clack/prompts";
import { load as loadYaml } from "js-yaml";
import { type RuntimeMode, writeSettings } from "../lib/config.js";
import { detectHostRuntimes } from "../lib/detect-host.js";
import { generateDockerfile } from "../lib/generate-dockerfile.js";
import type { ProjectContext } from "../lib/project-identity.js";
import { findConflictingProject, registerProject, writeProjectMeta } from "../lib/project-identity.js";
import { selectTools } from "../lib/select-tools.js";

interface TotopoYaml {
    name?: string;
    description?: string;
}

function readTotopoYaml(dir: string): TotopoYaml | null {
    const p = join(dir, "totopo.yaml");
    if (!existsSync(p)) return null;
    try {
        const raw = loadYaml(readFileSync(p, "utf8"));
        if (typeof raw !== "object" || raw === null) return {};
        const obj = raw as Record<string, unknown>;
        const result: TotopoYaml = {};
        if (typeof obj.name === "string") result.name = obj.name;
        if (typeof obj.description === "string") result.description = obj.description;
        return result;
    } catch {
        return null;
    }
}

function buildTotopoYaml(name: string, description: string): string {
    const header = [
        "# totopo.yaml — project anchor",
        "#",
        "# Place this file at your project root to enable one-click onboarding for contributors.",
        "# When a new contributor runs `npx totopo`, totopo reads this file to anchor the project",
        "# root and display a welcome message before prompting for setup.",
        "#",
        '# name        — shown as: "Welcome to <name>."',
        '# description — shown as: "<description>"',
        "#",
        "# Both fields are optional. Omit either to skip it.",
        "",
    ].join("\n");
    const fields = [name ? `name: ${name}` : "", description ? `description: ${description}` : ""].filter(Boolean).join("\n");
    return `${header}${fields}\n`;
}

function tryGetGitRoot(cwd: string): string | null {
    try {
        return execSync("git rev-parse --show-toplevel", { encoding: "utf8", cwd, stdio: "pipe" }).trim();
    } catch {
        return null;
    }
}

function tryGetGitRemote(repoRoot: string): string | undefined {
    try {
        const url = execSync("git remote get-url origin", { encoding: "utf8", cwd: repoRoot, stdio: "pipe" }).trim();
        return url || undefined;
    } catch {
        return undefined;
    }
}

// Returns the registered ProjectContext on success, null if cancelled.
export async function run(packageDir: string, cwd: string): Promise<ProjectContext | null> {
    const templatesDir = join(packageDir, "templates");
    const tildefy = (p: string) => (p.startsWith(homedir()) ? p.replace(homedir(), "~") : p);

    // ─── Detect context ──────────────────────────────────────────────────────────
    const gitRoot = tryGetGitRoot(cwd);
    const searchRoot = gitRoot ?? cwd;
    const totopoYaml = readTotopoYaml(searchRoot);
    const hasAnchor = totopoYaml !== null;

    // ─── Intro ───────────────────────────────────────────────────────────────────
    process.stdout.write("\n");
    intro("totopo · new project");
    process.stdout.write("\n");

    // ─── totopo.yaml found: show welcome message ──────────────────────────────────
    if (hasAnchor && (totopoYaml.name ?? totopoYaml.description)) {
        const parts = [totopoYaml.name ? `Welcome to ${totopoYaml.name}.` : "", totopoYaml.description ?? ""].filter(Boolean);
        log.info(parts.join(" "));
        process.stdout.write("\n");
    }

    // ─── Confirm / choose project root ───────────────────────────────────────────
    let projectRoot: string;

    if (hasAnchor) {
        // totopo.yaml anchors the root — confirm and proceed
        projectRoot = searchRoot;
        const ok = await confirm({ message: `Set up totopo for: ${tildefy(projectRoot)}?` });
        if (isCancel(ok) || !ok) {
            cancel("Setup cancelled.");
            return null;
        }
    } else {
        // Present options: git root / CWD / custom path
        const suggestedRoot = gitRoot ?? cwd;
        type RootOption = { value: string; label: string; hint?: string };
        const options: RootOption[] = [
            { value: suggestedRoot, label: tildefy(suggestedRoot), hint: gitRoot ? "git root" : "current directory" },
        ];
        if (gitRoot !== null && gitRoot !== cwd) {
            options.push({ value: cwd, label: tildefy(cwd), hint: "current directory" });
        }
        options.push({ value: "__custom__", label: "Enter a different path…" });

        const rootChoice = await select({ message: "Project root:", options });

        if (isCancel(rootChoice)) {
            cancel("Setup cancelled.");
            return null;
        }

        if (rootChoice === "__custom__") {
            const customPath = await text({
                message: "Project root path:",
                placeholder: `e.g. ${suggestedRoot}`,
                validate: (v) => {
                    const p = (v ?? "").trim();
                    if (p.length === 0) return "Path cannot be empty";
                    if (!existsSync(p)) return `Directory not found: ${p}`;
                    return undefined;
                },
            });
            if (isCancel(customPath)) {
                cancel("Setup cancelled.");
                return null;
            }
            projectRoot = (customPath as string).trim();
        } else {
            projectRoot = rootChoice as string;
        }
    }

    // ─── Validate: not inside an existing registered project ──────────────────────
    const conflict = findConflictingProject(projectRoot);
    if (conflict) {
        log.error(
            `"${tildefy(projectRoot)}" is already inside a registered totopo project:\n` +
                `  ${tildefy(conflict.meta.projectRoot)}\n\n` +
                `  Run \`npx totopo\` from that directory instead.`,
        );
        cancel("Setup cancelled.");
        return null;
    }

    // ─── Non-git warning ─────────────────────────────────────────────────────────
    const projectGitRoot = tryGetGitRoot(projectRoot);
    const isNonGit = projectGitRoot === null;

    if (isNonGit) {
        log.warn("No version control detected. Agent changes won't be tracked.");
        const ack = await confirm({ message: "Continue without git?" });
        if (isCancel(ack) || !ack) {
            cancel("Setup cancelled.");
            return null;
        }
    }

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
        return null;
    }

    const mode = modeChoice as RuntimeMode;
    let selectedTools: string[] = [];

    // ─── Tool selection (host-mirror only) ────────────────────────────────────────
    if (mode === "host-mirror") {
        const hostRuntimes = detectHostRuntimes();
        selectedTools = await selectTools(hostRuntimes);
    }

    // ─── Shared or local? ────────────────────────────────────────────────────────
    const scopeChoice = await select({
        message: "Share setup with other contributors?",
        options: [
            { value: "shared", label: "Shared — create totopo.yaml in the project root" },
            { value: "local", label: "Local only — keep config entirely in ~/.totopo/" },
        ],
    });

    if (isCancel(scopeChoice)) {
        cancel("Setup cancelled.");
        return null;
    }

    const commitScope = scopeChoice as "shared" | "local";

    // ─── Create global .env if needed ────────────────────────────────────────────
    const globalTotopoDir = join(homedir(), ".totopo");
    const globalEnvPath = join(globalTotopoDir, ".env");
    mkdirSync(globalTotopoDir, { recursive: true });
    if (existsSync(globalEnvPath)) {
        log.info(`${tildefy(globalEnvPath)} already exists — leaving it untouched`);
    } else {
        cpSync(join(templatesDir, "env"), globalEnvPath);
        log.success(`Created ${tildefy(globalEnvPath)}`);
    }

    // ─── Register project in ~/.totopo/projects/<id>/ ──────────────────────────────
    const gitRemoteUrl = projectGitRoot !== null ? tryGetGitRemote(projectGitRoot) : undefined;
    const ctx = registerProject(projectRoot, gitRemoteUrl);

    if (isNonGit) {
        writeProjectMeta(ctx.id, { ...ctx.meta, nonGitWarningAcknowledged: true });
        ctx.meta.nonGitWarningAcknowledged = true;
    }

    // ─── Generate Dockerfile → ~/.totopo/projects/<id>/Dockerfile ─────────────────
    if (mode === "host-mirror") {
        const hostRuntimes = detectHostRuntimes();
        const dockerfile = generateDockerfile("host-mirror", templatesDir, selectedTools, hostRuntimes);
        writeFileSync(join(ctx.projectDir, "Dockerfile"), dockerfile);
    } else {
        cpSync(join(templatesDir, "Dockerfile"), join(ctx.projectDir, "Dockerfile"));
    }

    // ─── Copy post-start.mjs → ~/.totopo/projects/<id>/post-start.mjs ─────────────
    cpSync(join(templatesDir, "post-start.mjs"), join(ctx.projectDir, "post-start.mjs"));
    log.success(`Config written to ${tildefy(ctx.projectDir)}`);

    // ─── Write settings ───────────────────────────────────────────────────────────
    writeSettings(ctx.projectDir, { runtimeMode: mode, selectedTools });

    // ─── Create totopo.yaml (shared mode only) ────────────────────────────────────
    if (commitScope === "shared") {
        const totopoYamlPath = join(projectRoot, "totopo.yaml");
        if (!existsSync(totopoYamlPath)) {
            const wantsMeta = await confirm({ message: "Add a name/description to totopo.yaml?", initialValue: false });
            let nameStr = "";
            let descStr = "";

            if (!isCancel(wantsMeta) && wantsMeta) {
                const nameInput = await text({
                    message: "Project name (optional):",
                    placeholder: `e.g. ${basename(projectRoot)}`,
                });
                if (!isCancel(nameInput)) nameStr = (nameInput as string).trim();

                const descInput = await text({
                    message: "Short description (optional):",
                    placeholder: "e.g. Our AI coding sandbox",
                });
                if (!isCancel(descInput)) descStr = (descInput as string).trim();
            }

            writeFileSync(totopoYamlPath, buildTotopoYaml(nameStr, descStr));
            log.success(`Created ${tildefy(totopoYamlPath)}`);
        }
    }

    log.info(`Optionally add API keys to ${tildefy(globalEnvPath)} — they are injected into every totopo container at runtime.`);
    outro("Setup complete.");
    return ctx;
}

// ─── Add project anchor (for projects onboarded as local-only) ────────────────
// Creates totopo.yaml at the project root, prompting for optional name/description.
export async function addProjectAnchor(ctx: ProjectContext): Promise<void> {
    const tildefy = (p: string) => (p.startsWith(homedir()) ? p.replace(homedir(), "~") : p);
    const totopoYamlPath = join(ctx.meta.projectRoot, "totopo.yaml");

    if (existsSync(totopoYamlPath)) {
        log.info(`${tildefy(totopoYamlPath)} already exists.`);
        return;
    }

    const wantsMeta = await confirm({ message: "Add a name/description to totopo.yaml?", initialValue: false });
    let nameStr = "";
    let descStr = "";

    if (!isCancel(wantsMeta) && wantsMeta) {
        const nameInput = await text({
            message: "Project name (optional):",
            placeholder: `e.g. ${ctx.meta.displayName}`,
        });
        if (!isCancel(nameInput)) nameStr = (nameInput as string).trim();

        const descInput = await text({
            message: "Short description (optional):",
            placeholder: "e.g. Our AI coding sandbox",
        });
        if (!isCancel(descInput)) descStr = (descInput as string).trim();
    }

    writeFileSync(totopoYamlPath, buildTotopoYaml(nameStr, descStr));
    log.success(`Created ${tildefy(totopoYamlPath)}`);
}
