// =========================================================================================================================================
// tests/docker/migration.test.ts - Docker integration tests for migrate-to-latest
// Tests that migrateProjectsDir() only stops containers belonging to migrated workspaces.
// Run via: pnpm test:docker  (requires Docker, host-only)
// =========================================================================================================================================

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { LOCK_FILE } from "../../src/lib/constants.js";
import { runMigration } from "../../src/lib/migrate-to-latest.js";
import { overrideEnv } from "../helpers.js";
import { cleanTempDir, createTempDir, dockerContainerStatus, forceRemoveContainer, requireDocker, uniqueName } from "./docker-helpers.js";

requireDocker();

describe("migrateProjectsDir - does not stop unrelated containers", () => {
    let bystander: string;
    let tmp: string;
    let fakeHome: string;
    let restoreEnv: Array<() => void>;

    beforeEach(() => {
        tmp = createTempDir();
        fakeHome = join(tmp, "home");
        mkdirSync(fakeHome, { recursive: true });

        // Name starts with "totopo-" so the old (buggy) docker ps filter would have matched it
        bystander = uniqueName("bystander");
        restoreEnv = [overrideEnv("HOME", fakeHome)];

        spawnSync("docker", ["run", "-d", "--name", bystander, "debian:bookworm-slim", "sleep", "infinity"], { stdio: "pipe" });
    });

    afterEach(() => {
        for (const restore of restoreEnv) restore();
        forceRemoveContainer(bystander);
        cleanTempDir(tmp);
    });

    test("leaves a running totopo-* container untouched when its workspace is not in projects/", () => {
        // Set up ~/.totopo/projects/ with a workspace whose container name differs from the bystander
        const workspaceId = "migrated-ws";
        const projectsDir = join(fakeHome, ".totopo", "projects", workspaceId);
        const workspaceRoot = join(tmp, workspaceId);
        mkdirSync(projectsDir, { recursive: true });
        mkdirSync(workspaceRoot, { recursive: true });
        writeFileSync(join(projectsDir, LOCK_FILE), `yaml=${workspaceRoot}\nprofile=default\nlast-cli-update=\n`);

        assert.equal(dockerContainerStatus(bystander), "running", "bystander should be running before migration");

        runMigration(tmp);

        assert.equal(dockerContainerStatus(bystander), "running", "bystander should still be running after migration");
    });
});
