import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { safeRmSync } from "../src/lib/safe-rm.js";
import { cleanTempDir, createTempDir, overrideEnv } from "./helpers.js";

describe("safeRmSync", () => {
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

    // --- Allowed: ~/.totopo/ paths -------------------------------------------------------------------------------------------------------

    test("deletes a directory under ~/.totopo/", () => {
        const dir = join(fakeHome, ".totopo", "workspaces", "my-project");
        mkdirSync(dir, { recursive: true });
        safeRmSync(dir, { recursive: true });
        assert.ok(!existsSync(dir));
    });

    test("deletes ~/.totopo/ itself", () => {
        const totopoHome = join(fakeHome, ".totopo");
        mkdirSync(totopoHome, { recursive: true });
        safeRmSync(totopoHome, { recursive: true });
        assert.ok(!existsSync(totopoHome));
    });

    test("deletes a file under ~/.totopo/", () => {
        const file = join(fakeHome, ".totopo", ".env");
        mkdirSync(join(fakeHome, ".totopo"), { recursive: true });
        writeFileSync(file, "KEY=value");
        safeRmSync(file);
        assert.ok(!existsSync(file));
    });

    // --- Allowed: totopo.yaml anywhere ---------------------------------------------------------------------------------------------------

    test("deletes a file named totopo.yaml in any directory", () => {
        const tmp = createTempDir();
        const yaml = join(tmp, "totopo.yaml");
        writeFileSync(yaml, "workspace_id: test");
        safeRmSync(yaml);
        assert.ok(!existsSync(yaml));
        cleanTempDir(tmp);
    });

    // --- Allowed: test temp dirs ---------------------------------------------------------------------------------------------------------

    test("deletes a directory under the test temp prefix", () => {
        const tmp = createTempDir();
        safeRmSync(tmp, { recursive: true, force: true });
        assert.ok(!existsSync(tmp));
    });

    // --- Blocked: paths outside allowed locations ----------------------------------------------------------------------------------------

    test("throws for an arbitrary path outside ~/.totopo/", () => {
        assert.throws(() => safeRmSync("/etc/hosts"), /safeRmSync: refusing to delete/);
    });

    test("throws for a file not named totopo.yaml and not under ~/.totopo/", () => {
        // Path is outside temp dirs and ~/.totopo/, no need to exist - guard fires before rmSync
        assert.throws(() => safeRmSync("/tmp/not-totopo.yaml"), /safeRmSync: refusing to delete/);
    });

    test("throws for a path that starts with ~/.totopo but is not under it", () => {
        // ~/.totopo-other must not be confused with ~/.totopo/
        assert.throws(() => safeRmSync("/tmp/.totopo-other"), /safeRmSync: refusing to delete/);
    });
});
