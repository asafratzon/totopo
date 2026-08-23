import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { DEFAULT_PROFILE, GIT_MODE, LOCK_FILE, LOCK_VERSION } from "../src/lib/constants.js";
import {
    checkCollision,
    deriveContainerName,
    findOrphanWorkspaceDir,
    findTotopoYamlDir,
    getWorkspaceDir,
    initWorkspaceDir,
    LOCK_KEYS,
    listWorkspaceIds,
    readActiveProfile,
    readGitMode,
    readLockFile,
    readLockVersion,
    readWebPort,
    writeActiveProfile,
    writeGitMode,
    writeLockFile,
    writeWebPort,
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
    test("finds totopo.yaml in current dir", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: test\n");
        assert.equal(findTotopoYamlDir(tmp), tmp);
        await cleanTempDir(tmp);
    });

    test("walks up to find totopo.yaml", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: test\n");
        const deep = join(tmp, "a", "b", "c");
        mkdirSync(deep, { recursive: true });
        assert.equal(findTotopoYamlDir(deep), tmp);
        await cleanTempDir(tmp);
    });

    test("returns null when not found", async () => {
        const tmp = createTempDir();
        // Search from a deep subdir; temp dirs are under /tmp/totopo-test-* which won't have totopo.yaml
        const deep = join(tmp, "x", "y");
        mkdirSync(deep, { recursive: true });
        assert.equal(findTotopoYamlDir(deep), null);
        await cleanTempDir(tmp);
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

    afterEach(async () => {
        restoreHome();
        await cleanTempDir(homeRoot);
    });

    // ---- Lock file operations -----------------------------------------------------------------------------------------------------------

    describe("lock file operations", () => {
        test("initWorkspaceDir creates .lock, agents/, shadows/", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            const wsDir = getWorkspaceDir("test-ws");
            assert.ok(existsSync(join(wsDir, LOCK_FILE)));
            assert.ok(existsSync(join(wsDir, "agents")));
            assert.ok(existsSync(join(wsDir, "shadows")));
            await cleanTempDir(tmp);
        });

        test("readLockFile returns workspace root path", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(readLockFile("test-ws"), tmp);
            await cleanTempDir(tmp);
        });

        test("readLockFile returns null for missing lock", () => {
            assert.equal(readLockFile("nonexistent-ws-id-xyz"), null);
        });

        test("readActiveProfile returns default on fresh init", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(readActiveProfile("test-ws"), DEFAULT_PROFILE);
            await cleanTempDir(tmp);
        });

        test("readActiveProfile returns null for missing lock", () => {
            assert.equal(readActiveProfile("nonexistent-ws-id-xyz"), null);
        });

        test("writeActiveProfile updates profile without changing path", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            writeActiveProfile("test-ws", "extended");
            assert.equal(readActiveProfile("test-ws"), "extended");
            assert.equal(readLockFile("test-ws"), tmp);
            await cleanTempDir(tmp);
        });

        test("writeLockFile updates path without changing profile", async () => {
            const tmp1 = createTempDir();
            const tmp2 = createTempDir();
            initWorkspaceDir("test-ws", tmp1, "extended");
            writeLockFile("test-ws", tmp2);
            assert.equal(readLockFile("test-ws"), tmp2);
            assert.equal(readActiveProfile("test-ws"), "extended");
            await cleanTempDir(tmp1);
            await cleanTempDir(tmp2);
        });

        test("initWorkspaceDir with custom profile", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp, "extended");
            assert.equal(readActiveProfile("test-ws"), "extended");
            await cleanTempDir(tmp);
        });

        test("lock file is written in key=value format", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            const raw = readFileSync(join(getWorkspaceDir("test-ws"), LOCK_FILE), "utf8");
            assert.ok(raw.includes(`${LOCK_KEYS.workspaceRoot}=`), "should contain root= key");
            assert.ok(raw.includes(`${LOCK_KEYS.activeProfile}=`), "should contain profile= key");
            assert.ok(raw.includes(`${LOCK_KEYS.gitMode}=`), "should contain git_mode= key");
            assert.ok(raw.includes(`${LOCK_KEYS.webPort}=`), "should contain web_port= key");
            assert.ok(raw.includes(`${LOCK_KEYS.version}=${LOCK_VERSION}`), "should stamp the workspace shape version");
            assert.ok(!raw.includes("audio="), "should not contain the retired audio= key");
            assert.ok(!raw.includes("last-cli-update="), "should not contain last-cli-update= key");
            await cleanTempDir(tmp);
        });

        test("readGitMode returns local by default on fresh init", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(readGitMode("test-ws"), GIT_MODE.local);
            await cleanTempDir(tmp);
        });

        test("readGitMode returns null for missing lock", () => {
            assert.equal(readGitMode("nonexistent-ws-id-xyz"), null);
        });

        test("writeGitMode updates mode without changing other fields", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp, "extended");
            writeGitMode("test-ws", GIT_MODE.local);
            assert.equal(readGitMode("test-ws"), GIT_MODE.local);
            assert.equal(readActiveProfile("test-ws"), "extended");
            assert.equal(readLockFile("test-ws"), tmp);
            await cleanTempDir(tmp);
        });

        test("writeActiveProfile preserves git mode", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            writeGitMode("test-ws", GIT_MODE.unrestricted);
            writeActiveProfile("test-ws", "extended");
            assert.equal(readGitMode("test-ws"), GIT_MODE.unrestricted);
            assert.equal(readActiveProfile("test-ws"), "extended");
            await cleanTempDir(tmp);
        });

        test("initWorkspaceDir with custom git mode", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp, DEFAULT_PROFILE, GIT_MODE.local);
            assert.equal(readGitMode("test-ws"), GIT_MODE.local);
            await cleanTempDir(tmp);
        });

        test("readLockVersion returns the current version on fresh init and null for missing lock", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(readLockVersion("test-ws"), LOCK_VERSION);
            assert.equal(readLockVersion("nonexistent-ws-id-xyz"), null);
            await cleanTempDir(tmp);
        });

        test("every other writer keeps the version stamped", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            writeGitMode("test-ws", GIT_MODE.strict);
            writeActiveProfile("test-ws", "extended");
            writeWebPort("test-ws", 3907);
            writeLockFile("test-ws", tmp);
            assert.equal(readLockVersion("test-ws"), LOCK_VERSION);
            await cleanTempDir(tmp);
        });

        test("readWebPort returns null on fresh init and for missing lock", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(readWebPort("test-ws"), null);
            assert.equal(readWebPort("nonexistent-ws-id-xyz"), null);
            await cleanTempDir(tmp);
        });

        test("writeWebPort round-trips and is a no-op without a lock", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            writeWebPort("test-ws", 3900);
            assert.equal(readWebPort("test-ws"), 3900);
            writeWebPort("nonexistent-ws-id-xyz", 3901);
            assert.equal(readWebPort("nonexistent-ws-id-xyz"), null);
            await cleanTempDir(tmp);
        });

        test("readWebPort coerces a non-numeric value to null", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            const lockPath = join(getWorkspaceDir("test-ws"), LOCK_FILE);
            writeFileSync(lockPath, `${readFileSync(lockPath, "utf8").replace(/web_port=.*/, "web_port=bogus")}`);
            assert.equal(readWebPort("test-ws"), null);
            await cleanTempDir(tmp);
        });

        test("writeWebPort preserves all other fields and survives their writes", async () => {
            const tmp1 = createTempDir();
            const tmp2 = createTempDir();
            initWorkspaceDir("test-ws", tmp1, "extended", GIT_MODE.unrestricted);
            writeWebPort("test-ws", 3905);

            assert.equal(readActiveProfile("test-ws"), "extended");
            assert.equal(readGitMode("test-ws"), GIT_MODE.unrestricted);
            assert.equal(readLockFile("test-ws"), tmp1);

            // Every other writer must carry the web port along.
            writeGitMode("test-ws", GIT_MODE.strict);
            writeActiveProfile("test-ws", "other");
            writeLockFile("test-ws", tmp2);
            assert.equal(readWebPort("test-ws"), 3905);

            await cleanTempDir(tmp1);
            await cleanTempDir(tmp2);
        });
    });

    // ---- listWorkspaceIds ---------------------------------------------------------------------------------------------------------------

    describe("listWorkspaceIds", () => {
        test("includes initialized workspaces", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            const ids = listWorkspaceIds();
            assert.ok(ids.includes("test-ws"));
            await cleanTempDir(tmp);
        });
    });

    // ---- checkCollision -----------------------------------------------------------------------------------------------------------------

    describe("checkCollision", () => {
        test("returns ok when lock matches path", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(checkCollision("test-ws", tmp), "ok");
            await cleanTempDir(tmp);
        });

        test("returns collision when lock points elsewhere", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(checkCollision("test-ws", "/some/other/path"), "collision");
            await cleanTempDir(tmp);
        });

        test("returns ok when no lock exists", () => {
            assert.equal(checkCollision("nonexistent-ws-id-xyz", "/any/path"), "ok");
        });
    });

    // ---- findOrphanWorkspaceDir ---------------------------------------------------------------------------------------------------------

    describe("findOrphanWorkspaceDir", () => {
        test("finds orphan by path", async () => {
            const tmp = createTempDir();
            initWorkspaceDir("test-ws", tmp);
            assert.equal(findOrphanWorkspaceDir(tmp), "test-ws");
            await cleanTempDir(tmp);
        });

        test("returns null when no orphan", () => {
            assert.equal(findOrphanWorkspaceDir("/nonexistent/path/xyz"), null);
        });
    });
});
