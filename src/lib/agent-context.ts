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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS_DIR, CONTAINER_HOME } from "./constants.js";

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

// Single-file mounts: individual files that must be bind-mounted to persist across container rebuilds.
// The host file is created with initialContent if it does not exist yet.
export interface AgentFileMount {
    hostSubpath: string; // relative to agents/ dir
    container: string; // absolute container path
    initialContent: string; // written to host file on first use
}

export const AGENT_MOUNTS: readonly AgentMount[] = [
    {
        agent: "claude",
        hostSubpath: "claude",
        container: `${CONTAINER_HOME}/.claude`,
        description: "Claude Code user-level config and session data",
    },
    {
        agent: "opencode",
        hostSubpath: "opencode/config",
        container: `${CONTAINER_HOME}/.config/opencode`,
        description: "OpenCode user-level config",
    },
    {
        agent: "opencode",
        hostSubpath: "opencode/data",
        container: `${CONTAINER_HOME}/.local/share/opencode`,
        description: "OpenCode user-level data and session history",
    },
    {
        agent: "codex",
        hostSubpath: "codex",
        container: `${CONTAINER_HOME}/.codex`,
        description: "Codex user-level config and session data",
    },
];

export const AGENT_FILE_MOUNTS: readonly AgentFileMount[] = [
    {
        // .claude.json lives outside ~/.claude/ so it is not covered by the directory mount.
        // Persisting it as a file mount avoids losing Claude Code settings on container rebuild.
        hostSubpath: "claude/.claude.json",
        container: `${CONTAINER_HOME}/.claude.json`,
        initialContent: "{}\n",
    },
];

// --- Build agent mount args --------------------------------------------------------------------------------------------------------------

/**
 * Creates agents/ subdirectories in the workspace cache dir on the host (lazily) and
 * returns volume mount args for all supported agent tools.
 */
export function buildAgentMountArgs(workspaceDir: string): string[] {
    const agentsDir = join(workspaceDir, AGENTS_DIR);

    const mounts = AGENT_MOUNTS.map((m) => ({
        host: join(agentsDir, m.hostSubpath),
        container: m.container,
    }));

    for (const { host } of mounts) mkdirSync(host, { recursive: true });

    const fileMounts = AGENT_FILE_MOUNTS.map((m) => ({
        host: join(agentsDir, m.hostSubpath),
        container: m.container,
        initialContent: m.initialContent,
    }));
    for (const { host, initialContent } of fileMounts) {
        if (!existsSync(host)) writeFileSync(host, initialContent);
    }

    return [
        ...mounts.flatMap(({ host, container }) => ["-v", `${host}:${container}`]),
        ...fileMounts.flatMap(({ host, container }) => ["-v", `${host}:${container}`]),
    ];
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
    const a = join(workspaceDir, AGENTS_DIR);

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
