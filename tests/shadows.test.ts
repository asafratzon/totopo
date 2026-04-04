import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildShadowMountArgs, countPatternHits, ensureShadowsInSync, expandShadowPatterns } from "../src/lib/shadows.js";
import { cleanTempDir, createTempDir } from "./helpers.js";

// ---- expandShadowPatterns ---------------------------------------------------------------------------------------------------------------

describe("expandShadowPatterns", () => {
    test("empty patterns returns empty array", () => {
        const tmp = createTempDir();
        assert.deepEqual(expandShadowPatterns([], tmp), []);
        cleanTempDir(tmp);
    });

    test("pattern without / matches recursively", () => {
        const tmp = createTempDir();
        mkdirSync(join(tmp, "node_modules"), { recursive: true });
        mkdirSync(join(tmp, "packages", "a", "node_modules"), { recursive: true });
        const result = expandShadowPatterns(["node_modules"], tmp);
        assert.ok(result.includes("node_modules"));
        assert.ok(result.includes("packages/a/node_modules"));
        cleanTempDir(tmp);
    });

    test("wildcard pattern matches multiple files", () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, ".env"), "");
        writeFileSync(join(tmp, ".env.local"), "");
        writeFileSync(join(tmp, ".env.production"), "");
        writeFileSync(join(tmp, "unrelated.txt"), "");
        const result = expandShadowPatterns([".env*"], tmp);
        assert.equal(result.length, 3);
        assert.ok(result.includes(".env"));
        assert.ok(result.includes(".env.local"));
        assert.ok(result.includes(".env.production"));
        cleanTempDir(tmp);
    });

    test("results are sorted", () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, ".env.z"), "");
        writeFileSync(join(tmp, ".env.a"), "");
        writeFileSync(join(tmp, ".env.m"), "");
        const result = expandShadowPatterns([".env*"], tmp);
        const sorted = [...result].sort();
        assert.deepEqual(result, sorted);
        cleanTempDir(tmp);
    });

    test("no matches returns empty array", () => {
        const tmp = createTempDir();
        const result = expandShadowPatterns(["nonexistent*"], tmp);
        assert.deepEqual(result, []);
        cleanTempDir(tmp);
    });
});

// ---- countPatternHits -------------------------------------------------------------------------------------------------------------------

describe("countPatternHits", () => {
    test("returns 0 for no matches", () => {
        const tmp = createTempDir();
        assert.equal(countPatternHits("nonexistent", tmp), 0);
        cleanTempDir(tmp);
    });

    test("returns correct count", () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, ".env"), "");
        writeFileSync(join(tmp, ".env.local"), "");
        assert.equal(countPatternHits(".env*", tmp), 2);
        cleanTempDir(tmp);
    });
});

// ---- ensureShadowsInSync ----------------------------------------------------------------------------------------------------------------

describe("ensureShadowsInSync", () => {
    test("creates shadow dirs for expanded paths", () => {
        const tmp = createTempDir();
        const workspace = join(tmp, "workspace");
        const cache = join(tmp, "cache");
        mkdirSync(join(workspace, "node_modules"), { recursive: true });
        mkdirSync(cache, { recursive: true });

        ensureShadowsInSync(cache, ["node_modules"], workspace);
        assert.ok(existsSync(join(cache, "shadows", "node_modules")));
        cleanTempDir(tmp);
    });

    test("removes stale shadow entries", () => {
        const tmp = createTempDir();
        const workspace = join(tmp, "workspace");
        const cache = join(tmp, "cache");
        mkdirSync(workspace, { recursive: true });
        mkdirSync(join(cache, "shadows", "old-dir"), { recursive: true });

        ensureShadowsInSync(cache, [], workspace);
        assert.ok(!existsSync(join(cache, "shadows", "old-dir")));
        cleanTempDir(tmp);
    });

    test("idempotent - running twice is safe", () => {
        const tmp = createTempDir();
        const workspace = join(tmp, "workspace");
        const cache = join(tmp, "cache");
        mkdirSync(join(workspace, "node_modules"), { recursive: true });
        mkdirSync(cache, { recursive: true });

        ensureShadowsInSync(cache, ["node_modules"], workspace);
        ensureShadowsInSync(cache, ["node_modules"], workspace);
        assert.ok(existsSync(join(cache, "shadows", "node_modules")));
        cleanTempDir(tmp);
    });

    test("creates empty file for file sources", () => {
        const tmp = createTempDir();
        const workspace = join(tmp, "workspace");
        const cache = join(tmp, "cache");
        mkdirSync(workspace, { recursive: true });
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(workspace, ".env"), "SECRET=1");

        ensureShadowsInSync(cache, [".env"], workspace);
        assert.ok(existsSync(join(cache, "shadows", ".env")));
        cleanTempDir(tmp);
    });
});

// ---- buildShadowMountArgs ---------------------------------------------------------------------------------------------------------------

describe("buildShadowMountArgs", () => {
    test("empty paths returns empty array", () => {
        assert.deepEqual(buildShadowMountArgs("/cache", []), []);
    });

    test("returns -v pairs for each path", () => {
        const args = buildShadowMountArgs("/cache", ["node_modules", ".env"]);
        assert.equal(args.length, 4);
        assert.equal(args[0], "-v");
        assert.ok(args[1]?.includes("node_modules"));
        assert.ok(args[1]?.includes("/workspace/node_modules"));
        assert.equal(args[2], "-v");
        assert.ok(args[3]?.includes(".env"));
    });

    test("host path uses shadows subdirectory", () => {
        const args = buildShadowMountArgs("/home/.totopo/workspaces/test", ["node_modules"]);
        assert.equal(args[1], "/home/.totopo/workspaces/test/shadows/node_modules:/workspace/node_modules");
    });
});
