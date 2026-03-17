#!/usr/bin/env node
// =========================================================================================================================================
// scripts/dev.ts — Start the dev container and connect via docker exec
// Called by ai.sh — do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { cancel, isCancel, log, multiselect, outro, select } from "@clack/prompts";

// biome-ignore lint/style/noNonNullAssertion: guarded immediately below; non-null assertion needed for closure type inference
const workspaceDir = process.env.TOTOPO_REPO_ROOT!;
if (!workspaceDir) {
    log.error("TOTOPO_REPO_ROOT not set — run via ai.sh");
    process.exit(1);
}

const cwd = process.cwd();
const projectName = basename(workspaceDir);
const containerName = `totopo-managed-${projectName}`;
const imageName = `totopo-managed-${projectName}`;
const totopoDir = join(workspaceDir, ".totopo");

// ─── Types ────────────────────────────────────────────────────────────────────
type WorkspaceScope = "repo" | "cwd" | "selective";
interface ScopeConfig {
    mode: WorkspaceScope;
    hostCwd: string;
    selectedPaths: string[]; // relative names; empty for repo/cwd
}

// ─── Prompt: scope selection ──────────────────────────────────────────────────
async function promptScope(): Promise<ScopeConfig> {
    const cwdIsRepo = cwd === workspaceDir;

    const options = [
        { value: "repo", label: "Repo root  (full repository)" },
        ...(!cwdIsRepo ? [{ value: "cwd", label: "Current directory  (this folder only)" }] : []),
        { value: "selective", label: "Selective  (choose specific files/folders)" },
    ];

    const modeChoice = await select({
        message: "Workspace scope:",
        options,
    });

    if (isCancel(modeChoice)) {
        cancel("Cancelled.");
        process.exit(0);
    }

    const mode = modeChoice as WorkspaceScope;

    if (mode === "selective") {
        const selectedPaths = await promptSelectivePaths();
        if (selectedPaths.length === 0) {
            // Fallback to cwd mode when no visible items exist
            return { mode: "cwd", hostCwd: cwd, selectedPaths: [] };
        }
        return { mode, hostCwd: cwd, selectedPaths };
    }

    return { mode, hostCwd: cwd, selectedPaths: [] };
}

// ─── Prompt: selective path selection ─────────────────────────────────────────
async function promptSelectivePaths(): Promise<string[]> {
    const allItems = readdirSync(cwd).filter((f) => !f.startsWith("."));

    if (allItems.length === 0) {
        log.warn("No visible files/folders in current directory — falling back to cwd mode.");
        return [];
    }

    const styleChoice = await select({
        message: "Select by:",
        options: [
            { value: "only", label: "Only the following..." },
            { value: "except", label: "All except for..." },
        ],
    });

    if (isCancel(styleChoice)) {
        cancel("Cancelled.");
        process.exit(0);
    }

    const style = styleChoice as "only" | "except";
    const initialValues = style === "except" ? allItems : [];

    const selected = await multiselect({
        message: "Choose paths:",
        options: allItems.map((item) => ({ value: item, label: item })),
        initialValues,
        required: true,
    });

    if (isCancel(selected)) {
        cancel("Cancelled.");
        process.exit(0);
    }

    return selected as string[];
}

// ─── Totopo mount path inside container ──────────────────────────────────────
// For repo scope (or cwd at repo root), .totopo is naturally inside /workspace.
// For cwd/selective with a nested dir, we mount it outside /workspace to avoid
// Docker creating an empty .totopo directory on the host as a mount point.
function getTotopoMountPath(scope: ScopeConfig): string {
    if (scope.mode === "repo") return "/workspace/.totopo";
    if (scope.mode === "cwd" && scope.hostCwd === workspaceDir) return "/workspace/.totopo";
    return "/home/devuser/.totopo";
}

// ─── Build mount args ─────────────────────────────────────────────────────────
function buildMountArgs(scope: ScopeConfig): string[] {
    const totopoMount = getTotopoMountPath(scope);

    if (scope.mode === "repo") {
        return ["-v", `${workspaceDir}:/workspace`];
    }

    if (scope.mode === "cwd") {
        return ["-v", `${cwd}:/workspace`, ...(cwd !== workspaceDir ? ["-v", `${totopoDir}:${totopoMount}:ro`] : [])];
    }

    // selective: validate all paths exist first
    for (const p of scope.selectedPaths) {
        const hostPath = join(cwd, p);
        if (!existsSync(hostPath)) {
            log.error(`Selected path does not exist: ${hostPath}`);
            process.exit(1);
        }
    }

    return [...scope.selectedPaths.flatMap((p) => ["-v", `${join(cwd, p)}:/workspace/${p}`]), "-v", `${totopoDir}:${totopoMount}:ro`];
}

// ─── Build scope env args ─────────────────────────────────────────────────────
function buildScopeEnvArgs(scope: ScopeConfig): string[] {
    return [
        "-e",
        `TOTOPO_SCOPE=${scope.mode}`,
        "-e",
        `TOTOPO_HOST_CWD=${scope.hostCwd}`,
        "-e",
        `TOTOPO_SELECTIVE_PATHS=${JSON.stringify(scope.selectedPaths)}`,
    ];
}

// ─── Build scope label args ───────────────────────────────────────────────────
function buildScopeLabelArgs(scope: ScopeConfig): string[] {
    return [
        "--label",
        `totopo.scope=${scope.mode}`,
        "--label",
        `totopo.scope.cwd=${scope.hostCwd}`,
        "--label",
        `totopo.scope.paths=${JSON.stringify(scope.selectedPaths)}`,
    ];
}

// ─── Read container scope label ───────────────────────────────────────────────
function readContainerScopeLabel(name: string): ScopeConfig | null {
    const result = spawnSync(
        "docker",
        [
            "inspect",
            "--format",
            '{{index .Config.Labels "totopo.scope"}}|{{index .Config.Labels "totopo.scope.cwd"}}|{{index .Config.Labels "totopo.scope.paths"}}',
            name,
        ],
        { encoding: "utf8", stdio: "pipe" },
    );

    if (result.status !== 0) return null;

    const parts = result.stdout.trim().split("|");
    const mode = parts[0];
    const hostCwd = parts[1];
    const pathsJson = parts[2] ?? "[]";

    if (!mode || !hostCwd) return null;

    let selectedPaths: string[] = [];
    try {
        selectedPaths = JSON.parse(pathsJson);
    } catch {
        // leave empty
    }

    return { mode: mode as WorkspaceScope, hostCwd, selectedPaths };
}

// ─── Scope comparison ─────────────────────────────────────────────────────────
// null existing scope (pre-feature container) is treated as repo mode.
function scopesMatch(selected: ScopeConfig, existing: ScopeConfig | null): boolean {
    const eff = existing ?? { mode: "repo" as WorkspaceScope, hostCwd: workspaceDir, selectedPaths: [] };
    if (selected.mode !== eff.mode) return false;
    if (selected.mode === "repo") return true;
    if (selected.hostCwd !== eff.hostCwd) return false;
    if (selected.mode === "selective") {
        return JSON.stringify([...selected.selectedPaths].sort()) === JSON.stringify([...eff.selectedPaths].sort());
    }
    return true;
}

// ─── Build agent context document ─────────────────────────────────────────────
// Designed for future extension: also inject AGENTS.md alongside CLAUDE.md.
function buildAgentContextDoc(scope: ScopeConfig): string {
    let scopeSection: string;

    if (scope.mode === "repo") {
        scopeSection = `## Workspace scope: repo

You are running inside a totopo dev container. The full repository is accessible at \`/workspace\`. Some operations (git push, system-level changes) require running on the host.`;
    } else if (scope.mode === "cwd") {
        scopeSection = `## Workspace scope: cwd

Workspace is scoped to one directory (\`${scope.hostCwd}\`). Files outside it are not visible. Commands that depend on absent files will fail.`;
    } else {
        const pathList = scope.selectedPaths.map((p) => `- \`/workspace/${p}\``).join("\n");
        scopeSection = `## Workspace scope: selective

Workspace is selectively scoped. The following paths are mounted:\n\n${pathList}`;
    }

    const constraintsSection = `## Constraints

- Files outside mounted paths cannot be read, written, or executed.
- If a command fails because of missing files, tell the user: "I have limited workspace scope — please run \`<command>\` on the host."
- This file (\`~/.claude/CLAUDE.md\`) is container-generated. Edits will not persist to the host.
- \`.totopo/\` is read-only inside the container.`;

    const repoClaudeMdPath = join(workspaceDir, "CLAUDE.md");
    const baseContent = existsSync(repoClaudeMdPath) ? readFileSync(repoClaudeMdPath, "utf8").trim() : null;

    const parts = ["# totopo Workspace Context\n\nYou are running inside a totopo dev container.\n", scopeSection, constraintsSection];

    if (baseContent) {
        parts.push("---\n", baseContent);
    }

    return `${parts.join("\n\n")}\n`;
}

// ─── Inject agent context into container ──────────────────────────────────────
function injectAgentContext(name: string, content: string): void {
    const tmpPath = join(tmpdir(), `totopo-claude-md-${Date.now()}.md`);
    writeFileSync(tmpPath, content);
    spawnSync("docker", ["exec", name, "mkdir", "-p", "/home/devuser/.claude"]);
    spawnSync("docker", ["cp", tmpPath, `${name}:/home/devuser/.claude/CLAUDE.md`]);
    unlinkSync(tmpPath);
}

// ─── Run post-start ───────────────────────────────────────────────────────────
function runPostStart(name: string, totopoMountPath: string): void {
    log.step("Running post-start checks...");
    const postStart = spawnSync("docker", ["exec", name, "node", `${totopoMountPath}/post-start.mjs`], {
        stdio: "inherit",
    });
    if (postStart.status !== 0) {
        outro("Post-start checks failed.");
        process.exit(postStart.status ?? 1);
    }
}

// ─── Remove container ─────────────────────────────────────────────────────────
function removeContainer(name: string): void {
    spawnSync("docker", ["stop", name], { stdio: "pipe" });
    spawnSync("docker", ["rm", name], { stdio: "pipe" });
}

// ─── Run container ────────────────────────────────────────────────────────────
function runContainer(scope: ScopeConfig): void {
    const run = spawnSync(
        "docker",
        [
            "run",
            "-d",
            "--name",
            containerName,
            ...buildMountArgs(scope),
            "--env-file",
            `${workspaceDir}/.totopo/.env`,
            ...buildScopeEnvArgs(scope),
            ...buildScopeLabelArgs(scope),
            "--security-opt",
            "no-new-privileges:true",
            imageName,
            "sleep",
            "infinity",
        ],
        { stdio: "inherit" },
    );
    if (run.status !== 0) {
        outro("Failed to start dev container.");
        process.exit(run.status ?? 1);
    }
}

// ─── Always prompt scope first ────────────────────────────────────────────────
const scope = await promptScope();

// ─── Inspect container state ──────────────────────────────────────────────────
const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", containerName], {
    encoding: "utf8",
    stdio: "pipe",
});

const containerStatus = inspect.status === 0 ? inspect.stdout.trim() : null;

if (containerStatus === null) {
    // ─── No container — build image and run ───────────────────────────────────
    log.step("Building container image...");
    const build = spawnSync("docker", ["build", "-f", `${workspaceDir}/.totopo/Dockerfile`, "-t", imageName, workspaceDir], {
        stdio: "inherit",
    });
    if (build.status !== 0) {
        outro("Failed to build container image.");
        process.exit(build.status ?? 1);
    }

    const totopoMountPath = getTotopoMountPath(scope);
    log.step("Starting dev container...");
    runContainer(scope);
    log.step("Injecting agent context...");
    injectAgentContext(containerName, buildAgentContextDoc(scope));
    runPostStart(containerName, totopoMountPath);
} else if (containerStatus === "exited") {
    // ─── Container stopped — resume or recreate based on scope ────────────────
    const existingScope = readContainerScopeLabel(containerName);
    const totopoMountPath = getTotopoMountPath(scope);

    if (scopesMatch(scope, existingScope)) {
        log.step("Resuming dev container...");
        const start = spawnSync("docker", ["start", containerName], { stdio: "inherit" });
        if (start.status !== 0) {
            outro("Failed to start dev container.");
            process.exit(start.status ?? 1);
        }
        log.step("Injecting agent context...");
        injectAgentContext(containerName, buildAgentContextDoc(scope));
        runPostStart(containerName, totopoMountPath);
    } else {
        log.step("Recreating dev container with new scope...");
        removeContainer(containerName);
        runContainer(scope);
        log.step("Injecting agent context...");
        injectAgentContext(containerName, buildAgentContextDoc(scope));
        runPostStart(containerName, totopoMountPath);
    }
} else {
    // ─── Container running — connect directly or recreate based on scope ──────
    const existingScope = readContainerScopeLabel(containerName);

    if (scopesMatch(scope, existingScope)) {
        // same scope — connect directly
    } else {
        const totopoMountPath = getTotopoMountPath(scope);
        log.step("Recreating dev container with new scope...");
        removeContainer(containerName);
        runContainer(scope);
        log.step("Injecting agent context...");
        injectAgentContext(containerName, buildAgentContextDoc(scope));
        runPostStart(containerName, totopoMountPath);
    }
}

// ─── Connect ──────────────────────────────────────────────────────────────────
const exec = spawnSync("docker", ["exec", "-it", "-w", "/workspace", containerName, "bash", "--login"], {
    stdio: "inherit",
});

process.exit(exec.status ?? 0);
