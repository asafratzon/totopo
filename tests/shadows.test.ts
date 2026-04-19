import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildShadowMountArgs, countPatternHits, ensureShadowsInSync, expandShadowPatterns } from "../src/lib/shadows.js";
import { cleanTempDir, createTempDir } from "./helpers.js";

// Invariant: no path in the list equals or is nested under another.
function assertNoNesting(paths: string[]): void {
    assert.equal(new Set(paths).size, paths.length, `duplicates in ${JSON.stringify(paths)}`);
    for (const a of paths) {
        for (const b of paths) {
            if (a !== b) assert.ok(!b.startsWith(`${a}/`), `${b} is nested under ${a} in ${JSON.stringify(paths)}`);
        }
    }
}

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

    test("result has no nested or duplicate paths across a complex tree", () => {
        const tmp = createTempDir();
        // Shadowed dirs whose descendants would themselves match other patterns
        mkdirSync(join(tmp, "apps", "orot-core", ".next", "dev", "node_modules"), { recursive: true });
        mkdirSync(join(tmp, "apps", "orot-core", ".next", "server"), { recursive: true });
        mkdirSync(join(tmp, "apps", "api", "dist", "node_modules"), { recursive: true });
        mkdirSync(join(tmp, "apps", "api", "dist", "src"), { recursive: true });
        mkdirSync(join(tmp, "packages", "core", "build", "out", "deep", "node_modules"), { recursive: true });
        // Siblings at various depths, each their own outermost shadow
        mkdirSync(join(tmp, "packages", "core", "node_modules"), { recursive: true });
        mkdirSync(join(tmp, "packages", "ui", "dist"), { recursive: true });
        mkdirSync(join(tmp, "packages", "ui", "build"), { recursive: true });
        mkdirSync(join(tmp, "node_modules"), { recursive: true });
        mkdirSync(join(tmp, "dist"), { recursive: true });
        // Name-prefix traps (foo vs foobar, dist vs distribution)
        mkdirSync(join(tmp, "foo"), { recursive: true });
        mkdirSync(join(tmp, "foobar"), { recursive: true });
        mkdirSync(join(tmp, "distribution"), { recursive: true });
        // File matches via wildcard
        writeFileSync(join(tmp, ".env.production"), "");
        writeFileSync(join(tmp, "apps", "orot-core", ".env.production.local"), "");

        const result = expandShadowPatterns(
            ["node_modules", ".next", "dist", "build", "out", ".env.production*", "foo", "foobar", "distribution"],
            tmp,
        );

        assertNoNesting(result);

        // Every outermost shadow must survive (guards against over-filtering)
        for (const p of [
            ".env.production",
            "apps/api/dist",
            "apps/orot-core/.env.production.local",
            "apps/orot-core/.next",
            "dist",
            "distribution",
            "foo",
            "foobar",
            "node_modules",
            "packages/core/build",
            "packages/core/node_modules",
            "packages/ui/build",
            "packages/ui/dist",
        ]) {
            assert.ok(result.includes(p), `missing ${p} in ${JSON.stringify(result)}`);
        }
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
