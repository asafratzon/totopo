import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildAgentContextDocs, buildAgentMountArgs, injectAgentContext } from "../src/lib/agent-context.js";
import { GIT_MODE } from "../src/lib/constants.js";
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
    test("with git - contains git available content", () => {
        const docs = buildAgentContextDocs(true);
        assert.ok(docs.claude.includes("Git"));
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

    test("strict mode default when gitMode arg omitted", () => {
        const docs = buildAgentContextDocs(true);
        assert.match(docs.claude, /strict/i);
    });

    test("hasGit=false - falls back to git-unavailable regardless of mode", () => {
        const docs = buildAgentContextDocs(false, undefined, GIT_MODE.unrestricted);
        assert.match(docs.claude, /not available/i);
        assert.doesNotMatch(docs.claude, /does not enforce any git-specific restrictions/i);
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
});
