import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildShadowMountArgs, countPatternHits, ensureShadowsInSync, expandShadowPatterns } from "../src/lib/shadows.js";
import { cleanTempDir, createTempDir, initGitRepo } from "./helpers.js";

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
    test("empty patterns returns empty result", async () => {
        const tmp = createTempDir();
        assert.deepEqual(expandShadowPatterns([], tmp), { paths: [], skippedTracked: [] });
        await cleanTempDir(tmp);
    });

    test("pattern without / matches recursively", async () => {
        const tmp = createTempDir();
        mkdirSync(join(tmp, "node_modules"), { recursive: true });
        mkdirSync(join(tmp, "packages", "a", "node_modules"), { recursive: true });
        const { paths } = expandShadowPatterns(["node_modules"], tmp);
        assert.ok(paths.includes("node_modules"));
        assert.ok(paths.includes("packages/a/node_modules"));
        await cleanTempDir(tmp);
    });

    test("wildcard pattern matches multiple files", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, ".env"), "");
        writeFileSync(join(tmp, ".env.local"), "");
        writeFileSync(join(tmp, ".env.production"), "");
        writeFileSync(join(tmp, "unrelated.txt"), "");
        const { paths } = expandShadowPatterns([".env*"], tmp);
        assert.equal(paths.length, 3);
        assert.ok(paths.includes(".env"));
        assert.ok(paths.includes(".env.local"));
        assert.ok(paths.includes(".env.production"));
        await cleanTempDir(tmp);
    });

    test("results are sorted", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, ".env.z"), "");
        writeFileSync(join(tmp, ".env.a"), "");
        writeFileSync(join(tmp, ".env.m"), "");
        const { paths } = expandShadowPatterns([".env*"], tmp);
        const sorted = [...paths].sort();
        assert.deepEqual(paths, sorted);
        await cleanTempDir(tmp);
    });

    test("no matches returns empty paths", async () => {
        const tmp = createTempDir();
        const result = expandShadowPatterns(["nonexistent*"], tmp);
        assert.deepEqual(result.paths, []);
        assert.deepEqual(result.skippedTracked, []);
        await cleanTempDir(tmp);
    });

    test("result has no nested or duplicate paths across a complex tree", async () => {
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

        const { paths } = expandShadowPatterns(
            ["node_modules", ".next", "dist", "build", "out", ".env.production*", "foo", "foobar", "distribution"],
            tmp,
        );

        assertNoNesting(paths);

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
            assert.ok(paths.includes(p), `missing ${p} in ${JSON.stringify(paths)}`);
        }
        await cleanTempDir(tmp);
    });
});

// ---- expandShadowPatterns - git tracked filtering ---------------------------------------------------------------------------------------

describe("expandShadowPatterns - git tracked filtering", () => {
    test("tracked file is dropped and reported in skippedTracked", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "secret.env"), "TRACKED=1");
        initGitRepo(tmp);
        spawnSync("git", ["add", "secret.env"], { cwd: tmp, stdio: "pipe" });
        spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp, stdio: "pipe" });

        const result = expandShadowPatterns(["secret.env"], tmp);
        assert.deepEqual(result.paths, []);
        assert.deepEqual(result.skippedTracked, ["secret.env"]);
        await cleanTempDir(tmp);
    });

    test("directory containing any tracked file is dropped", async () => {
        const tmp = createTempDir();
        mkdirSync(join(tmp, "vendored"), { recursive: true });
        writeFileSync(join(tmp, "vendored", "lib.js"), "// vendored");
        initGitRepo(tmp);
        spawnSync("git", ["add", "vendored/lib.js"], { cwd: tmp, stdio: "pipe" });
        spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp, stdio: "pipe" });

        const result = expandShadowPatterns(["vendored"], tmp);
        assert.deepEqual(result.paths, []);
        assert.deepEqual(result.skippedTracked, ["vendored"]);
        await cleanTempDir(tmp);
    });

    test("gitignored path is kept", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, ".gitignore"), ".env\n");
        writeFileSync(join(tmp, ".env"), "SECRET=1");
        initGitRepo(tmp);
        spawnSync("git", ["add", ".gitignore"], { cwd: tmp, stdio: "pipe" });
        spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp, stdio: "pipe" });

        const result = expandShadowPatterns([".env"], tmp);
        assert.deepEqual(result.paths, [".env"]);
        assert.deepEqual(result.skippedTracked, []);
        await cleanTempDir(tmp);
    });

    test("untracked new file is kept", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "README.md"), "");
        initGitRepo(tmp);
        spawnSync("git", ["add", "README.md"], { cwd: tmp, stdio: "pipe" });
        spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp, stdio: "pipe" });
        // Add a new untracked file after the commit
        writeFileSync(join(tmp, ".env"), "SECRET=1");

        const result = expandShadowPatterns([".env"], tmp);
        assert.deepEqual(result.paths, [".env"]);
        assert.deepEqual(result.skippedTracked, []);
        await cleanTempDir(tmp);
    });

    test("git add -f on a gitignored file makes it tracked and dropped", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, ".gitignore"), ".env\n");
        writeFileSync(join(tmp, ".env"), "FORCED=1");
        initGitRepo(tmp);
        spawnSync("git", ["add", ".gitignore"], { cwd: tmp, stdio: "pipe" });
        spawnSync("git", ["add", "-f", ".env"], { cwd: tmp, stdio: "pipe" });
        spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp, stdio: "pipe" });

        const result = expandShadowPatterns([".env"], tmp);
        assert.deepEqual(result.paths, []);
        assert.deepEqual(result.skippedTracked, [".env"]);
        await cleanTempDir(tmp);
    });

    test("no .git present means no filter runs", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, ".env"), "");
        const result = expandShadowPatterns([".env"], tmp);
        assert.deepEqual(result.paths, [".env"]);
        assert.deepEqual(result.skippedTracked, []);
        await cleanTempDir(tmp);
    });
});

// ---- countPatternHits -------------------------------------------------------------------------------------------------------------------

describe("countPatternHits", () => {
    test("returns 0 for no matches", async () => {
        const tmp = createTempDir();
        assert.equal(countPatternHits("nonexistent", tmp), 0);
        await cleanTempDir(tmp);
    });

    test("returns correct count", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, ".env"), "");
        writeFileSync(join(tmp, ".env.local"), "");
        assert.equal(countPatternHits(".env*", tmp), 2);
        await cleanTempDir(tmp);
    });
});

// ---- ensureShadowsInSync ----------------------------------------------------------------------------------------------------------------

describe("ensureShadowsInSync", () => {
    test("creates shadow dirs for expanded paths", async () => {
        const tmp = createTempDir();
        const workspace = join(tmp, "workspace");
        const cache = join(tmp, "cache");
        mkdirSync(join(workspace, "node_modules"), { recursive: true });
        mkdirSync(cache, { recursive: true });

        ensureShadowsInSync(cache, ["node_modules"], workspace);
        assert.ok(existsSync(join(cache, "shadows", "node_modules")));
        await cleanTempDir(tmp);
    });

    test("removes stale shadow entries", async () => {
        const tmp = createTempDir();
        const workspace = join(tmp, "workspace");
        const cache = join(tmp, "cache");
        mkdirSync(workspace, { recursive: true });
        mkdirSync(join(cache, "shadows", "old-dir"), { recursive: true });

        ensureShadowsInSync(cache, [], workspace);
        assert.ok(!existsSync(join(cache, "shadows", "old-dir")));
        await cleanTempDir(tmp);
    });

    test("idempotent - running twice is safe", async () => {
        const tmp = createTempDir();
        const workspace = join(tmp, "workspace");
        const cache = join(tmp, "cache");
        mkdirSync(join(workspace, "node_modules"), { recursive: true });
        mkdirSync(cache, { recursive: true });

        ensureShadowsInSync(cache, ["node_modules"], workspace);
        ensureShadowsInSync(cache, ["node_modules"], workspace);
        assert.ok(existsSync(join(cache, "shadows", "node_modules")));
        await cleanTempDir(tmp);
    });

    test("creates empty file for file sources", async () => {
        const tmp = createTempDir();
        const workspace = join(tmp, "workspace");
        const cache = join(tmp, "cache");
        mkdirSync(workspace, { recursive: true });
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(workspace, ".env"), "SECRET=1");

        ensureShadowsInSync(cache, [".env"], workspace);
        assert.ok(existsSync(join(cache, "shadows", ".env")));
        await cleanTempDir(tmp);
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
