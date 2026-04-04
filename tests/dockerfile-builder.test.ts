import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildDockerfile } from "../src/lib/dockerfile-builder.js";

const TEMPLATES_DIR = join(import.meta.dirname, "..", "templates");
const BASE_TEMPLATE = join(TEMPLATES_DIR, "Dockerfile");

// ---- buildDockerfile --------------------------------------------------------------------------------------------------------------------

describe("buildDockerfile", () => {
    test("includes base template content", () => {
        const result = buildDockerfile(BASE_TEMPLATE);
        const base = readFileSync(BASE_TEMPLATE, "utf8");
        assert.ok(result.startsWith(base));
    });

    test("appends USER devuser", () => {
        const result = buildDockerfile(BASE_TEMPLATE);
        assert.ok(result.includes("USER devuser"));
    });

    test("appends CMD", () => {
        const result = buildDockerfile(BASE_TEMPLATE);
        assert.ok(result.includes('CMD ["/bin/bash"]'));
    });

    test("appends shell config with PS1 and welcome message", () => {
        const result = buildDockerfile(BASE_TEMPLATE);
        assert.ok(result.includes("PS1"));
        assert.ok(result.includes("opencode"));
        assert.ok(result.includes("claude"));
        assert.ok(result.includes("codex"));
    });

    test("without profile hook - no profile section", () => {
        const result = buildDockerfile(BASE_TEMPLATE);
        assert.ok(!result.includes("Profile hook"));
    });

    test("with profile hook - includes hook section", () => {
        const hook = "RUN apt-get update && apt-get install -y golang-go\n";
        const result = buildDockerfile(BASE_TEMPLATE, hook);
        assert.ok(result.includes("Profile hook"));
        assert.ok(result.includes("golang-go"));
    });

    test("USER devuser appears after profile hook", () => {
        const hook = "RUN echo hook-marker\n";
        const result = buildDockerfile(BASE_TEMPLATE, hook);
        const hookPos = result.indexOf("hook-marker");
        // Use lastIndexOf to find the actual USER directive, not the comment in the base template
        const userPos = result.lastIndexOf("\nUSER devuser\n");
        assert.ok(hookPos < userPos, "USER devuser must come after profile hook");
    });

    test("hook without trailing newline gets one added", () => {
        const hook = "RUN echo no-newline";
        const result = buildDockerfile(BASE_TEMPLATE, hook);
        assert.ok(result.includes("RUN echo no-newline\n"));
    });

    test("empty string hook is ignored", () => {
        const result = buildDockerfile(BASE_TEMPLATE, "");
        assert.ok(!result.includes("Profile hook"));
    });

    test("whitespace-only hook is ignored", () => {
        const result = buildDockerfile(BASE_TEMPLATE, "   \n  ");
        assert.ok(!result.includes("Profile hook"));
    });
});
