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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * Creates agents/ subdirectories in the workspace cache dir on the host (lazily) and
 * returns volume mount args for all supported agent tools.
 */
export function buildAgentMountArgs(workspaceDir: string): string[] {
    const agentsDir = join(workspaceDir, "agents");

    const mounts = AGENT_MOUNTS.map((m) => ({
        host: join(agentsDir, m.hostSubpath),
        container: m.container,
    }));

    for (const { host } of mounts) mkdirSync(host, { recursive: true });
    return mounts.flatMap(({ host, container }) => ["-v", `${host}:${container}`]);
}

// --- Template helpers --------------------------------------------------------------------------------------------------------------------

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function loadTemplate(name: string): string {
    return readFileSync(join(packageRoot, "templates", "context", `${name}.md`), "utf8").trimEnd();
}

function renderTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

// --- Build agent context documents -------------------------------------------------------------------------------------------------------

/**
 * Assembles the agent context markdown injected into each supported agent's config dir at session start.
 */
export function buildAgentContextDocs(hasGit: boolean, shadowPatterns?: string[]): AgentContextDocs {
    const gitSection = loadTemplate(hasGit ? "git-available" : "git-unavailable");

    const shadowSection =
        shadowPatterns && shadowPatterns.length > 0
            ? renderTemplate(loadTemplate("shadow-paths"), {
                  pattern_list: shadowPatterns.map((p) => `- \`${p}\``).join("\n"),
              })
            : null;

    function build(toolPath: string): string {
        const sections = [
            loadTemplate("header"),
            loadTemplate("workspace"),
            loadTemplate("totopo-yaml"),
            ...(shadowSection ? [shadowSection] : []),
            gitSection,
            renderTemplate(loadTemplate("constraints"), { tool_path: toolPath }),
            loadTemplate("responsibilities"),
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
 * Writes agent context markdown files into the workspace's agents/ directory.
 */
export function injectAgentContext(workspaceDir: string, docs: AgentContextDocs): void {
    const a = join(workspaceDir, "agents");

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
