// =========================================================================================================================================
// src/core/commands/dev.ts — Start the dev container and connect via docker exec
// Invoked by bin/totopo.js — do not run directly.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { cancel, confirm, groupMultiselect, isCancel, log, multiselect, note, outro, path, select } from "@clack/prompts";

// ─── Types ────────────────────────────────────────────────────────────────────
type WorkspaceScope = "repo" | "cwd" | "selective";
interface ScopeConfig {
    mode: WorkspaceScope;
    hostCwd: string;
    selectedPaths: string[]; // relative names; empty for repo/cwd
}

// ─── Prompt: scope selection ──────────────────────────────────────────────────
async function promptScope(workspaceDir: string, totopoDir: string, cwd: string): Promise<ScopeConfig> {
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
        const selectedPaths = await promptSelectivePaths(totopoDir, cwd);
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

// ─── Prompt: selective path selection ─────────────────────────────────────────
// Recursively expands a selected path into its children when a nested exclusion target is found,
// until the excluded path itself can be dropped from the list.
function expandExclusion(paths: string[], excl: string, cwd: string): string[] {
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
    return expandExclusion([...withoutAncestor, ...children], excl, cwd);
}

function scanCwdDepth2(totopoDir: string, cwd: string): { dirs: Record<string, string[]>; files: string[] } {
    const dirs: Record<string, string[]> = {};
    const files: string[] = [];

    for (const item of readdirSync(cwd)) {
        const itemPath = join(cwd, item);
        if (itemPath === totopoDir) continue;
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

async function promptDeeperPaths(style: "only" | "except", cwd: string): Promise<string[]> {
    const verb = style === "only" ? "include" : "exclude";
    const accumulated: string[] = [];

    while (true) {
        const addAnother = await confirm({
            message: accumulated.length === 0 ? `Add a nested path to ${verb} by path?` : `Add another nested path to ${verb}?`,
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
        if (!prefix) continue; // selected cwd root — skip

        accumulated.push(prefix);
        log.success(`Added: ${prefix}`);
    }

    return accumulated;
}

async function promptSelectivePaths(totopoDir: string, cwd: string): Promise<string[]> {
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
    const { dirs, files } = scanCwdDepth2(totopoDir, cwd);
    const dirNames = Object.keys(dirs);

    if (style === "only") {
        log.info("Space to select · Enter to confirm · Skip entirely with Enter to go straight to path input.");
    } else {
        log.info("All items pre-selected · Space to deselect · Enter to confirm · Add deeper exclusions in the next step.");
    }

    // ── flat fallback when there are no dirs ──────────────────────────────────
    if (dirNames.length === 0) {
        const flatSelected = await multiselect({
            message: "Choose paths:",
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
        required: false,
        selectableGroups: true,
    });

    if (isCancel(rawSelected)) {
        cancel("Cancelled.");
        process.exit(0);
    }

    const selected = normalizeSelection(rawSelected as string[], dirs);

    // ── deeper-path text+multiselect loop ─────────────────────────────────────
    const deeperPaths = await promptDeeperPaths(style, cwd);

    let result = selected;
    if (style === "only") {
        result = [...new Set([...selected, ...deeperPaths])];
    } else {
        for (const p of deeperPaths) {
            result = expandExclusion(result, p, cwd);
        }
    }

    if (result.length > 0) {
        note(result.map((p) => `  ${p}`).join("\n"), "Paths to mount");
    }
    return result;
}

// ─── Totopo mount path inside container ──────────────────────────────────────
// For repo scope (or cwd at repo root), .totopo is naturally inside /workspace.
// For cwd/selective with a nested dir, we mount it outside /workspace to avoid
// Docker creating an empty .totopo directory on the host as a mount point.
function getTotopoMountPath(scope: ScopeConfig, workspaceDir: string): string {
    if (scope.mode === "repo") return "/workspace/.totopo";
    if (scope.mode === "cwd" && scope.hostCwd === workspaceDir) return "/workspace/.totopo";
    return "/home/devuser/.totopo";
}

// ─── Build agent mount args ───────────────────────────────────────────────────
// Creates .totopo/agents/ subdirectories on the host (lazily, on first run) and
// returns volume mount args for all supported agent tools. Each agent tool gets
// its own read-write bind mount so session data persists across container rebuilds.
function buildAgentMountArgs(totopoDir: string): string[] {
    const agentsDir = join(totopoDir, "agents");
    const mounts = [
        { host: join(agentsDir, "claude"), container: "/home/devuser/.claude" },
        { host: join(agentsDir, "opencode", "config"), container: "/home/devuser/.config/opencode" },
        { host: join(agentsDir, "opencode", "data"), container: "/home/devuser/.local/share/opencode" },
        { host: join(agentsDir, "kilo", "config"), container: "/home/devuser/.config/kilo" },
        { host: join(agentsDir, "kilo", "data"), container: "/home/devuser/.local/share/kilo" },
        { host: join(agentsDir, "codex"), container: "/home/devuser/.codex" },
    ];
    for (const { host } of mounts) mkdirSync(host, { recursive: true });
    return mounts.flatMap(({ host, container }) => ["-v", `${host}:${container}`]);
}

// ─── Build mount args ─────────────────────────────────────────────────────────
function buildMountArgs(scope: ScopeConfig, workspaceDir: string, totopoDir: string, cwd: string): string[] {
    const totopoMount = getTotopoMountPath(scope, workspaceDir);
    const agentMounts = buildAgentMountArgs(totopoDir);

    if (scope.mode === "repo") {
        return ["-v", `${workspaceDir}:/workspace`, ...agentMounts];
    }

    if (scope.mode === "cwd") {
        return ["-v", `${cwd}:/workspace`, ...(cwd !== workspaceDir ? ["-v", `${totopoDir}:${totopoMount}:ro`] : []), ...agentMounts];
    }

    // selective: validate all paths exist first
    for (const p of scope.selectedPaths) {
        const hostPath = join(cwd, p);
        if (!existsSync(hostPath)) {
            log.error(`Selected path does not exist: ${hostPath}`);
            process.exit(1);
        }
    }

    return [
        ...scope.selectedPaths.flatMap((p) => ["-v", `${join(cwd, p)}:/workspace/${p}`]),
        "-v",
        `${totopoDir}:${totopoMount}:ro`,
        ...agentMounts,
    ];
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

// ─── Build agent context documents ────────────────────────────────────────────
// Generates a context file for each supported agent tool. All tools receive the
// same core content — scope description, git availability, constraints, and
// session-start responsibilities. The only per-tool variation is the self-
// referencing path in the constraints section.
// Written to .totopo/agents/ on the host and served into the container via
// the per-tool volume mounts created by buildAgentMountArgs().
interface AgentContextDocs {
    claude: string; // → .totopo/agents/claude/CLAUDE.md
    opencode: string; // → .totopo/agents/opencode/config/AGENTS.md
    kilo: string; // → .totopo/agents/kilo/config/AGENTS.md
    codex: string; // → .totopo/agents/codex/AGENTS.md
}

function buildAgentContextDocs(scope: ScopeConfig): AgentContextDocs {
    // ── Scope section ──────────────────────────────────────────────────────────
    let scopeSection: string;
    if (scope.mode === "repo") {
        scopeSection = `## Workspace scope: repo

You have access to the full repository at \`/workspace\`. Some operations (git push, system-level changes) require running on the host.`;
    } else if (scope.mode === "cwd") {
        scopeSection = `## Workspace scope: cwd

Workspace is scoped to one directory (\`${scope.hostCwd}\`). Files outside it are not visible to you. Commands that depend on absent files will fail.`;
    } else {
        const pathList = scope.selectedPaths.map((p) => `- \`/workspace/${p}\``).join("\n");
        scopeSection = `## Workspace scope: selective

Workspace is selectively scoped. Only the following paths are mounted:\n\n${pathList}`;
    }

    // ── Git section ────────────────────────────────────────────────────────────
    let gitSection: string;
    if (scope.mode === "repo") {
        gitSection = `## Git availability

Git is fully available for local operations (commit, branch, log, diff, status, etc.).

Remote access (push, pull, fetch, clone) is **blocked at the system level** by design — \`protocol.allow = never\` is enforced in \`/etc/gitconfig\` and cannot be overridden without root. This is a deliberate security boundary: the container has no access to remote repositories. Ask the user to run any remote git operations from the host.`;
    } else {
        gitSection = `## Git availability

Git local operations are **not available** in this scope — \`.git\` is not mounted. This is intentional: mounting \`.git\` would expose the full commit history of all repository files, including those outside your current mount, defeating the security boundary of scoped access.

Remote access is also **blocked container-wide** by design (\`protocol.allow = never\` in \`/etc/gitconfig\`).

If git operations are needed, ask the user to run them on the host.`;
    }

    // ── Selective-only warning ─────────────────────────────────────────────────
    const selectiveWarning =
        scope.mode === "selective"
            ? `\n\n## Selective scope: file creation warning

Any file you create **outside your mounted paths** (e.g. at \`/\`, \`/tmp\`, or any path not listed above) will **not be visible on the host** and will be lost when the container is rebuilt.

If the user asks you to create or modify a file at such a location:
1. Notify the user that the path is outside your mounted workspace.
2. Explain that files created there will not sync to the host.
3. Suggest the user run the command on the host instead, or confirm they want the file only inside the container (understanding it will be lost on rebuild).`
            : "";

    // ── Responsibilities section ───────────────────────────────────────────────
    const responsibilitiesSection = `## Your responsibilities at session start

At the start of every session:
- Briefly surface your current workspace scope and its limitations to the user.
- Tell the user what you cannot access in this session (files, git, remotes).`;

    // ── Assemble per-tool — only the self-referencing path differs ─────────────
    function build(toolPath: string): string {
        const constraintsSection = `## Constraints

- Files outside mounted paths cannot be read, written, or executed.
- If a command fails because of missing files, tell the user: "I have limited workspace scope — please run \`<command>\` on the host."
- \`.totopo/\` is read-only inside the container.
- This file (\`${toolPath}\`) is managed by totopo and overwritten on every session start. Do not edit it.`;

        return (
            [
                "# totopo Workspace Context\n\nYou are running inside a totopo dev container.\n",
                scopeSection,
                gitSection,
                constraintsSection,
                responsibilitiesSection,
            ].join("\n\n") +
            selectiveWarning +
            "\n"
        );
    }

    return {
        claude: build("~/.claude/CLAUDE.md"),
        opencode: build("~/.config/opencode/AGENTS.md"),
        kilo: build("~/.config/kilo/AGENTS.md"),
        codex: build("~/.codex/AGENTS.md"),
    };
}

// ─── Inject agent context ─────────────────────────────────────────────────────
// Writes context files directly to .totopo/agents/ on the host. The agent dirs
// are created on demand (recursive mkdir) so this is safe to call on first run
// before any directories exist, as well as on subsequent runs where it simply
// overwrites existing files with the latest context. The agent dirs are served
// into the container via volume mounts — no docker cp required. Called before
// every container start/resume so context always reflects the current scope.
function injectAgentContext(totopoDir: string, docs: AgentContextDocs): void {
    const a = join(totopoDir, "agents");

    const files = [
        { path: join(a, "claude", "CLAUDE.md"), content: docs.claude },
        { path: join(a, "opencode", "config", "AGENTS.md"), content: docs.opencode },
        { path: join(a, "kilo", "config", "AGENTS.md"), content: docs.kilo },
        { path: join(a, "codex", "AGENTS.md"), content: docs.codex },
    ];

    for (const { path, content } of files) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }
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
function runContainer(
    scope: ScopeConfig,
    containerName: string,
    imageName: string,
    workspaceDir: string,
    totopoDir: string,
    cwd: string,
): void {
    const run = spawnSync(
        "docker",
        [
            "run",
            "-d",
            "--name",
            containerName,
            ...buildMountArgs(scope, workspaceDir, totopoDir, cwd),
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

export async function run(_packageDir: string, repoRoot: string): Promise<void> {
    const cwd = process.cwd();
    const projectName = basename(repoRoot);
    const containerName = `totopo-managed-${projectName}`;
    const imageName = `totopo-managed-${projectName}`;
    const totopoDir = join(repoRoot, ".totopo");

    // ─── Always prompt scope first ────────────────────────────────────────────────
    const scope = await promptScope(repoRoot, totopoDir, cwd);

    // ─── Inspect container state ──────────────────────────────────────────────────
    const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });

    const containerStatus = inspect.status === 0 ? inspect.stdout.trim() : null;

    if (containerStatus === null) {
        // ─── No container — build image and run ───────────────────────────────────
        log.step("Building container image...");
        const build = spawnSync("docker", ["build", "-f", `${repoRoot}/.totopo/Dockerfile`, "-t", imageName, repoRoot], {
            stdio: "inherit",
        });
        if (build.status !== 0) {
            outro("Failed to build container image.");
            process.exit(build.status ?? 1);
        }

        const totopoMountPath = getTotopoMountPath(scope, repoRoot);
        log.step("Preparing agent context...");
        injectAgentContext(totopoDir, buildAgentContextDocs(scope));
        log.step("Starting dev container...");
        runContainer(scope, containerName, imageName, repoRoot, totopoDir, cwd);
        runPostStart(containerName, totopoMountPath);
    } else if (containerStatus === "exited") {
        // ─── Container stopped — resume or recreate based on scope ────────────────
        const existingScope = readContainerScopeLabel(containerName);
        const totopoMountPath = getTotopoMountPath(scope, repoRoot);

        if (scopesMatch(scope, existingScope, repoRoot)) {
            log.step("Preparing agent context...");
            injectAgentContext(totopoDir, buildAgentContextDocs(scope));
            log.step("Resuming dev container...");
            const start = spawnSync("docker", ["start", containerName], { stdio: "inherit" });
            if (start.status !== 0) {
                outro("Failed to start dev container.");
                process.exit(start.status ?? 1);
            }
            runPostStart(containerName, totopoMountPath);
        } else {
            log.step("Preparing agent context...");
            injectAgentContext(totopoDir, buildAgentContextDocs(scope));
            log.step("Recreating dev container with new scope...");
            removeContainer(containerName);
            runContainer(scope, containerName, imageName, repoRoot, totopoDir, cwd);
            runPostStart(containerName, totopoMountPath);
        }
    } else {
        // ─── Container running — connect directly or recreate based on scope ──────
        const existingScope = readContainerScopeLabel(containerName);

        if (!scopesMatch(scope, existingScope, repoRoot)) {
            const totopoMountPath = getTotopoMountPath(scope, repoRoot);
            log.step("Preparing agent context...");
            injectAgentContext(totopoDir, buildAgentContextDocs(scope));
            log.step("Recreating dev container with new scope...");
            removeContainer(containerName);
            runContainer(scope, containerName, imageName, repoRoot, totopoDir, cwd);
            runPostStart(containerName, totopoMountPath);
        } else {
            // Same scope and container already running — refresh context in place.
            log.step("Refreshing agent context...");
            injectAgentContext(totopoDir, buildAgentContextDocs(scope));
        }
        // fall through to connect
    }

    // ─── Connect ──────────────────────────────────────────────────────────────────
    const exec = spawnSync("docker", ["exec", "-it", "-w", "/workspace", containerName, "bash", "--login"], {
        stdio: "inherit",
    });

    process.exit(exec.status ?? 0);
}
