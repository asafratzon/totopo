import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type EnvConfig, envLabel, envRunArgs, envWarnings, validateEnvConfig } from "../src/lib/env.js";
import { cleanTempDir, createTempDir } from "./helpers.js";

// ---- validateEnvConfig ------------------------------------------------------------------------------------------------------------------

describe("validateEnvConfig", () => {
    test("classifies an inline KEY=VALUE entry (has '=') as an inline var", async () => {
        const tmp = createTempDir();
        const cfg = validateEnvConfig("FOO=bar", tmp);
        assert.deepEqual(cfg.inlineVars, ["FOO=bar"]);
        assert.deepEqual(cfg.files, []);
        await cleanTempDir(tmp);
    });

    test("classifies a path entry (no '=') as a file, resolved relative to the workspace dir", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, ".env"), "A=1\n");
        const cfg = validateEnvConfig(".env", tmp);
        assert.deepEqual(cfg.inlineVars, []);
        assert.deepEqual(cfg.files, [{ path: join(tmp, ".env"), exists: true }]);
        await cleanTempDir(tmp);
    });

    test("normalizes a scalar to a single entry", async () => {
        const tmp = createTempDir();
        const cfg = validateEnvConfig("FOO=bar", tmp);
        assert.deepEqual(cfg.inlineVars, ["FOO=bar"]);
        await cleanTempDir(tmp);
    });

    test("returns an empty config for undefined", async () => {
        const tmp = createTempDir();
        assert.deepEqual(validateEnvConfig(undefined, tmp), { inlineVars: [], files: [] });
        await cleanTempDir(tmp);
    });

    test("handles a mixed list, preserving classification and order within each group", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, ".env"), "A=1\n");
        const cfg = validateEnvConfig([".env", "FOO=bar", "BAZ=qux"], tmp);
        assert.deepEqual(cfg.inlineVars, ["FOO=bar", "BAZ=qux"]);
        assert.deepEqual(cfg.files, [{ path: join(tmp, ".env"), exists: true }]);
        await cleanTempDir(tmp);
    });

    test("trims entries and drops empty strings", async () => {
        const tmp = createTempDir();
        const cfg = validateEnvConfig(["  FOO=bar  ", "", "   "], tmp);
        assert.deepEqual(cfg.inlineVars, ["FOO=bar"]);
        assert.deepEqual(cfg.files, []);
        await cleanTempDir(tmp);
    });

    test("flags a missing file as exists:false without throwing", async () => {
        const tmp = createTempDir();
        const cfg = validateEnvConfig(".env.missing", tmp);
        assert.deepEqual(cfg.files, [{ path: join(tmp, ".env.missing"), exists: false }]);
        await cleanTempDir(tmp);
    });

    test("keeps an inline value that itself contains '='", async () => {
        const tmp = createTempDir();
        const cfg = validateEnvConfig("DATABASE_URL=postgres://u:p@h/db?sslmode=require", tmp);
        assert.deepEqual(cfg.inlineVars, ["DATABASE_URL=postgres://u:p@h/db?sslmode=require"]);
        await cleanTempDir(tmp);
    });

    test("accepts an inline entry with an empty value", async () => {
        const tmp = createTempDir();
        const cfg = validateEnvConfig("EMPTY=", tmp);
        assert.deepEqual(cfg.inlineVars, ["EMPTY="]);
        await cleanTempDir(tmp);
    });

    test("rejects an inline entry with an invalid key", async () => {
        const tmp = createTempDir();
        assert.throws(() => validateEnvConfig("1BAD=x", tmp), /invalid variable "1BAD=x"/);
        assert.throws(() => validateEnvConfig("=novalue", tmp), /invalid variable "=novalue"/);
        assert.throws(() => validateEnvConfig("has space=x", tmp), /invalid variable/);
        await cleanTempDir(tmp);
    });
});

// ---- envRunArgs -------------------------------------------------------------------------------------------------------------------------

describe("envRunArgs", () => {
    test("emits --env-file for existing files before -e for inline vars", () => {
        const cfg: EnvConfig = {
            inlineVars: ["FOO=bar"],
            files: [{ path: "/ws/.env", exists: true }],
        };
        assert.deepEqual(envRunArgs(cfg), ["--env-file", "/ws/.env", "-e", "FOO=bar"]);
    });

    test("omits missing files", () => {
        const cfg: EnvConfig = {
            inlineVars: [],
            files: [
                { path: "/ws/.env", exists: true },
                { path: "/ws/.env.missing", exists: false },
            ],
        };
        assert.deepEqual(envRunArgs(cfg), ["--env-file", "/ws/.env"]);
    });

    test("preserves order within each group", () => {
        const cfg: EnvConfig = {
            inlineVars: ["A=1", "B=2"],
            files: [
                { path: "/ws/.env", exists: true },
                { path: "/ws/.env.local", exists: true },
            ],
        };
        assert.deepEqual(envRunArgs(cfg), ["--env-file", "/ws/.env", "--env-file", "/ws/.env.local", "-e", "A=1", "-e", "B=2"]);
    });

    test("returns nothing for an empty config", () => {
        assert.deepEqual(envRunArgs({ inlineVars: [], files: [] }), []);
    });
});

// ---- envWarnings ------------------------------------------------------------------------------------------------------------------------

describe("envWarnings", () => {
    test("one warning per missing file, naming the resolved path", () => {
        const cfg: EnvConfig = {
            inlineVars: ["FOO=bar"],
            files: [
                { path: "/ws/.env", exists: true },
                { path: "/ws/.env.missing", exists: false },
            ],
        };
        assert.deepEqual(envWarnings(cfg), ['env "/ws/.env.missing" not found - skipping']);
    });

    test("no warnings when every file exists", () => {
        const cfg: EnvConfig = { inlineVars: [], files: [{ path: "/ws/.env", exists: true }] };
        assert.deepEqual(envWarnings(cfg), []);
    });
});

// ---- envLabel ---------------------------------------------------------------------------------------------------------------------------

describe("envLabel", () => {
    test("empty config fingerprints to the empty string (no spurious recreate)", () => {
        assert.equal(envLabel({ inlineVars: [], files: [] }), "");
    });

    test("a config whose only files are missing fingerprints to the empty string", () => {
        assert.equal(envLabel({ inlineVars: [], files: [{ path: "/ws/.env.missing", exists: false }] }), "");
    });

    test("is stable for the same inline vars and matches the 12-hex shape", () => {
        const cfg: EnvConfig = { inlineVars: ["FOO=bar"], files: [] };
        assert.equal(envLabel(cfg), envLabel(cfg));
        assert.match(envLabel(cfg), /^[0-9a-f]{12}$/);
    });

    test("changes when an inline var changes", () => {
        assert.notEqual(envLabel({ inlineVars: ["FOO=bar"], files: [] }), envLabel({ inlineVars: ["FOO=baz"], files: [] }));
    });

    test("changes when a referenced file's contents change", async () => {
        const tmp = createTempDir();
        const path = join(tmp, ".env");
        writeFileSync(path, "A=1\n");
        const before = envLabel({ inlineVars: [], files: [{ path, exists: true }] });
        writeFileSync(path, "A=2\n");
        const after = envLabel({ inlineVars: [], files: [{ path, exists: true }] });
        assert.notEqual(before, after);
        await cleanTempDir(tmp);
    });

    test("changes when a file appears where there was none", async () => {
        const tmp = createTempDir();
        const path = join(tmp, ".env");
        assert.equal(envLabel({ inlineVars: [], files: [{ path, exists: false }] }), "");
        writeFileSync(path, "A=1\n");
        assert.match(envLabel({ inlineVars: [], files: [{ path, exists: true }] }), /^[0-9a-f]{12}$/);
        await cleanTempDir(tmp);
    });
});
