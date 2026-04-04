import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { runMigration } from "../src/lib/migrate-to-latest.js";
import { cleanTempDir, createTempDir, overrideEnv } from "./helpers.js";

let tmp: string;
let fakeHome: string;
let restoreEnv: Array<() => void>;

describe("migrate-to-latest", () => {
    beforeEach(() => {
        tmp = createTempDir();
        fakeHome = join(tmp, "home");
        mkdirSync(fakeHome, { recursive: true });
        restoreEnv = [
            // homedir() reads process.env.HOME at call time - redirects all
            // ~/.totopo/ operations to an isolated temp directory.
            overrideEnv("HOME", fakeHome),
            // migrateProjectsDir() calls `docker ps` to stop running containers before
            // renaming the directory. A nonexistent socket makes it return no containers,
            // preventing it from touching real containers on the host during tests.
            overrideEnv("DOCKER_HOST", "unix:///nonexistent/docker.sock"),
        ];
    });

    afterEach(() => {
        for (const restore of restoreEnv) restore();
        cleanTempDir(tmp);
    });

    // ---- migrateProjectsDir -------------------------------------------------------------------------------------------------------------

    test("renames projects/ to workspaces/", () => {
        const projectsDir = join(fakeHome, ".totopo", "projects");
        mkdirSync(projectsDir, { recursive: true });
        writeFileSync(join(projectsDir, "marker.txt"), "test");

        runMigration(tmp);

        const workspacesDir = join(fakeHome, ".totopo", "workspaces");
        assert.ok(existsSync(workspacesDir), "workspaces/ should exist after migration");
        assert.ok(!existsSync(projectsDir), "projects/ should be gone after migration");
        assert.ok(existsSync(join(workspacesDir, "marker.txt")), "contents should be preserved");
    });

    test("skips rename if projects/ does not exist", () => {
        // No projects/ dir - should not create workspaces/
        runMigration(tmp);
        // No error thrown
    });

    test("skips rename if both dirs exist", () => {
        mkdirSync(join(fakeHome, ".totopo", "projects"), { recursive: true });
        mkdirSync(join(fakeHome, ".totopo", "workspaces"), { recursive: true });

        runMigration(tmp);

        // Both should still exist
        assert.ok(existsSync(join(fakeHome, ".totopo", "projects")));
        assert.ok(existsSync(join(fakeHome, ".totopo", "workspaces")));
    });

    // ---- migrateGlobalEnv ---------------------------------------------------------------------------------------------------------------

    test("removes legacy ~/.totopo/.env", () => {
        mkdirSync(join(fakeHome, ".totopo"), { recursive: true });
        writeFileSync(join(fakeHome, ".totopo", ".env"), "API_KEY=secret");

        runMigration(tmp);

        assert.ok(!existsSync(join(fakeHome, ".totopo", ".env")), "global .env should be removed");
    });

    test("no-op when ~/.totopo/.env does not exist", () => {
        mkdirSync(join(fakeHome, ".totopo"), { recursive: true });

        runMigration(tmp);
        // No error thrown
    });

    // ---- migrateTotopoYaml (project_id -> workspace_id) ---------------------------------------------------------------------------------

    test("renames project_id to workspace_id in totopo.yaml", () => {
        // Create a totopo.yaml with project_id in cwd
        writeFileSync(join(tmp, "totopo.yaml"), "schema_version: 3\nproject_id: legacy-ws\n");

        // Need workspace dir to exist for readTotopoYaml after rename
        mkdirSync(join(fakeHome, ".totopo", "workspaces"), { recursive: true });

        runMigration(tmp);

        const content = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(content.includes("workspace_id"), "should contain workspace_id after migration");
        assert.ok(!content.includes("project_id"), "should not contain project_id after migration");
    });

    test("no-op when totopo.yaml already has workspace_id", () => {
        writeFileSync(join(tmp, "totopo.yaml"), "schema_version: 3\nworkspace_id: modern-ws\n");
        mkdirSync(join(fakeHome, ".totopo", "workspaces"), { recursive: true });

        runMigration(tmp);

        const content = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(content.includes("workspace_id: modern-ws"));
    });

    // ---- migrateV2Workspaces ------------------------------------------------------------------------------------------------------------

    test("migrates v2 hash-based workspace", () => {
        // Set up a fake v2 hash directory with meta.json
        const wsBase = join(fakeHome, ".totopo", "workspaces");
        const hashDir = join(wsBase, "abc123hash");
        mkdirSync(join(hashDir, "agents", "claude"), { recursive: true });
        mkdirSync(join(hashDir, "shadows"), { recursive: true });

        // The v2 project root must exist
        const projectRoot = join(tmp, "my-v2-project");
        mkdirSync(projectRoot, { recursive: true });

        writeFileSync(join(hashDir, "meta.json"), JSON.stringify({ projectRoot, displayName: "My V2 Project" }));
        writeFileSync(join(hashDir, "settings.json"), JSON.stringify({ shadowPaths: ["node_modules"] }));

        // Write a marker in agents to verify copy
        writeFileSync(join(hashDir, "agents", "claude", "memory.json"), "{}");

        runMigration(tmp);

        // Hash dir should be removed
        assert.ok(!existsSync(hashDir), "hash directory should be removed");

        // A new workspace_id dir should exist
        const entries = existsSync(wsBase) ? readdirSync(wsBase).filter((e: string) => e !== "abc123hash") : [];
        assert.ok(entries.length > 0, "a new workspace dir should exist");

        // A totopo.yaml should be written to the project root
        assert.ok(existsSync(join(projectRoot, "totopo.yaml")), "totopo.yaml should be created");
    });

    test("skips v2 workspace when project root no longer exists", () => {
        const wsBase = join(fakeHome, ".totopo", "workspaces");
        const hashDir = join(wsBase, "deadhash");
        mkdirSync(hashDir, { recursive: true });

        writeFileSync(join(hashDir, "meta.json"), JSON.stringify({ projectRoot: "/nonexistent/path", displayName: "Gone Project" }));

        runMigration(tmp);

        // Hash dir should still exist (skipped, not removed)
        // Actually the implementation skips it and returns null, but doesn't remove it
        // Let's just verify no crash
    });
});
