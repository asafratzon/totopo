import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { LOCK_FILE } from "../src/lib/constants.js";
import {
    checkCollision,
    deriveContainerName,
    findOrphanWorkspaceDir,
    findTotopoYamlDir,
    getWorkspaceDir,
    initWorkspaceDir,
    listWorkspaceIds,
    readActiveProfile,
    readLastCliUpdate,
    readLockFile,
    writeActiveProfile,
    writeLastCliUpdate,
    writeLockFile,
} from "../src/lib/workspace-identity.js";
import { cleanTempDir, createTempDir, overrideEnv } from "./helpers.js";

// ---- deriveContainerName (pure function, no HOME needed) --------------------------------------------------------------------------------

describe("deriveContainerName", () => {
    test("prefixes with totopo-", () => {
        assert.equal(deriveContainerName("my-project"), "totopo-my-project");
    });

    test("works with simple IDs", () => {
        assert.equal(deriveContainerName("ab"), "totopo-ab");
    });
});

// ---- findTotopoYamlDir (uses own temp dirs, no HOME needed) -----------------------------------------------------------------------------

describe("findTotopoYamlDir", () => {
    test("finds totopo.yaml in current dir", () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "schema_version: 3\nworkspace_id: test\n");
        assert.equal(findTotopoYamlDir(tmp), tmp);
        cleanTempDir(tmp);
    });

    test("walks up to find totopo.yaml", () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "schema_version: 3\nworkspace_id: test\n");
        const deep = join(tmp, "a", "b", "c");
        mkdirSync(deep, { recursive: true });
        assert.equal(findTotopoYamlDir(deep), tmp);
        cleanTempDir(tmp);
    });

    test("returns null when not found", () => {
        const tmp = createTempDir();
        // Search from a deep subdir; temp dirs are under /tmp/totopo-test-* which won't have totopo.yaml
        const deep = join(tmp, "x", "y");
        mkdirSync(deep, { recursive: true });
        assert.equal(findTotopoYamlDir(deep), null);
        cleanTempDir(tmp);
    });
});

// ---- Tests that write to ~/.totopo/workspaces/ ------------------------------------------------------------------------------------------
// HOME is overridden so all homedir() calls land in an isolated temp directory.

describe("with isolated home", () => {
    let fakeHome: string;
    let homeRoot: string;
    let restoreHome: () => void;

    beforeEach(() => {
        homeRoot = createTempDir();
        fakeHome = join(homeRoot, "home");
        mkdirSync(fakeHome, { recursive: true });
        restoreHome = overrideEnv("HOME", fakeHome);
    });

    afterEach(() => {
        restoreHome();
        cleanTempDir(homeRoot);
    });

    // ---- Lock file operations -----------------------------------------------------------------------------------------------------------

    describe("lock file operations", () => {
        test("initWorkspaceDir creates .lock, agents/, shadows/", () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            const wsDir = getWorkspaceDir("test-ws");
            assert.ok(existsSync(join(wsDir, LOCK_FILE)));
            assert.ok(existsSync(join(wsDir, "agents")));
            assert.ok(existsSync(join(wsDir, "shadows")));
            cleanTempDir(tmp);
        });

        test("readLockFile returns workspace root path", () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(readLockFile("test-ws"), tmp);
            cleanTempDir(tmp);
        });

        test("readLockFile returns null for missing lock", () => {
            assert.equal(readLockFile("nonexistent-ws-id-xyz"), null);
        });

        test("readActiveProfile returns default on fresh init", () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(readActiveProfile("test-ws"), "default");
            cleanTempDir(tmp);
        });

        test("readActiveProfile returns null for missing lock", () => {
            assert.equal(readActiveProfile("nonexistent-ws-id-xyz"), null);
        });

        test("writeActiveProfile updates profile without changing path", () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            writeActiveProfile("test-ws", "slim");
            assert.equal(readActiveProfile("test-ws"), "slim");
            assert.equal(readLockFile("test-ws"), tmp);
            cleanTempDir(tmp);
        });

        test("writeLockFile updates path without changing profile", () => {
            const tmp1 = createTempDir();
            const tmp2 = createTempDir();
            initWorkspaceDir("test-ws", tmp1, "custom");
            writeLockFile("test-ws", tmp2);
            assert.equal(readLockFile("test-ws"), tmp2);
            assert.equal(readActiveProfile("test-ws"), "custom");
            cleanTempDir(tmp1);
            cleanTempDir(tmp2);
        });

        test("initWorkspaceDir with custom profile", () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp, "slim");
            assert.equal(readActiveProfile("test-ws"), "slim");
            cleanTempDir(tmp);
        });

        test("lock file is written in key=value format", () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            const raw = readFileSync(join(getWorkspaceDir("test-ws"), LOCK_FILE), "utf8");
            assert.ok(raw.includes("yaml="), "should contain yaml= key");
            assert.ok(raw.includes("profile="), "should contain profile= key");
            assert.ok(raw.includes("last-cli-update="), "should contain last-cli-update= key");
            cleanTempDir(tmp);
        });

        test("readLastCliUpdate returns empty string when never set", () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(readLastCliUpdate("test-ws"), "");
            cleanTempDir(tmp);
        });

        test("writeLastCliUpdate persists timestamp and preserves other fields", () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp, "slim");
            writeLastCliUpdate("test-ws", "2026-04-05T10:00:00.000Z");
            assert.equal(readLastCliUpdate("test-ws"), "2026-04-05T10:00:00.000Z");
            assert.equal(readLockFile("test-ws"), tmp);
            assert.equal(readActiveProfile("test-ws"), "slim");
            cleanTempDir(tmp);
        });
    });

    // ---- listWorkspaceIds ---------------------------------------------------------------------------------------------------------------

    describe("listWorkspaceIds", () => {
        test("includes initialized workspaces", () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            const ids = listWorkspaceIds();
            assert.ok(ids.includes("test-ws"));
            cleanTempDir(tmp);
        });
    });

    // ---- checkCollision -----------------------------------------------------------------------------------------------------------------

    describe("checkCollision", () => {
        test("returns ok when lock matches path", () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(checkCollision("test-ws", tmp), "ok");
            cleanTempDir(tmp);
        });

        test("returns collision when lock points elsewhere", () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(checkCollision("test-ws", "/some/other/path"), "collision");
            cleanTempDir(tmp);
        });

        test("returns ok when no lock exists", () => {
            assert.equal(checkCollision("nonexistent-ws-id-xyz", "/any/path"), "ok");
        });
    });

    // ---- findOrphanWorkspaceDir ---------------------------------------------------------------------------------------------------------

    describe("findOrphanWorkspaceDir", () => {
        test("finds orphan by path", () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(findOrphanWorkspaceDir(tmp), "test-ws");
            cleanTempDir(tmp);
        });

        test("returns null when no orphan", () => {
            assert.equal(findOrphanWorkspaceDir("/nonexistent/path/xyz"), null);
        });
    });
});
