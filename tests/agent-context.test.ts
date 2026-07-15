import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
    buildAgentContextDocs,
    buildAgentMountArgs,
    ensureClaudeStatusLine,
    injectAgentContext,
    injectClaudeSkills,
} from "../src/lib/agent-context.js";
import { CLAUDE_STATUSLINE_PATH, GIT_MODE } from "../src/lib/constants.js";
import { cleanTempDir, createTempDir } from "./helpers.js";

const UNRESOLVED = /\{\{[^}]+\}\}/;

// ---- buildAgentContextDocs - placeholder checks -----------------------------------------------------------------------------------------

describe("buildAgentContextDocs - placeholders", () => {
    test("no unresolved placeholders - git + shadows", () => {
        const docs = buildAgentContextDocs(true, ["node_modules", ".env*"]);
        for (const [key, content] of Object.entries(docs)) {
            assert.doesNotMatch(content, UNRESOLVED, `${key} has unresolved placeholders`);
        }
    });

    test("no unresolved placeholders - no git, no shadows", () => {
        const docs = buildAgentContextDocs(false);
        for (const [key, content] of Object.entries(docs)) {
            assert.doesNotMatch(content, UNRESOLVED, `${key} has unresolved placeholders`);
        }
    });
});

// ---- buildAgentContextDocs - content checks ---------------------------------------------------------------------------------------------

describe("buildAgentContextDocs - content", () => {
    test("with git - contains git mode content", () => {
        const docs = buildAgentContextDocs(true);
        assert.ok(docs.claude.includes("git mode"));
        assert.ok(!docs.claude.toLowerCase().includes("not available"));
    });

    test("without git - contains git unavailable content", () => {
        const docs = buildAgentContextDocs(false);
        // Should mention git is not available or not initialized
        assert.ok(docs.claude.toLowerCase().includes("git"));
    });

    test("with shadows - contains shadow pattern list", () => {
        const docs = buildAgentContextDocs(true, ["node_modules", ".env*"]);
        assert.ok(docs.claude.includes("node_modules"));
        assert.ok(docs.claude.includes(".env*"));
    });

    test("without shadows - no shadow section patterns", () => {
        const docs = buildAgentContextDocs(true);
        assert.ok(!docs.claude.includes("node_modules"));
    });

    test("returns docs for all three agents", () => {
        const docs = buildAgentContextDocs(true);
        assert.ok(typeof docs.claude === "string");
        assert.ok(typeof docs.opencode === "string");
        assert.ok(typeof docs.codex === "string");
    });

    test("strict mode - contains read-only language", () => {
        const docs = buildAgentContextDocs(true, undefined, GIT_MODE.strict);
        assert.match(docs.claude, /strict/i);
        assert.match(docs.claude, /read-only/i);
    });

    test("local mode - mentions remote is blocked but local allowed", () => {
        const docs = buildAgentContextDocs(true, undefined, GIT_MODE.local);
        assert.match(docs.claude, /local/);
        assert.match(docs.claude, /remote/);
    });

    test("unrestricted mode - mentions totopo enforces no git-specific restrictions", () => {
        const docs = buildAgentContextDocs(true, undefined, GIT_MODE.unrestricted);
        assert.match(docs.claude, /unrestricted/);
        assert.match(docs.claude, /does not enforce any git-specific restrictions/i);
    });

    test("local mode default when gitMode arg omitted", () => {
        const docs = buildAgentContextDocs(true);
        assert.match(docs.claude, /local/);
        assert.match(docs.claude, /remote/);
    });

    test("hasGit=false - falls back to git-unavailable regardless of mode", () => {
        const docs = buildAgentContextDocs(false, undefined, GIT_MODE.unrestricted);
        assert.match(docs.claude, /not available/i);
        assert.doesNotMatch(docs.claude, /does not enforce any git-specific restrictions/i);
    });

    test("context-usage note appears only in the claude doc", () => {
        const docs = buildAgentContextDocs(true);
        assert.ok(docs.claude.includes("context-usage"), "claude doc should mention context-usage");
        assert.ok(!docs.opencode.includes("context-usage"), "opencode doc should not mention context-usage");
        assert.ok(!docs.codex.includes("context-usage"), "codex doc should not mention context-usage");
    });
});

// ---- buildAgentMountArgs ----------------------------------------------------------------------------------------------------------------

describe("buildAgentMountArgs", () => {
    test("returns correct number of mount args", async () => {
        const tmp = createTempDir();
        const args = buildAgentMountArgs(tmp);
        // 5 mounts (claude, opencode config, opencode data, codex, .claude.json file) = 10 args (-v + path each)
        assert.equal(args.length, 10);
        await cleanTempDir(tmp);
    });

    test("contains expected container paths", async () => {
        const tmp = createTempDir();
        const args = buildAgentMountArgs(tmp);
        const joined = args.join(" ");
        assert.ok(joined.includes("/home/devuser/.claude"));
        assert.ok(joined.includes("/home/devuser/.config/opencode"));
        assert.ok(joined.includes("/home/devuser/.local/share/opencode"));
        assert.ok(joined.includes("/home/devuser/.codex"));
        assert.ok(joined.includes("/home/devuser/.claude.json"));
        await cleanTempDir(tmp);
    });

    test("creates agent directories on host", async () => {
        const tmp = createTempDir();
        buildAgentMountArgs(tmp);
        assert.ok(existsSync(join(tmp, "agents", "claude")));
        assert.ok(existsSync(join(tmp, "agents", "codex")));
        await cleanTempDir(tmp);
    });

    test("creates .claude.json as empty JSON when missing", async () => {
        const tmp = createTempDir();
        buildAgentMountArgs(tmp);
        const claudeJson = join(tmp, "agents", "claude", ".claude.json");
        assert.ok(existsSync(claudeJson), ".claude.json should be created");
        assert.doesNotThrow(() => JSON.parse(readFileSync(claudeJson, "utf8")), "should be valid JSON");
        await cleanTempDir(tmp);
    });

    test("does not overwrite existing .claude.json", async () => {
        const tmp = createTempDir();
        // First call creates the file
        buildAgentMountArgs(tmp);
        const claudeJson = join(tmp, "agents", "claude", ".claude.json");
        const content = JSON.stringify({ hasExistingData: true });
        writeFileSync(claudeJson, content);
        // Second call must not overwrite it
        buildAgentMountArgs(tmp);
        assert.equal(readFileSync(claudeJson, "utf8"), content, "existing .claude.json should not be overwritten");
        await cleanTempDir(tmp);
    });

    test(".claude.json mount arg points to correct host and container paths", async () => {
        const tmp = createTempDir();
        const args = buildAgentMountArgs(tmp);
        const mountIndex = args.indexOf(`${join(tmp, "agents", "claude", ".claude.json")}:/home/devuser/.claude.json`);
        assert.notEqual(mountIndex, -1, ".claude.json file mount should be present");
        assert.equal(args[mountIndex - 1], "-v", "mount arg should be preceded by -v");
        await cleanTempDir(tmp);
    });
});

// ---- injectAgentContext -----------------------------------------------------------------------------------------------------------------

describe("injectAgentContext", () => {
    test("writes context files to correct paths", async () => {
        const tmp = createTempDir();
        const docs = buildAgentContextDocs(true, ["node_modules"]);
        injectAgentContext(tmp, docs);
        assert.ok(existsSync(join(tmp, "agents", "claude", "CLAUDE.md")));
        assert.ok(existsSync(join(tmp, "agents", "opencode", "config", "AGENTS.md")));
        assert.ok(existsSync(join(tmp, "agents", "codex", "AGENTS.md")));
        await cleanTempDir(tmp);
    });

    test("writes statusLine and skill alongside markdown context", async () => {
        const tmp = createTempDir();
        const docs = buildAgentContextDocs(true);
        injectAgentContext(tmp, docs);
        assert.ok(existsSync(join(tmp, "agents", "claude", "CLAUDE.md")));
        assert.ok(existsSync(join(tmp, "agents", "claude", "settings.json")));
        assert.ok(existsSync(join(tmp, "agents", "claude", "skills", "totopo-statusline", "SKILL.md")));
        await cleanTempDir(tmp);
    });
});

// ---- ensureClaudeStatusLine -------------------------------------------------------------------------------------------------------------

describe("ensureClaudeStatusLine", () => {
    test("creates settings.json with totopo default statusLine when missing", async () => {
        const tmp = createTempDir();
        ensureClaudeStatusLine(tmp);
        const settingsPath = join(tmp, "agents", "claude", "settings.json");
        assert.ok(existsSync(settingsPath));
        const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
        assert.deepEqual(settings.statusLine, { type: "command", command: CLAUDE_STATUSLINE_PATH });
        await cleanTempDir(tmp);
    });

    test("adds statusLine to empty settings.json", async () => {
        const tmp = createTempDir();
        const settingsPath = join(tmp, "agents", "claude", "settings.json");
        mkdirSync(join(tmp, "agents", "claude"), { recursive: true });
        writeFileSync(settingsPath, "{}");
        ensureClaudeStatusLine(tmp);
        const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
        assert.deepEqual(settings.statusLine, { type: "command", command: CLAUDE_STATUSLINE_PATH });
        await cleanTempDir(tmp);
    });

    test("preserves other fields when adding statusLine", async () => {
        const tmp = createTempDir();
        const settingsPath = join(tmp, "agents", "claude", "settings.json");
        mkdirSync(join(tmp, "agents", "claude"), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify({ theme: "dark", env: { FOO: "bar" } }));
        ensureClaudeStatusLine(tmp);
        const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
        assert.equal(settings.theme, "dark");
        assert.deepEqual(settings.env, { FOO: "bar" });
        assert.equal(settings.statusLine.command, CLAUDE_STATUSLINE_PATH);
        await cleanTempDir(tmp);
    });

    test("does not overwrite an existing statusLine", async () => {
        const tmp = createTempDir();
        const settingsPath = join(tmp, "agents", "claude", "settings.json");
        mkdirSync(join(tmp, "agents", "claude"), { recursive: true });
        const customStatusLine = { type: "command", command: "/home/devuser/.claude/my-statusline.sh" };
        writeFileSync(settingsPath, JSON.stringify({ statusLine: customStatusLine }));
        ensureClaudeStatusLine(tmp);
        const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
        assert.deepEqual(settings.statusLine, customStatusLine);
        await cleanTempDir(tmp);
    });

    test("treats malformed JSON as empty and overwrites with valid JSON", async () => {
        const tmp = createTempDir();
        const settingsPath = join(tmp, "agents", "claude", "settings.json");
        mkdirSync(join(tmp, "agents", "claude"), { recursive: true });
        writeFileSync(settingsPath, "{ not valid json");
        assert.doesNotThrow(() => ensureClaudeStatusLine(tmp));
        assert.doesNotThrow(() => JSON.parse(readFileSync(settingsPath, "utf8")));
        const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
        assert.equal(settings.statusLine.command, CLAUDE_STATUSLINE_PATH);
        await cleanTempDir(tmp);
    });
});

// ---- injectClaudeSkills -----------------------------------------------------------------------------------------------------------------

describe("injectClaudeSkills", () => {
    test("writes totopo-statusline SKILL.md to claude skills dir", async () => {
        const tmp = createTempDir();
        injectClaudeSkills(tmp);
        const skillPath = join(tmp, "agents", "claude", "skills", "totopo-statusline", "SKILL.md");
        assert.ok(existsSync(skillPath));
        await cleanTempDir(tmp);
    });

    test("resolves all placeholders (no unresolved {{...}} remain)", async () => {
        const tmp = createTempDir();
        injectClaudeSkills(tmp);
        const skillPath = join(tmp, "agents", "claude", "skills", "totopo-statusline", "SKILL.md");
        const content = readFileSync(skillPath, "utf8");
        assert.doesNotMatch(content, /\{\{[^}]+\}\}/, "skill file has unresolved placeholders");
        assert.ok(content.includes(CLAUDE_STATUSLINE_PATH), "skill should reference the resolved statusline path");
        await cleanTempDir(tmp);
    });

    test("writes context-usage SKILL.md with no unresolved placeholders", async () => {
        const tmp = createTempDir();
        injectClaudeSkills(tmp);
        const skillPath = join(tmp, "agents", "claude", "skills", "context-usage", "SKILL.md");
        assert.ok(existsSync(skillPath));
        assert.doesNotMatch(readFileSync(skillPath, "utf8"), /\{\{[^}]+\}\}/, "skill file has unresolved placeholders");
        await cleanTempDir(tmp);
    });

    test("overwrites existing skill files (totopo-managed)", async () => {
        const tmp = createTempDir();
        const skillPath = join(tmp, "agents", "claude", "skills", "totopo-statusline", "SKILL.md");
        mkdirSync(join(tmp, "agents", "claude", "skills", "totopo-statusline"), { recursive: true });
        writeFileSync(skillPath, "stale content");
        injectClaudeSkills(tmp);
        const content = readFileSync(skillPath, "utf8");
        assert.notEqual(content, "stale content");
        assert.ok(content.includes("totopo-statusline"));
        await cleanTempDir(tmp);
    });
});
