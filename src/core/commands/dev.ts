#!/usr/bin/env node
// =========================================================================================================================================
// src/core/commands/dev.ts — Start the dev container and connect via docker exec
// Invoked by bin/totopo.js — do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { cancel, groupMultiselect, isCancel, log, multiselect, outro, path, select } from "@clack/prompts";

// biome-ignore lint/style/noNonNullAssertion: guarded immediately below; non-null assertion needed for closure type inference
const workspaceDir = process.env.TOTOPO_REPO_ROOT!;
if (!workspaceDir) {
    log.error("TOTOPO_REPO_ROOT not set — run via npx totopo");
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
// Recursively expands a selected path into its children when a nested exclusion target is found,
// until the excluded path itself can be dropped from the list.
function expandExclusion(paths: string[], excl: string): string[] {
    if (paths.includes(excl)) {
        return paths.filter((p) => p !== excl);
    }
    const ancestor = paths.find((p) => excl.startsWith(`${p}/`));
    if (!ancestor) {
        log.warn(`Cannot exclude "${excl}" — it is not within any selected path. Skipping.`);
        return paths;
    }
    const children = readdirSync(join(cwd, ancestor)).map((child) => `${ancestor}/${child}`);
    const withoutAncestor = paths.filter((p) => p !== ancestor);
    return expandExclusion([...withoutAncestor, ...children], excl);
}

function scanCwdDepth2(): { dirs: Record<string, string[]>; files: string[] } {
    const dirs: Record<string, string[]> = {};
    const files: string[] = [];

    for (const item of readdirSync(cwd)) {
        const itemPath = join(cwd, item);
        if (statSync(itemPath).isDirectory()) {
            const children = readdirSync(itemPath).map((child) => `${item}/${child}`);
            if (children.length === 0) {
                files.push(item); // empty dir → treat as flat item
            } else {
                dirs[item] = children;
            }
        } else {
            files.push(item);
        }
    }

    return { dirs, files };
}

function normalizeSelection(selected: string[], dirs: Record<string, string[]>): string[] {
    const selectedSet = new Set(selected);
    const result: string[] = [];

    for (const [dir, children] of Object.entries(dirs)) {
        const selectedChildren = children.filter((c) => selectedSet.has(c));
        if (selectedChildren.length === children.length) {
            result.push(dir); // all children selected → mount whole dir efficiently
        } else {
            result.push(...selectedChildren);
        }
    }

    // Root files (no slash)
    result.push(...selected.filter((s) => !s.includes("/")));

    return result;
}

async function promptSelectivePaths(): Promise<string[]> {
    const allItems = readdirSync(cwd);

    if (allItems.length === 0) {
        log.warn("No files/folders in current directory — falling back to cwd mode.");
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
    const { dirs, files } = scanCwdDepth2();
    const dirNames = Object.keys(dirs);

    // ── flat fallback when there are no dirs ──────────────────────────────────
    if (dirNames.length === 0) {
        const flatSelected = await multiselect({
            message: "Choose paths:",
            options: files.map((f) => ({ value: f, label: f })),
            initialValues: style === "except" ? files : [],
            required: true,
        });

        if (isCancel(flatSelected)) {
            cancel("Cancelled.");
            process.exit(0);
        }

        return flatSelected as string[];
    }

    // ── build groupMultiselect options ────────────────────────────────────────
    const groupOptions: Record<string, { value: string; label: string }[]> = {};
    for (const [dir, children] of Object.entries(dirs)) {
        groupOptions[dir] = children.map((child) => ({
            value: child,
            label: child.slice(child.indexOf("/") + 1),
        }));
    }
    if (files.length > 0) {
        groupOptions.Files = files.map((f) => ({ value: f, label: f }));
    }

    // "except" → pre-select all depth-2 children + root files
    const initialValues = style === "except" ? [...Object.values(dirs).flat(), ...files] : [];

    const rawSelected = await groupMultiselect({
        message: "Choose paths:",
        options: groupOptions,
        initialValues,
        required: true,
        selectableGroups: true,
    });

    if (isCancel(rawSelected)) {
        cancel("Cancelled.");
        process.exit(0);
    }

    const selected = normalizeSelection(rawSelected as string[], dirs);

    // ── path prompt loop for depth-3+ targets ────────────────────────────────
    // Repeats until the user presses Enter on an empty input.
    let result = selected;
    const promptMsg =
        style === "only" ? "Add a deeper path to include (press Enter to finish):" : "Exclude a deeper path (press Enter to finish):";

    while (true) {
        const deepPathRaw = await path({
            message: promptMsg,
            root: cwd,
            validate: (value) => {
                if (!value) return undefined; // empty = done, always valid
                const relative = value.startsWith(`${cwd}/`) ? value.slice(cwd.length + 1) : value;
                if (!relative) return "Path cannot be empty.";
                if (!existsSync(join(cwd, relative))) return `Path not found: ${relative}`;
                return undefined;
            },
        });

        if (isCancel(deepPathRaw)) {
            cancel("Cancelled.");
            process.exit(0);
        }

        const deepPathAbsolute = deepPathRaw as string;
        if (!deepPathAbsolute) break; // user skipped — done

        const deepPath = deepPathAbsolute.startsWith(`${cwd}/`) ? deepPathAbsolute.slice(cwd.length + 1) : deepPathAbsolute;

        if (!deepPath) break;

        if (style === "only") {
            result = [...new Set([...result, deepPath])];
        } else {
            result = expandExclusion(result, deepPath);
        }
    }

    return result;
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
