// Agent mount definitions and context injection for AI CLIs running inside totopo containers.
//
// This file is the single source of truth for which directories each AI CLI reads/writes
// and how totopo intercepts them via bind mounts. If an AI CLI changes its config layout,
// this file must be updated.
//
// Verify against official docs periodically:
//   Claude Code: https://docs.anthropic.com/en/docs/claude-code
//   OpenCode:    https://github.com/opencode-ai/opencode
//   Codex:       https://github.com/openai/codex
//
// Note: OpenCode also reads `.opencode.json` (a file, not a dir) at the workspace root
// if the user has one. No shadow is needed - OpenCode never auto-creates this file in
// the project directory.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// --- Types -------------------------------------------------------------------------------------------------------------------------------

export type WorkspaceScope = "repo" | "cwd" | "selective";

export interface ScopeConfig {
    mode: WorkspaceScope;
    hostCwd: string;
    selectedPaths: string[]; // relative names; empty for repo/cwd
}

export interface AgentContextDocs {
    claude: string; // -> agents/claude/CLAUDE.md
    opencode: string; // -> agents/opencode/config/AGENTS.md
    codex: string; // -> agents/codex/AGENTS.md
}

export interface AgentMount {
    agent: "claude" | "opencode" | "codex";
    kind: "home" | "workspace-shadow";
    hostSubpath: string; // relative to agents/ dir
    container: string; // absolute container path
    description: string; // human-readable, used in agent context docs
}

export const AGENT_MOUNTS: readonly AgentMount[] = [
    // Home-dir mounts - user-level AI CLI state
    {
        agent: "claude",
        kind: "home",
        hostSubpath: "claude",
        container: "/home/devuser/.claude",
        description: "Claude Code user-level config and session data",
    },
    {
        agent: "opencode",
        kind: "home",
        hostSubpath: "opencode/config",
        container: "/home/devuser/.config/opencode",
        description: "OpenCode user-level config",
    },
    {
        agent: "opencode",
        kind: "home",
        hostSubpath: "opencode/data",
        container: "/home/devuser/.local/share/opencode",
        description: "OpenCode user-level data and session history",
    },
    {
        agent: "codex",
        kind: "home",
        hostSubpath: "codex",
        container: "/home/devuser/.codex",
        description: "Codex user-level config and session data",
    },
    // Workspace shadow mounts - intercept project-level config dirs
    {
        agent: "claude",
        kind: "workspace-shadow",
        hostSubpath: "workspace/.claude",
        container: "/workspace/.claude",
        description: "Shadows project-level .claude/",
    },
    {
        agent: "codex",
        kind: "workspace-shadow",
        hostSubpath: "workspace/.codex",
        container: "/workspace/.codex",
        description: "Shadows project-level .codex/",
    },
    {
        agent: "opencode",
        kind: "workspace-shadow",
        hostSubpath: "workspace/.opencode",
        container: "/workspace/.opencode",
        description: "Shadows project-level .opencode/",
    },
];

// --- Shadow resolution -------------------------------------------------------------------------------------------------------------------

/**
 * Returns the container paths of workspace-shadow mounts that should be applied.
 * A shadow is applied when the corresponding directory does NOT exist on the host workspace.
 * If it exists, the user's real dir passes through via the parent workspace mount.
 */
export function resolveShadowedDirs(hostWorkspaceDir: string): string[] {
    return AGENT_MOUNTS.filter((m) => m.kind === "workspace-shadow")
        .filter((m) => !existsSync(join(hostWorkspaceDir, basename(m.container))))
        .map((m) => m.container);
}

// --- Build agent mount args --------------------------------------------------------------------------------------------------------------

/**
 * Creates agents/ subdirectories in the project dir on the host (lazily) and
 * returns volume mount args for all supported agent tools.
 *
 * Home-dir mounts are always included. Workspace-shadow mounts are only included
 * for directories that don't exist on the host workspace (automatic detection).
 */
export function buildAgentMountArgs(projectDir: string, hostWorkspaceDir: string): string[] {
    const agentsDir = join(projectDir, "agents");
    const shadowedDirs = new Set(resolveShadowedDirs(hostWorkspaceDir));

    const mounts = AGENT_MOUNTS.filter((m) => {
        if (m.kind === "home") return true;
        // Only include workspace-shadow mounts for dirs that don't exist on host
        return shadowedDirs.has(m.container);
    }).map((m) => ({
        host: join(agentsDir, m.hostSubpath),
        container: m.container,
    }));

    for (const { host } of mounts) mkdirSync(host, { recursive: true });
    return mounts.flatMap(({ host, container }) => ["-v", `${host}:${container}`]);
}

// --- Build agent context documents -------------------------------------------------------------------------------------------------------

/**
 * Assembles the agent context markdown injected into each supported agent's config dir at session start.
 */
export function buildAgentContextDocs(scope: ScopeConfig, shadowedDirs: string[]): AgentContextDocs {
    // -- Scope section --------------------------------------------------------------------------------------------------------------------
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

    // -- Git section ----------------------------------------------------------------------------------------------------------------------
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

    // -- Selective-only warning -----------------------------------------------------------------------------------------------------------
    const selectiveWarning =
        scope.mode === "selective"
            ? `\n\n## Selective scope: file creation warning

Any file you create **outside your mounted paths** (e.g. at \`/\`, \`/tmp\`, or any path not listed above) will **not be visible on the host** and will be lost when the container is rebuilt.

If the user asks you to create or modify a file at such a location:
1. Notify the user that the path is outside your mounted workspace.
2. Explain that files created there will not sync to the host.
3. Suggest the user run the command on the host instead, or confirm they want the file only inside the container (understanding it will be lost on rebuild).`
            : "";

    // -- Workspace config isolation section ------------------------------------------------------------------------------------------------
    let isolationSection = "";
    if (shadowedDirs.length > 0) {
        const dirList = shadowedDirs
            .sort()
            .map((d) => `- \`${d}/\` — redirected to totopo's isolated agent storage`)
            .join("\n");
        isolationSection = `\n\n## Workspace config isolation

The following workspace directories are shadow-mounted by totopo and do NOT
correspond to directories in the user's actual project:

${dirList}

Project memory and session state at these paths is stored in \`~/.totopo/\` on
the host, not in the user's project directory. If the user asks about where
their AI CLI config or memory is stored, explain this.

Do not mention this at session start — only surface it if the user asks.`;
    }

    // -- Responsibilities section ---------------------------------------------------------------------------------------------------------
    const responsibilitiesSection = `## Your responsibilities at session start

At the start of every session:
- Briefly surface your current workspace scope and its limitations to the user.
- Tell the user what you cannot access in this session (files, git, remotes).`;

    // -- Assemble per-tool - only the self-referencing path differs -----------------------------------------------------------------------
    function build(toolPath: string): string {
        const constraintsSection = `## Constraints

- Files outside mounted paths cannot be read, written, or executed.
- If a command fails because of missing files, tell the user: "I have limited workspace scope — please run \`<command>\` on the host."
- \`~/.totopo/\` is read-only inside the container.
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
            isolationSection +
            "\n"
        );
    }

    return {
        claude: build("~/.claude/CLAUDE.md"),
        opencode: build("~/.config/opencode/AGENTS.md"),
        codex: build("~/.codex/AGENTS.md"),
    };
}

// --- Inject agent context ----------------------------------------------------------------------------------------------------------------

/**
 * Writes agent context markdown files into the project's agents/ directory.
 */
export function injectAgentContext(projectDir: string, docs: AgentContextDocs): void {
    const a = join(projectDir, "agents");

    const files = [
        { path: join(a, "claude", "CLAUDE.md"), content: docs.claude },
        { path: join(a, "opencode", "config", "AGENTS.md"), content: docs.opencode },
        { path: join(a, "codex", "AGENTS.md"), content: docs.codex },
    ];

    for (const { path: filePath, content } of files) {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, content);
    }
}
