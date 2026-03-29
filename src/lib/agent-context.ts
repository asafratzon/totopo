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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// --- Types -------------------------------------------------------------------------------------------------------------------------------

export interface AgentContextDocs {
    claude: string; // -> agents/claude/CLAUDE.md
    opencode: string; // -> agents/opencode/config/AGENTS.md
    codex: string; // -> agents/codex/AGENTS.md
}

export interface AgentMount {
    agent: "claude" | "opencode" | "codex";
    hostSubpath: string; // relative to agents/ dir
    container: string; // absolute container path
    description: string; // human-readable, used in agent context docs
}

export const AGENT_MOUNTS: readonly AgentMount[] = [
    {
        agent: "claude",
        hostSubpath: "claude",
        container: "/home/devuser/.claude",
        description: "Claude Code user-level config and session data",
    },
    {
        agent: "opencode",
        hostSubpath: "opencode/config",
        container: "/home/devuser/.config/opencode",
        description: "OpenCode user-level config",
    },
    {
        agent: "opencode",
        hostSubpath: "opencode/data",
        container: "/home/devuser/.local/share/opencode",
        description: "OpenCode user-level data and session history",
    },
    {
        agent: "codex",
        hostSubpath: "codex",
        container: "/home/devuser/.codex",
        description: "Codex user-level config and session data",
    },
];

// --- Build agent mount args --------------------------------------------------------------------------------------------------------------

/**
 * Creates agents/ subdirectories in the project dir on the host (lazily) and
 * returns volume mount args for all supported agent tools.
 */
export function buildAgentMountArgs(projectDir: string): string[] {
    const agentsDir = join(projectDir, "agents");

    const mounts = AGENT_MOUNTS.map((m) => ({
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
export function buildAgentContextDocs(hasGit: boolean, shadowPaths?: string[]): AgentContextDocs {
    // -- Git section ----------------------------------------------------------------------------------------------------------------------
    let gitSection: string;
    if (hasGit) {
        gitSection = `## Git availability

Git is fully available for local operations (commit, branch, log, diff, status, etc.).

Remote access (push, pull, fetch, clone) is **blocked at the system level** by design — \`protocol.allow = never\` is enforced in \`/etc/gitconfig\` and cannot be overridden without root. This is a deliberate security boundary: the container has no access to remote repositories. Ask the user to run any remote git operations from the host.`;
    } else {
        gitSection = `## Git availability

Git is **not available** — no \`.git\` directory was found in the project root.

Remote access is also **blocked container-wide** by design (\`protocol.allow = never\` in \`/etc/gitconfig\`).

If git operations are needed, ask the user to run them on the host.`;
    }

    // -- Responsibilities section ---------------------------------------------------------------------------------------------------------
    const responsibilitiesSection = `## Your responsibilities at session start

At the start of every session:
- Briefly tell the user they are in a totopo sandbox and mention key limitations (git remote block, no host filesystem access outside the project).`;

    // -- Shadow paths section ----------------------------------------------------------------------------------------------------------------
    let shadowSection = "";
    if (shadowPaths && shadowPaths.length > 0) {
        const pathList = shadowPaths.map((p) => `- \`/workspace/${p}\``).join("\n");
        shadowSection = `## Shadow paths

The following paths are shadowed — their host contents are overlaid with empty
directories inside the container:

${pathList}

These paths exist in the container but do not reflect the host filesystem.`;
    }

    // -- Assemble per-tool - only the self-referencing path differs -----------------------------------------------------------------------
    function build(toolPath: string): string {
        const constraintsSection = `## Constraints

- Files outside mounted paths cannot be read, written, or executed.
- If a command fails because of missing files or permissions, tell the user: "This requires running on the host — please run \`<command>\` outside the container."
- \`~/.totopo/\` is read-only inside the container.
- This file (\`${toolPath}\`) is managed by totopo and overwritten on every session start. Do not edit it.`;

        const sections = [
            "# totopo Workspace Context\n\nYou are running inside a totopo dev container.\n",
            `## Workspace

You have access to the full project directory at \`/workspace\`. Some operations (git push, system-level changes) require running on the host.`,
            ...(shadowSection ? [shadowSection] : []),
            gitSection,
            constraintsSection,
            responsibilitiesSection,
        ];

        return `${sections.join("\n\n")}\n`;
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
