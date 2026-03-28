// =========================================================================================================================================
// src/commands/dev.ts - Start the dev container and connect via docker exec
// Invoked by bin/totopo.js - do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { cancel, confirm, groupMultiselect, isCancel, log, multiselect, note, outro, path, select } from "@clack/prompts";
import {
    buildAgentContextDocs,
    buildAgentMountArgs,
    injectAgentContext,
    resolveShadowedDirs,
    type ScopeConfig,
    type WorkspaceScope,
} from "../lib/agent-context.js";
import type { ProjectContext } from "../lib/project-identity.js";

// The project config dir is always mounted here inside the container (read-only)
const TOTOPO_CONTAINER_PATH = "/home/devuser/.totopo";

// --- Prompt: scope selection -------------------------------------------------------------------------------------------------------------
async function promptScope(workspaceDir: string, cwd: string): Promise<ScopeConfig> {
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
        const selectedPaths = await promptSelectivePaths(cwd);
        if (selectedPaths.length === 0) {
            // Fallback to cwd mode when no visible items exist
            return { mode: "cwd", hostCwd: cwd, selectedPaths: [] };
        }
        log.warn(
            "Scoped workspace — some context may be unavailable to the agent:\n" +
                "  · Your personal agent config files (~/.claude/CLAUDE.md, ~/.config/opencode/AGENTS.md, etc.)\n" +
                "    are not mounted from the host — only totopo's injected context is available.\n" +
                "  · Project-level context files (AGENTS.md, CLAUDE.md, .claude/rules/, etc.) that live\n" +
                "    outside your mounted paths will not be visible to the agent.\n" +
                "  · Git is unavailable — .git is not mounted in scoped mode (security boundary).\n" +
                "  The agent has been instructed to surface its limitations at session start.",
        );
        return { mode, hostCwd: cwd, selectedPaths };
    }

    if (mode === "cwd") {
        log.warn(
            "Scoped workspace — some context may be unavailable to the agent:\n" +
                "  · Your personal agent config files (~/.claude/CLAUDE.md, ~/.config/opencode/AGENTS.md, etc.)\n" +
                "    are not mounted from the host — only totopo's injected context is available.\n" +
                "  · Project-level context files (AGENTS.md, CLAUDE.md, .claude/rules/, etc.) that live\n" +
                "    outside this directory will not be visible to the agent.\n" +
                "  · Git is unavailable — .git is not mounted in scoped mode (security boundary).\n" +
                "  The agent has been instructed to surface its limitations at session start.",
        );
    }

    return { mode, hostCwd: cwd, selectedPaths: [] };
}

// --- Prompt: selective path selection ----------------------------------------------------------------------------------------------------
// Recursively expands a selected path into its children when a nested exclusion target is found,
// Until the excluded path itself can be dropped from the list.
function expandDirectoryToChildren(paths: string[], excl: string, cwd: string): string[] {
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
    return expandDirectoryToChildren([...withoutAncestor, ...children], excl, cwd);
}

// Builds a two-level directory structure for the scope picker: dirs mapped to their children, flat files separately
function buildDirectoryTree(cwd: string): { dirs: Record<string, string[]>; files: string[] } {
    const dirs: Record<string, string[]> = {};
    const files: string[] = [];

    for (const item of readdirSync(cwd)) {
        const itemPath = join(cwd, item);
        if (statSync(itemPath).isDirectory()) {
            const children = readdirSync(itemPath).map((child) => `${item}/${child}`);
            if (children.length === 0) {
                files.push(item); // empty dir -> treat as flat item
            } else {
                dirs[item] = children;
            }
        } else {
            files.push(item);
        }
    }

    return { dirs, files };
}

// Collapses redundant child paths: when all children of a dir are selected, replaces them with the parent dir
function collapseToMinimalPaths(selected: string[], dirs: Record<string, string[]>): string[] {
    const selectedSet = new Set(selected);
    const result: string[] = [];

    for (const [dir, children] of Object.entries(dirs)) {
        const selectedChildren = children.filter((c) => selectedSet.has(c));
        if (selectedChildren.length === children.length) {
            result.push(dir); // all children selected -> mount whole dir efficiently
        } else {
            result.push(...selectedChildren);
        }
    }

    // Root files (no slash)
    result.push(...selected.filter((s) => !s.includes("/")));

    return result;
}

async function promptAdditionalPaths(style: "only" | "except", cwd: string): Promise<string[]> {
    const verb = style === "only" ? "include" : "exclude";
    const accumulated: string[] = [];

    while (true) {
        const addAnother = await confirm({
            message: accumulated.length === 0 ? `Add a nested path to ${verb}?` : `Add another nested path to ${verb}?`,
            initialValue: false,
        });

        if (isCancel(addAnother)) {
            cancel("Cancelled.");
            process.exit(0);
        }

        if (!addAnother) break;

        const selectedAbs = await path({
            message: `Select a path to ${verb}:`,
            root: cwd,
            directory: true, // contrary to docs: true = files + dirs, false = files only
        });

        if (isCancel(selectedAbs)) break;

        const prefix = relative(cwd, (selectedAbs as string).trim());
        if (!prefix) continue; // selected cwd root - skip

        accumulated.push(prefix);
        log.success(`Added: ${prefix}`);
    }

    return accumulated;
}

async function promptSelectivePaths(cwd: string): Promise<string[]> {
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
    const { dirs, files } = buildDirectoryTree(cwd);
    const dirNames = Object.keys(dirs);

    log.warn("This picker shows only two directory levels. Deeper files/dirs can be selected by path in the next step.");
    const selectMessage = `Choose paths (Space to toggle · Enter to continue):`;

    // -- flat fallback when there are no dirs ---------------------------------------------------------------------------------------------
    if (dirNames.length === 0) {
        const flatSelected = await multiselect({
            message: selectMessage,
            options: files.map((f) => ({ value: f, label: f })),
            initialValues: style === "except" ? files : [],
            required: false,
        });

        if (isCancel(flatSelected)) {
            cancel("Cancelled.");
            process.exit(0);
        }

        return flatSelected as string[];
    }

    // -- build groupMultiselect options ---------------------------------------------------------------------------------------------------
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

    // "except" mode: pre-select all depth-2 children + root files
    const initialValues = style === "except" ? [...Object.values(dirs).flat(), ...files] : [];

    const rawSelected = await groupMultiselect({
        message: selectMessage,
        options: groupOptions,
        initialValues,
        required: false,
        selectableGroups: true,
    });

    if (isCancel(rawSelected)) {
        cancel("Cancelled.");
        process.exit(0);
    }

    const selected = collapseToMinimalPaths(rawSelected as string[], dirs);

    // -- deeper-path text+multiselect loop ------------------------------------------------------------------------------------------------
    const deeperPaths = await promptAdditionalPaths(style, cwd);

    let result = selected;
    if (style === "only") {
        result = [...new Set([...selected, ...deeperPaths])];
    } else {
        for (const p of deeperPaths) {
            result = expandDirectoryToChildren(result, p, cwd);
        }
    }

    if (result.length > 0) {
        note(result.map((p) => `  ${p}`).join("\n"), "Paths to mount");
    }
    return result;
}

// --- Build mount args --------------------------------------------------------------------------------------------------------------------
// Project config dir is always explicitly mounted - it's never inside the workspace.
function buildMountArgs(scope: ScopeConfig, workspaceDir: string, projectDir: string, cwd: string): string[] {
    const hostWorkspaceDir = scope.mode === "repo" ? workspaceDir : cwd;
    const agentMounts = buildAgentMountArgs(projectDir, hostWorkspaceDir);
    const configMount = ["-v", `${projectDir}:${TOTOPO_CONTAINER_PATH}:ro`];

    if (scope.mode === "repo") {
        return ["-v", `${workspaceDir}:/workspace`, ...configMount, ...agentMounts];
    }

    if (scope.mode === "cwd") {
        return ["-v", `${cwd}:/workspace`, ...configMount, ...agentMounts];
    }

    // Selective: validate all paths exist first
    for (const p of scope.selectedPaths) {
        const hostPath = join(cwd, p);
        if (!existsSync(hostPath)) {
            log.error(`Selected path does not exist: ${hostPath}`);
            process.exit(1);
        }
    }

    return [...scope.selectedPaths.flatMap((p) => ["-v", `${join(cwd, p)}:/workspace/${p}`]), ...configMount, ...agentMounts];
}

// --- Build scope env args ----------------------------------------------------------------------------------------------------------------
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

// --- Build scope label args --------------------------------------------------------------------------------------------------------------
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

// --- Read container scope label ----------------------------------------------------------------------------------------------------------
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
        // Leave empty on parse failure
    }

    return { mode: mode as WorkspaceScope, hostCwd, selectedPaths };
}

// --- Scope comparison --------------------------------------------------------------------------------------------------------------------
// null existing scope (pre-feature container) is treated as repo mode.
function scopesMatch(selected: ScopeConfig, existing: ScopeConfig | null, workspaceDir: string): boolean {
    const eff = existing ?? { mode: "repo" as WorkspaceScope, hostCwd: workspaceDir, selectedPaths: [] };
    if (selected.mode !== eff.mode) return false;
    if (selected.mode === "repo") return true;
    if (selected.hostCwd !== eff.hostCwd) return false;
    if (selected.mode === "selective") {
        return JSON.stringify([...selected.selectedPaths].sort()) === JSON.stringify([...eff.selectedPaths].sort());
    }
    return true;
}

// --- Shadow label args -------------------------------------------------------------------------------------------------------------------
function buildShadowLabelArgs(shadowedDirs: string[]): string[] {
    return ["--label", `totopo.shadows=${shadowedDirs.sort().join(",")}`];
}

function readContainerShadowLabel(name: string): string[] {
    const result = spawnSync("docker", ["inspect", "--format", '{{index .Config.Labels "totopo.shadows"}}', name], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (result.status !== 0) return [];
    const raw = result.stdout.trim();
    if (!raw || raw === "<no value>") return [];
    return raw.split(",").sort();
}

function shadowsMatch(current: string[], existing: string[]): boolean {
    return JSON.stringify([...current].sort()) === JSON.stringify([...existing].sort());
}

// --- Run post-start ----------------------------------------------------------------------------------------------------------------------
function runPostStart(containerName: string): void {
    log.step("Running post-start checks...");
    const postStart = spawnSync("docker", ["exec", containerName, "node", `${TOTOPO_CONTAINER_PATH}/post-start.mjs`], {
        stdio: "inherit",
    });
    if (postStart.status !== 0) {
        outro("Post-start checks failed.");
        process.exit(postStart.status ?? 1);
    }
}

// --- Remove container --------------------------------------------------------------------------------------------------------------------
function removeContainer(name: string): void {
    spawnSync("docker", ["stop", name], { stdio: "pipe" });
    spawnSync("docker", ["rm", name], { stdio: "pipe" });
}

// --- Ensure global env file exists -------------------------------------------------------------------------------------------------------
function ensureGlobalEnvFile(): string {
    const globalTotopoDir = join(homedir(), ".totopo");
    const envFile = join(globalTotopoDir, ".env");
    mkdirSync(globalTotopoDir, { recursive: true });
    if (!existsSync(envFile)) {
        writeFileSync(envFile, "");
    }
    return envFile;
}

// --- Run container -----------------------------------------------------------------------------------------------------------------------
function runContainer(
    scope: ScopeConfig,
    containerName: string,
    imageName: string,
    workspaceDir: string,
    projectDir: string,
    cwd: string,
    shadowedDirs: string[],
): void {
    const envFile = ensureGlobalEnvFile();
    const run = spawnSync(
        "docker",
        [
            "run",
            "-d",
            "--name",
            containerName,
            ...buildMountArgs(scope, workspaceDir, projectDir, cwd),
            "--env-file",
            envFile,
            ...buildScopeEnvArgs(scope),
            ...buildScopeLabelArgs(scope),
            ...buildShadowLabelArgs(shadowedDirs),
            "--security-opt",
            "no-new-privileges:true",
            "--label",
            "totopo.managed=true",
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

export async function run(_packageDir: string, ctx: ProjectContext): Promise<void> {
    const cwd = process.cwd();
    const workspaceDir = ctx.meta.projectRoot;
    const containerName = ctx.meta.containerName;
    const imageName = ctx.meta.containerName;
    const projectDir = ctx.projectDir;

    // --- Always prompt scope first -------------------------------------------------------------------------------------------------------
    const scope = await promptScope(workspaceDir, cwd);
    const hostWorkspaceDir = scope.mode === "repo" ? workspaceDir : cwd;
    const shadowedDirs = resolveShadowedDirs(hostWorkspaceDir);
    const agentDocs = buildAgentContextDocs(scope, shadowedDirs);

    // --- Inspect container state ---------------------------------------------------------------------------------------------------------
    const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });

    const containerStatus = inspect.status === 0 ? inspect.stdout.trim() : null;

    if (containerStatus === null) {
        // --- No container - build image and run ------------------------------------------------------------------------------------------
        log.step("Building container image...");
        const build = spawnSync(
            "docker",
            ["build", "--label", "totopo.managed=true", "-f", join(projectDir, "Dockerfile"), "-t", imageName, projectDir],
            { stdio: "inherit" },
        );
        if (build.status !== 0) {
            outro("Failed to build container image.");
            process.exit(build.status ?? 1);
        }

        log.step("Preparing agent context...");
        injectAgentContext(projectDir, agentDocs);
        log.step("Starting dev container...");
        runContainer(scope, containerName, imageName, workspaceDir, projectDir, cwd, shadowedDirs);
        runPostStart(containerName);
    } else if (containerStatus === "exited") {
        // --- Container stopped - resume or recreate based on scope/shadows ---------------------------------------------------------------
        const existingScope = readContainerScopeLabel(containerName);
        const existingShadows = readContainerShadowLabel(containerName);

        if (scopesMatch(scope, existingScope, workspaceDir) && shadowsMatch(shadowedDirs, existingShadows)) {
            log.step("Preparing agent context...");
            injectAgentContext(projectDir, agentDocs);
            log.step("Resuming dev container...");
            const start = spawnSync("docker", ["start", containerName], { stdio: "inherit" });
            if (start.status !== 0) {
                outro("Failed to start dev container.");
                process.exit(start.status ?? 1);
            }
            runPostStart(containerName);
        } else {
            log.step("Preparing agent context...");
            injectAgentContext(projectDir, agentDocs);
            log.step("Recreating dev container with new scope...");
            removeContainer(containerName);
            runContainer(scope, containerName, imageName, workspaceDir, projectDir, cwd, shadowedDirs);
            runPostStart(containerName);
        }
    } else {
        // --- Container running - connect directly or recreate based on scope/shadows -----------------------------------------------------
        const existingScope = readContainerScopeLabel(containerName);
        const existingShadows = readContainerShadowLabel(containerName);

        if (!scopesMatch(scope, existingScope, workspaceDir) || !shadowsMatch(shadowedDirs, existingShadows)) {
            log.step("Preparing agent context...");
            injectAgentContext(projectDir, agentDocs);
            log.step("Recreating dev container with new scope...");
            removeContainer(containerName);
            runContainer(scope, containerName, imageName, workspaceDir, projectDir, cwd, shadowedDirs);
            runPostStart(containerName);
        } else {
            // Same scope/shadows and container already running - refresh context in place.
            log.step("Refreshing agent context...");
            injectAgentContext(projectDir, agentDocs);
        }
        // Fall through to connect
    }

    // --- Connect -------------------------------------------------------------------------------------------------------------------------
    const exec = spawnSync("docker", ["exec", "-it", "-w", "/workspace", containerName, "bash", "--login"], {
        stdio: "inherit",
    });

    process.exit(exec.status ?? 0);
}
