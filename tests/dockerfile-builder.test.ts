import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { BAKED_TEMPLATE_FILES, buildDockerfile, computeBuildHash } from "../src/lib/dockerfile-builder.js";
import { cleanTempDir, createTempDir } from "./helpers.js";

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

    test("appends the guarded auto-start block driven by TOTOPO_AUTOSTART", () => {
        const result = buildDockerfile(BASE_TEMPLATE);
        // The launch is gated on TOTOPO_AUTOSTART (set by docker run) and guarded by TOTOPO_AUTOSTARTED
        // so nested and post-exit shells do not relaunch.
        assert.ok(result.includes("$TOTOPO_AUTOSTART"));
        assert.ok(result.includes("TOTOPO_AUTOSTARTED"));
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

// ---- computeBuildHash -------------------------------------------------------------------------------------------------------------------

describe("computeBuildHash", () => {
    test("deterministic - same inputs return same hex", () => {
        const content = buildDockerfile(BASE_TEMPLATE);
        const a = computeBuildHash(content, TEMPLATES_DIR);
        const b = computeBuildHash(content, TEMPLATES_DIR);
        assert.equal(a, b);
        assert.match(a, /^[0-9a-f]{64}$/);
    });

    test("changing dockerfile content changes the hash", () => {
        const content = buildDockerfile(BASE_TEMPLATE);
        const baseline = computeBuildHash(content, TEMPLATES_DIR);
        const tweaked = computeBuildHash(`${content}\n# extra comment\n`, TEMPLATES_DIR);
        assert.notEqual(baseline, tweaked);
    });

    test("changing a baked template file changes the hash", async () => {
        // Mirror real templates dir into a temp dir, then mutate one file and re-hash.
        const fixtureDir = createTempDir();
        try {
            for (const name of BAKED_TEMPLATE_FILES) {
                writeFileSync(join(fixtureDir, name), readFileSync(join(TEMPLATES_DIR, name)));
            }
            const content = buildDockerfile(BASE_TEMPLATE);
            const baseline = computeBuildHash(content, fixtureDir);

            // Mutate one known baked file and recompute.
            const target = join(fixtureDir, "claude-statusline.sh");
            writeFileSync(target, `${readFileSync(target, "utf8")}# drift\n`);
            const drifted = computeBuildHash(content, fixtureDir);

            assert.notEqual(baseline, drifted);
        } finally {
            await cleanTempDir(fixtureDir);
        }
    });

    test("missing baked files in contextDir produce a different hash than production", async () => {
        // Empty temp dir as contextDir - hash is computed without any file content.
        // Used by tests that build minimal images and want them to read as stale vs production.
        const empty = createTempDir();
        try {
            const content = buildDockerfile(BASE_TEMPLATE);
            const production = computeBuildHash(content, TEMPLATES_DIR);
            const minimal = computeBuildHash(content, empty);
            assert.notEqual(production, minimal);
        } finally {
            await cleanTempDir(empty);
        }
    });
});

// ---- BAKED_TEMPLATE_FILES <-> Dockerfile sync -------------------------------------------------------------------------------------------

describe("BAKED_TEMPLATE_FILES sync", () => {
    test("matches the set of templates-relative COPY sources in the Dockerfile", () => {
        const dockerfile = readFileSync(BASE_TEMPLATE, "utf8");
        // Match COPY [--chown=<owner>] <src> <dst>. Only count <src> values that are a single
        // relative filename (no '/'). Multi-source COPY is not used here.
        const copyRe = /^\s*COPY\s+(?:--chown=\S+\s+)?(\S+)\s+\S+\s*$/gm;
        const dockerfileSources = new Set<string>();
        for (const m of dockerfile.matchAll(copyRe)) {
            const src = m[1];
            if (src && !src.includes("/")) {
                dockerfileSources.add(src);
            }
        }
        const baked = new Set<string>(BAKED_TEMPLATE_FILES);

        const missingFromBaked = [...dockerfileSources].filter((f) => !baked.has(f));
        const missingFromDockerfile = [...baked].filter((f) => !dockerfileSources.has(f));

        assert.deepEqual(
            missingFromBaked,
            [],
            `Dockerfile COPYs reference files not in BAKED_TEMPLATE_FILES: ${missingFromBaked.join(", ")}`,
        );
        assert.deepEqual(
            missingFromDockerfile,
            [],
            `BAKED_TEMPLATE_FILES has entries with no Dockerfile COPY: ${missingFromDockerfile.join(", ")}`,
        );
    });
});
