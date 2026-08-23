import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { RESUME_MARKER_PATH, WEB_KEY_FILE_PATH } from "../src/lib/constants.js";
import { BAKED_TEMPLATE_DIRS, BAKED_TEMPLATE_FILES, buildDockerfile, computeBuildHash } from "../src/lib/dockerfile-builder.js";
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

    test("greeting and auto-start hook are wired to the web interface", () => {
        const result = buildDockerfile(BASE_TEMPLATE);
        // The web greeting hint and the shell-autostart handoff both key off TOTOPO_WEB_URL.
        assert.ok(result.includes("$TOTOPO_WEB_URL"));
        assert.ok(result.includes("webterm"));
        // The autostart hook consumes the host-planted resume marker (mv-claim, then run its content).
        assert.ok(result.includes(RESUME_MARKER_PATH));
        assert.ok(result.includes(`${RESUME_MARKER_PATH}.shell`));
        // Web on means the shell must not launch the agent - the gate includes the web env check.
        assert.ok(result.includes('[ -z "$TOTOPO_WEB_URL" ]'));
        // With auto-start on, the greeting announces the web interface (URL block), and the plain
        // webterm hint shows only when auto-start is off.
        assert.ok(result.includes('[ -n "$TOTOPO_WEB_URL" ] && [ -n "$TOTOPO_AUTOSTART" ]'));
        assert.ok(result.includes('[ -n "$TOTOPO_WEB_URL" ] && [ -z "$TOTOPO_AUTOSTART" ]'));
        // The hint must show that webterm takes the agent as an argument - it never picks one itself.
        assert.ok(result.includes("webterm <agent>"));
        // The announced URL is composed at greeting time, not baked: the interface mints a new key at every
        // start, so a greeting echoing the bare env var would hand out a URL the relay refuses.
        assert.ok(result.includes("__totopo_web_url()"), "the greeting needs the helper that reads the live key");
        assert.ok(result.includes(WEB_KEY_FILE_PATH), "the helper must read the key from the file the server publishes");
        assert.ok(result.includes("$(__totopo_web_url)"), "the announced URL must come from the helper");
    });

    test("the AI CLI freshness stamp is written by the same RUN that installs them", () => {
        const base = readFileSync(BASE_TEMPLATE, "utf8");
        const start = base.indexOf("RUN npm install -g");
        assert.ok(start !== -1, "expected a global npm install layer");
        // A RUN block runs to the first line that does not continue with a backslash.
        const block: string[] = [];
        for (const line of base.slice(start).split("\n")) {
            block.push(line);
            if (!line.trimEnd().endsWith("\\")) break;
        }
        const runBlock = block.join("\n");
        // Docker caches the install layer, so a stamp written by any later layer can claim the CLIs are
        // fresh when the cache handed over months-old ones - and startup.mjs skips its update on that claim.
        assert.ok(runBlock.includes("date -u"));
        assert.ok(runBlock.includes("/usr/local/share/ai-cli-installed"));
        // Later layers may only copy the stamp forward. A second date call would defeat the point.
        assert.ok(!base.slice(start + runBlock.length).includes("date -u"));
        assert.ok(base.includes("cp /usr/local/share/ai-cli-installed /home/devuser/.ai-cli-updated"));
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

    test("changing a file inside a baked template dir changes the hash", async () => {
        const fixtureDir = createTempDir();
        try {
            mkdirSync(join(fixtureDir, "webterm", "public", "app"), { recursive: true });
            writeFileSync(join(fixtureDir, "webterm", "server.js"), "// server\n");
            writeFileSync(join(fixtureDir, "webterm", "public", "app", "main.js"), "// app\n");

            const content = buildDockerfile(BASE_TEMPLATE);
            const baseline = computeBuildHash(content, fixtureDir);

            writeFileSync(join(fixtureDir, "webterm", "public", "app", "main.js"), "// app drift\n");
            assert.notEqual(computeBuildHash(content, fixtureDir), baseline);
        } finally {
            await cleanTempDir(fixtureDir);
        }
    });

    test("node_modules inside a baked template dir never affects the hash", async () => {
        const fixtureDir = createTempDir();
        try {
            mkdirSync(join(fixtureDir, "webterm"), { recursive: true });
            writeFileSync(join(fixtureDir, "webterm", "server.js"), "// server\n");

            const content = buildDockerfile(BASE_TEMPLATE);
            const baseline = computeBuildHash(content, fixtureDir);

            // A local install must not flip the hash (it is .dockerignore'd out of the build context too).
            mkdirSync(join(fixtureDir, "webterm", "node_modules", "express"), { recursive: true });
            writeFileSync(join(fixtureDir, "webterm", "node_modules", "express", "index.js"), "// dep\n");
            assert.equal(computeBuildHash(content, fixtureDir), baseline);
        } finally {
            await cleanTempDir(fixtureDir);
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

    test("BAKED_TEMPLATE_DIRS matches the set of directory COPY sources in the Dockerfile", () => {
        const dockerfile = readFileSync(BASE_TEMPLATE, "utf8");
        // Directory COPY sources are written with a trailing slash (COPY webterm/ <dst>). They bypass the
        // single-filename set above, so they must be registered in BAKED_TEMPLATE_DIRS for the build hash.
        const copyRe = /^\s*COPY\s+(?:--chown=\S+\s+)?(\S+)\/\s+\S+\s*$/gm;
        const dockerfileDirs = new Set<string>();
        for (const m of dockerfile.matchAll(copyRe)) {
            if (m[1]) dockerfileDirs.add(m[1]);
        }
        const baked = new Set<string>(BAKED_TEMPLATE_DIRS);

        const missingFromBaked = [...dockerfileDirs].filter((d) => !baked.has(d));
        const missingFromDockerfile = [...baked].filter((d) => !dockerfileDirs.has(d));

        assert.deepEqual(
            missingFromBaked,
            [],
            `Dockerfile COPYs reference dirs not in BAKED_TEMPLATE_DIRS: ${missingFromBaked.join(", ")}`,
        );
        assert.deepEqual(
            missingFromDockerfile,
            [],
            `BAKED_TEMPLATE_DIRS has entries with no Dockerfile COPY: ${missingFromDockerfile.join(", ")}`,
        );
    });
});
