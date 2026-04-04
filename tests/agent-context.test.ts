import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildAgentContextDocs, buildAgentMountArgs, injectAgentContext } from "../src/lib/agent-context.js";
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
});

// ---- buildAgentMountArgs ----------------------------------------------------------------------------------------------------------------

describe("buildAgentMountArgs", () => {
    test("returns correct number of mount args", () => {
        const tmp = createTempDir();
        const args = buildAgentMountArgs(tmp);
        // 4 mounts (claude, opencode config, opencode data, codex) = 8 args (-v + path each)
        assert.equal(args.length, 8);
        cleanTempDir(tmp);
    });

    test("contains expected container paths", () => {
        const tmp = createTempDir();
        const args = buildAgentMountArgs(tmp);
        const joined = args.join(" ");
        assert.ok(joined.includes("/home/devuser/.claude"));
        assert.ok(joined.includes("/home/devuser/.config/opencode"));
        assert.ok(joined.includes("/home/devuser/.local/share/opencode"));
        assert.ok(joined.includes("/home/devuser/.codex"));
        cleanTempDir(tmp);
    });

    test("creates agent directories on host", () => {
        const tmp = createTempDir();
        buildAgentMountArgs(tmp);
        assert.ok(existsSync(join(tmp, "agents", "claude")));
        assert.ok(existsSync(join(tmp, "agents", "codex")));
        cleanTempDir(tmp);
    });
});

// ---- injectAgentContext -----------------------------------------------------------------------------------------------------------------

describe("injectAgentContext", () => {
    test("writes context files to correct paths", () => {
        const tmp = createTempDir();
        const docs = buildAgentContextDocs(true, ["node_modules"]);
        injectAgentContext(tmp, docs);
        assert.ok(existsSync(join(tmp, "agents", "claude", "CLAUDE.md")));
        assert.ok(existsSync(join(tmp, "agents", "opencode", "config", "AGENTS.md")));
        assert.ok(existsSync(join(tmp, "agents", "codex", "AGENTS.md")));
        cleanTempDir(tmp);
    });
});
