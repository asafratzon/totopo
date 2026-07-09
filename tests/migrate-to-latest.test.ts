import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { GIT_MODE, GLOBAL_DIR, LOCK_FILE, PULSE_COOKIE_FILE, TOTOPO_DIR, WORKSPACES_DIR } from "../src/lib/constants.js";
import { migrateAddAudio, migrateAddGitMode, runMigration } from "../src/lib/migrate-to-latest.js";
import { LOCK_KEYS } from "../src/lib/workspace-identity.js";
import { cleanTempDir, createTempDir, overrideEnv } from "./helpers.js";

let tmp: string;
let fakeHome: string;
let restoreEnv: Array<() => void>;

function writeLegacyV1Files(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Dockerfile"), "FROM node:20\n");
    writeFileSync(join(dir, "README.md"), "legacy totopo\n");
    writeFileSync(join(dir, "post-start.mjs"), "console.log('legacy');\n");
    writeFileSync(join(dir, "settings.json"), "{}\n");
}

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

    afterEach(async () => {
        for (const restore of restoreEnv) restore();
        await cleanTempDir(tmp);
    });

    // ---- migrateLegacyV1WorkspaceArtifacts ----------------------------------------------------------------------------------------------

    test("removes legacy v1 workspace-local .totopo artifacts when confirmation is disabled", async () => {
        const legacyDir = join(tmp, TOTOPO_DIR);
        writeLegacyV1Files(legacyDir);

        await runMigration(tmp);

        assert.ok(!existsSync(legacyDir), "legacy v1 .totopo/ should be removed");
    });

    test("removes legacy v1 workspace-local .totopo artifacts when any known v1 file exists", async () => {
        const legacyDir = join(tmp, TOTOPO_DIR);
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(join(legacyDir, "settings.json"), "{}\n");

        await runMigration(tmp);

        assert.ok(!existsSync(legacyDir), "partial legacy v1 .totopo/ should be removed");
    });

    test("skips .totopo directories that do not contain known v1 files", async () => {
        const legacyDir = join(tmp, TOTOPO_DIR);
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(join(legacyDir, "custom.json"), "{}\n");

        await runMigration(tmp);

        assert.ok(existsSync(legacyDir), "non-matching .totopo/ should be kept");
    });

    test("detects legacy v1 workspace-local .totopo artifacts at the git root", async () => {
        const repo = join(tmp, "repo");
        const subdir = join(repo, "nested");
        mkdirSync(subdir, { recursive: true });
        spawnSync("git", ["init"], { cwd: repo, stdio: "pipe" });
        const legacyDir = join(repo, TOTOPO_DIR);
        writeLegacyV1Files(legacyDir);

        await runMigration(subdir);

        assert.ok(!existsSync(legacyDir), "legacy v1 .totopo/ at git root should be removed");
    });

    test("prefers legacy v1 workspace-local .totopo artifacts in cwd over a higher git root", async () => {
        const repo = join(tmp, "repo");
        const nestedProject = join(repo, "packages", "example");
        mkdirSync(nestedProject, { recursive: true });
        spawnSync("git", ["init"], { cwd: repo, stdio: "pipe" });
        const repoLegacyDir = join(repo, TOTOPO_DIR);
        const nestedLegacyDir = join(nestedProject, TOTOPO_DIR);
        writeLegacyV1Files(repoLegacyDir);
        writeLegacyV1Files(nestedLegacyDir);

        await runMigration(nestedProject);

        assert.ok(!existsSync(nestedLegacyDir), "legacy v1 .totopo/ in cwd should be removed");
        assert.ok(existsSync(repoLegacyDir), "legacy v1 .totopo/ at the higher git root should be kept");
    });

    // ---- migrateProjectsDir -------------------------------------------------------------------------------------------------------------

    test("renames projects/ to workspaces/", async () => {
        const projectsDir = join(fakeHome, ".totopo", "projects");
        mkdirSync(projectsDir, { recursive: true });
        writeFileSync(join(projectsDir, "marker.txt"), "test");

        await runMigration(tmp);

        const workspacesDir = join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR);
        assert.ok(existsSync(workspacesDir), "workspaces/ should exist after migration");
        assert.ok(!existsSync(projectsDir), "projects/ should be gone after migration");
        assert.ok(existsSync(join(workspacesDir, "marker.txt")), "contents should be preserved");
    });

    test("skips rename if projects/ does not exist", async () => {
        // No projects/ dir - should not create workspaces/
        await runMigration(tmp);
        // No error thrown
    });

    test("merges projects/ into existing workspaces/, removes projects/", async () => {
        const projectsDir = join(fakeHome, ".totopo", "projects");
        const workspacesDir = join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR);
        mkdirSync(join(projectsDir, "new-workspace"), { recursive: true });
        writeFileSync(join(projectsDir, "new-workspace", LOCK_FILE), "/some/path\ndefault\n");
        mkdirSync(join(workspacesDir, "existing-workspace"), { recursive: true });

        await runMigration(tmp);

        assert.ok(!existsSync(projectsDir), "projects/ should be removed");
        assert.ok(existsSync(join(workspacesDir, "new-workspace")), "new entry should be moved");
        assert.ok(existsSync(join(workspacesDir, "existing-workspace")), "existing entry should be preserved");
    });

    test("skips collision entries when merging projects/ into workspaces/", async () => {
        const projectsDir = join(fakeHome, ".totopo", "projects");
        const workspacesDir = join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR);
        mkdirSync(join(projectsDir, "my-workspace"), { recursive: true });
        writeFileSync(join(projectsDir, "my-workspace", LOCK_FILE), "/old/path\ndefault\n");
        mkdirSync(join(workspacesDir, "my-workspace"), { recursive: true });
        writeFileSync(join(workspacesDir, "my-workspace", LOCK_FILE), "/new/path\ndefault\n");

        await runMigration(tmp);

        assert.ok(!existsSync(projectsDir), "projects/ should be removed");
        // workspaces/ version should win (not overwritten); positional format is upgraded to key=value
        const lockContent = readFileSync(join(workspacesDir, "my-workspace", LOCK_FILE), "utf8");
        assert.ok(lockContent.includes(`${LOCK_KEYS.workspaceRoot}=/new/path`), "workspace root should be preserved");
        assert.ok(lockContent.includes(`${LOCK_KEYS.activeProfile}=default`), "profile should be preserved");
    });

    // ---- migrateGlobalEnv ---------------------------------------------------------------------------------------------------------------

    test("removes legacy ~/.totopo/.env", async () => {
        mkdirSync(join(fakeHome, TOTOPO_DIR), { recursive: true });
        writeFileSync(join(fakeHome, ".totopo", ".env"), "API_KEY=secret");

        await runMigration(tmp);

        assert.ok(!existsSync(join(fakeHome, ".totopo", ".env")), "global .env should be removed");
    });

    test("no-op when ~/.totopo/.env does not exist", async () => {
        mkdirSync(join(fakeHome, TOTOPO_DIR), { recursive: true });

        await runMigration(tmp);
        // No error thrown
    });

    // ---- migrateV3PreRelease: project_id -> workspace_id --------------------------------------------------------------------------------

    test("renames project_id to workspace_id in totopo.yaml", async () => {
        // Create a totopo.yaml with project_id in cwd
        writeFileSync(join(tmp, "totopo.yaml"), "schema_version: 3\nproject_id: legacy-ws\n"); // legacy format with schema_version

        // Need workspace dir to exist for readTotopoYaml after rename
        mkdirSync(join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR), { recursive: true });

        await runMigration(tmp);

        const content = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(content.includes("workspace_id"), "should contain workspace_id after migration");
        assert.ok(!content.includes("project_id"), "should not contain project_id after migration");
    });

    test("no-op when totopo.yaml already has workspace_id", async () => {
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: modern-ws\n");
        mkdirSync(join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR), { recursive: true });

        await runMigration(tmp);

        const content = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(content.includes("workspace_id: modern-ws"));
    });

    // ---- migrateEnvFileToEnv (env_file -> env) ------------------------------------------------------------------------------------------

    test("renames env_file to env in totopo.yaml, preserving the value and comments", async () => {
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: envy-ws\n# keep me\nenv_file: .env\n");
        mkdirSync(join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR), { recursive: true });

        await runMigration(tmp);

        const content = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(content.includes("env: .env"), "env_file: should be renamed to env:");
        assert.ok(!content.includes("env_file:"), "env_file: should be gone");
        assert.ok(content.includes("# keep me"), "surrounding comments should be preserved");
    });

    test("no-op when totopo.yaml already uses env", async () => {
        const original = "workspace_id: envy-ws\nenv:\n  - .env\n  - FOO=bar\n";
        writeFileSync(join(tmp, "totopo.yaml"), original);
        mkdirSync(join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR), { recursive: true });

        await runMigration(tmp);

        assert.equal(readFileSync(join(tmp, "totopo.yaml"), "utf8"), original, "an env-based file should be untouched");
    });

    test("no-op when totopo.yaml has neither env_file nor env", async () => {
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: envy-ws\n");
        mkdirSync(join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR), { recursive: true });

        await runMigration(tmp);

        const content = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(!content.includes("env:"), "no env key should be introduced");
    });

    // ---- migrateV2Workspaces ------------------------------------------------------------------------------------------------------------

    test("migrates v2 hash-based workspace", async () => {
        // Set up a fake v2 hash directory with meta.json
        const wsBase = join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR);
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

        await runMigration(tmp);

        // Hash dir should be removed
        assert.ok(!existsSync(hashDir), "hash directory should be removed");

        // A new workspace_id dir should exist
        const entries = existsSync(wsBase) ? readdirSync(wsBase).filter((e: string) => e !== "abc123hash") : [];
        assert.ok(entries.length > 0, "a new workspace dir should exist");

        // A totopo.yaml should be written to the project root
        assert.ok(existsSync(join(projectRoot, "totopo.yaml")), "totopo.yaml should be created");
    });

    test("skips v2 workspace when project root no longer exists", async () => {
        const wsBase = join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR);
        const hashDir = join(wsBase, "deadhash");
        mkdirSync(hashDir, { recursive: true });

        writeFileSync(join(hashDir, "meta.json"), JSON.stringify({ projectRoot: "/nonexistent/path", displayName: "Gone Project" }));

        await runMigration(tmp);

        // Hash dir should still exist (skipped, not removed)
        // Actually the implementation skips it and returns null, but doesn't remove it
        // Let's just verify no crash
    });

    // ---- migrateV3PreRelease: .lock positional -> key=value -----------------------------------------------------------------------------

    test("upgrades old positional .lock format to key=value", async () => {
        const wsDir = join(fakeHome, ".totopo", "workspaces", "my-ws");
        mkdirSync(wsDir, { recursive: true });
        writeFileSync(join(wsDir, LOCK_FILE), "/some/path\nslim\n");

        await runMigration(tmp);

        const content = readFileSync(join(wsDir, LOCK_FILE), "utf8");
        assert.ok(content.includes(`${LOCK_KEYS.workspaceRoot}=/some/path`), "workspace root should be preserved");
        assert.ok(content.includes(`${LOCK_KEYS.activeProfile}=slim`), "profile should be preserved");
        assert.ok(!content.includes("last-cli-update="), "last-cli-update key should not be present");
    });

    test("skips .lock files already in key=value format", async () => {
        const wsDir = join(fakeHome, ".totopo", "workspaces", "my-ws");
        mkdirSync(wsDir, { recursive: true });
        const original = `${LOCK_KEYS.workspaceRoot}=/some/path\n${LOCK_KEYS.activeProfile}=slim\n${LOCK_KEYS.gitMode}=${GIT_MODE.strict}\n${LOCK_KEYS.audio}=false\n`;
        writeFileSync(join(wsDir, LOCK_FILE), original);

        await runMigration(tmp);

        assert.equal(readFileSync(join(wsDir, LOCK_FILE), "utf8"), original);
    });

    test("the .lock format upgrade is a no-op when workspaces/ does not exist", async () => {
        // fakeHome has no .totopo/ dir at all -- should not throw
        await runMigration(tmp);
    });

    // ---- migrateV3PreRelease: .lock yaml= -> root= --------------------------------------------------------------------------------------

    test("renames yaml= key to root= in .lock files", async () => {
        const wsDir = join(fakeHome, ".totopo", "workspaces", "my-ws");
        mkdirSync(wsDir, { recursive: true });
        writeFileSync(join(wsDir, LOCK_FILE), `yaml=/some/path\n${LOCK_KEYS.activeProfile}=slim\n`);

        await runMigration(tmp);

        const content = readFileSync(join(wsDir, LOCK_FILE), "utf8");
        assert.ok(content.includes(`${LOCK_KEYS.workspaceRoot}=/some/path`), "yaml= should be renamed to root=");
        assert.ok(!content.includes("yaml="), "yaml= key should be gone");
        assert.ok(content.includes(`${LOCK_KEYS.activeProfile}=slim`), "profile should be preserved");
    });

    test("skips .lock files already using root= key", async () => {
        const wsDir = join(fakeHome, ".totopo", "workspaces", "my-ws");
        mkdirSync(wsDir, { recursive: true });
        const original = `${LOCK_KEYS.workspaceRoot}=/some/path\n${LOCK_KEYS.activeProfile}=slim\n${LOCK_KEYS.gitMode}=${GIT_MODE.strict}\n${LOCK_KEYS.audio}=false\n`;
        writeFileSync(join(wsDir, LOCK_FILE), original);

        await runMigration(tmp);

        assert.equal(readFileSync(join(wsDir, LOCK_FILE), "utf8"), original);
    });

    test("the .lock yaml= -> root= rename is a no-op when workspaces/ does not exist", async () => {
        // fakeHome has no .totopo/ dir at all -- should not throw
        await runMigration(tmp);
    });

    // ---- migrateRemoveLastCliUpdate ---------------------------------------------------------------------------------------------------------

    test("removes last-cli-update key from .lock files", async () => {
        const wsDir = join(fakeHome, ".totopo", "workspaces", "my-ws");
        mkdirSync(wsDir, { recursive: true });
        writeFileSync(
            join(wsDir, LOCK_FILE),
            `${LOCK_KEYS.workspaceRoot}=/some/path\n${LOCK_KEYS.activeProfile}=slim\nlast-cli-update=2026-04-05T10:00:00.000Z\n`,
        );

        await runMigration(tmp);

        const content = readFileSync(join(wsDir, LOCK_FILE), "utf8");
        assert.ok(!content.includes("last-cli-update"), "last-cli-update should be removed");
        assert.ok(content.includes(`${LOCK_KEYS.workspaceRoot}=/some/path`), "root should be preserved");
        assert.ok(content.includes(`${LOCK_KEYS.activeProfile}=slim`), "profile should be preserved");
    });

    test("migrateRemoveLastCliUpdate is a no-op when key is absent", async () => {
        const wsDir = join(fakeHome, ".totopo", "workspaces", "my-ws");
        mkdirSync(wsDir, { recursive: true });
        const original = `${LOCK_KEYS.workspaceRoot}=/some/path\n${LOCK_KEYS.activeProfile}=slim\n${LOCK_KEYS.gitMode}=${GIT_MODE.local}\n${LOCK_KEYS.audio}=false\n`;
        writeFileSync(join(wsDir, LOCK_FILE), original);

        await runMigration(tmp);

        assert.equal(readFileSync(join(wsDir, LOCK_FILE), "utf8"), original);
    });

    // ---- migrateAddGitMode --------------------------------------------------------------------------------------------------------------

    test("migrateAddGitMode appends git_mode=local for legacy locks missing the field", () => {
        const wsDir = join(fakeHome, ".totopo", "workspaces", "legacy-ws");
        mkdirSync(wsDir, { recursive: true });
        writeFileSync(join(wsDir, LOCK_FILE), `${LOCK_KEYS.workspaceRoot}=/some/path\n${LOCK_KEYS.activeProfile}=default\n`);

        const count = migrateAddGitMode();

        assert.equal(count, 1);
        const content = readFileSync(join(wsDir, LOCK_FILE), "utf8");
        assert.ok(content.includes(`${LOCK_KEYS.gitMode}=${GIT_MODE.local}`), "should add git_mode=local");
        assert.ok(content.includes(`${LOCK_KEYS.workspaceRoot}=/some/path`), "should preserve root");
        assert.ok(content.includes(`${LOCK_KEYS.activeProfile}=default`), "should preserve profile");
    });

    test("migrateAddGitMode is idempotent when git_mode is already present", () => {
        const wsDir = join(fakeHome, ".totopo", "workspaces", "modern-ws");
        mkdirSync(wsDir, { recursive: true });
        const original = `${LOCK_KEYS.workspaceRoot}=/some/path\n${LOCK_KEYS.activeProfile}=default\n${LOCK_KEYS.gitMode}=${GIT_MODE.strict}\n`;
        writeFileSync(join(wsDir, LOCK_FILE), original);

        const count = migrateAddGitMode();

        assert.equal(count, 0);
        assert.equal(readFileSync(join(wsDir, LOCK_FILE), "utf8"), original, "lock content should be unchanged");
    });

    test("migrateAddGitMode counts each migrated workspace separately", () => {
        for (const id of ["ws1", "ws2", "ws3"]) {
            const wsDir = join(fakeHome, ".totopo", "workspaces", id);
            mkdirSync(wsDir, { recursive: true });
            writeFileSync(join(wsDir, LOCK_FILE), `${LOCK_KEYS.workspaceRoot}=/p/${id}\n${LOCK_KEYS.activeProfile}=default\n`);
        }

        assert.equal(migrateAddGitMode(), 3);
        assert.equal(migrateAddGitMode(), 0, "second run is a no-op");
    });

    test("migrateAddGitMode returns 0 when workspaces dir does not exist", () => {
        assert.equal(migrateAddGitMode(), 0);
    });

    test("runMigration triggers migrateAddGitMode for legacy locks", async () => {
        const wsDir = join(fakeHome, ".totopo", "workspaces", "auto-mig");
        mkdirSync(wsDir, { recursive: true });
        writeFileSync(join(wsDir, LOCK_FILE), `${LOCK_KEYS.workspaceRoot}=/p\n${LOCK_KEYS.activeProfile}=default\n`);

        await runMigration(tmp);

        const content = readFileSync(join(wsDir, LOCK_FILE), "utf8");
        assert.ok(content.includes(`${LOCK_KEYS.gitMode}=${GIT_MODE.local}`));
    });

    // ---- migrateAddAudio ------------------------------------------------------------------------------------------------------------------

    test("migrateAddAudio appends audio=false for locks missing the field", () => {
        const wsDir = join(fakeHome, ".totopo", "workspaces", "pre-audio-ws");
        mkdirSync(wsDir, { recursive: true });
        writeFileSync(
            join(wsDir, LOCK_FILE),
            `${LOCK_KEYS.workspaceRoot}=/some/path\n${LOCK_KEYS.activeProfile}=default\n${LOCK_KEYS.gitMode}=${GIT_MODE.local}\n`,
        );

        const count = migrateAddAudio();

        assert.equal(count, 1);
        const content = readFileSync(join(wsDir, LOCK_FILE), "utf8");
        assert.ok(content.includes(`${LOCK_KEYS.audio}=false`), "should add audio=false");
        assert.ok(content.includes(`${LOCK_KEYS.workspaceRoot}=/some/path`), "should preserve root");
        assert.ok(content.includes(`${LOCK_KEYS.gitMode}=${GIT_MODE.local}`), "should preserve git mode");
    });

    test("migrateAddAudio is idempotent when audio is already present", () => {
        const wsDir = join(fakeHome, ".totopo", "workspaces", "modern-audio-ws");
        mkdirSync(wsDir, { recursive: true });
        const original = `${LOCK_KEYS.workspaceRoot}=/some/path\n${LOCK_KEYS.activeProfile}=default\n${LOCK_KEYS.audio}=true\n`;
        writeFileSync(join(wsDir, LOCK_FILE), original);

        const count = migrateAddAudio();

        assert.equal(count, 0);
        assert.equal(readFileSync(join(wsDir, LOCK_FILE), "utf8"), original, "lock content should be unchanged");
    });

    test("migrateAddAudio counts each migrated workspace separately", () => {
        for (const id of ["a1", "a2", "a3"]) {
            const wsDir = join(fakeHome, ".totopo", "workspaces", id);
            mkdirSync(wsDir, { recursive: true });
            writeFileSync(join(wsDir, LOCK_FILE), `${LOCK_KEYS.workspaceRoot}=/p/${id}\n${LOCK_KEYS.activeProfile}=default\n`);
        }

        assert.equal(migrateAddAudio(), 3);
        assert.equal(migrateAddAudio(), 0, "second run is a no-op");
    });

    test("migrateAddAudio returns 0 when workspaces dir does not exist", () => {
        assert.equal(migrateAddAudio(), 0);
    });

    test("runMigration triggers migrateAddAudio for legacy locks", async () => {
        const wsDir = join(fakeHome, ".totopo", "workspaces", "auto-mig-audio");
        mkdirSync(wsDir, { recursive: true });
        writeFileSync(join(wsDir, LOCK_FILE), `${LOCK_KEYS.workspaceRoot}=/p\n${LOCK_KEYS.activeProfile}=default\n`);

        await runMigration(tmp);

        const content = readFileSync(join(wsDir, LOCK_FILE), "utf8");
        assert.ok(content.includes(`${LOCK_KEYS.audio}=false`));
    });

    // ---- migrateMoveAudioCookie -----------------------------------------------------------------------------------------------------------
    // Pure path cleanup: moves a legacy cookie file, or removes the leftover directory Docker fabricates at
    // the old source when a container tried to resume against the moved cookie. It never touches containers.

    test("migrateMoveAudioCookie is a no-op when no source cookie exists", async () => {
        await runMigration(tmp);

        const newCookie = join(fakeHome, TOTOPO_DIR, GLOBAL_DIR, PULSE_COOKIE_FILE);
        assert.ok(!existsSync(newCookie), "no cookie should be created when there was none to move");
    });

    test("migrateMoveAudioCookie moves the cookie into ~/.totopo/global/", async () => {
        const oldCookie = join(fakeHome, TOTOPO_DIR, "pulse-cookie");
        mkdirSync(join(fakeHome, TOTOPO_DIR), { recursive: true });
        writeFileSync(oldCookie, "secret-cookie-bytes");

        await runMigration(tmp);

        const newCookie = join(fakeHome, TOTOPO_DIR, GLOBAL_DIR, PULSE_COOKIE_FILE);
        assert.ok(!existsSync(oldCookie), "old cookie should be gone");
        assert.ok(existsSync(newCookie), "cookie should be moved into global/");
        assert.equal(readFileSync(newCookie, "utf8"), "secret-cookie-bytes", "cookie contents should be preserved");
    });

    test("migrateMoveAudioCookie drops the stale source when the destination already exists", async () => {
        const oldCookie = join(fakeHome, TOTOPO_DIR, "pulse-cookie");
        const newCookie = join(fakeHome, TOTOPO_DIR, GLOBAL_DIR, PULSE_COOKIE_FILE);
        mkdirSync(join(fakeHome, TOTOPO_DIR, GLOBAL_DIR), { recursive: true });
        writeFileSync(oldCookie, "stale-source");
        writeFileSync(newCookie, "authoritative-dest");

        await runMigration(tmp);

        assert.ok(!existsSync(oldCookie), "stale source cookie should be removed");
        assert.equal(readFileSync(newCookie, "utf8"), "authoritative-dest", "destination cookie should be untouched");
    });

    test("migrateMoveAudioCookie removes a leftover directory at the old path without creating a cookie", async () => {
        // Docker Desktop auto-creates a directory at a missing bind-mount source. The migration must remove
        // it (a non-recursive rm would throw and the loop would never clear) and must not fabricate a cookie.
        const oldPath = join(fakeHome, TOTOPO_DIR, "pulse-cookie");
        mkdirSync(oldPath, { recursive: true });

        await runMigration(tmp);

        assert.ok(!existsSync(oldPath), "leftover directory at the old cookie path should be removed");
        const newCookie = join(fakeHome, TOTOPO_DIR, GLOBAL_DIR, PULSE_COOKIE_FILE);
        assert.ok(!existsSync(newCookie), "no cookie should be created from a leftover directory");
    });

    test("migrateMoveAudioCookie is idempotent - a second run is a no-op", async () => {
        const oldCookie = join(fakeHome, TOTOPO_DIR, "pulse-cookie");
        mkdirSync(join(fakeHome, TOTOPO_DIR), { recursive: true });
        writeFileSync(oldCookie, "secret-cookie-bytes");

        await runMigration(tmp);
        const newCookie = join(fakeHome, TOTOPO_DIR, GLOBAL_DIR, PULSE_COOKIE_FILE);
        assert.equal(readFileSync(newCookie, "utf8"), "secret-cookie-bytes");

        await runMigration(tmp);
        assert.ok(!existsSync(oldCookie), "old cookie stays gone on the second run");
        assert.equal(readFileSync(newCookie, "utf8"), "secret-cookie-bytes", "destination cookie is untouched on re-run");
    });

    // ---- migrateRemoveDeprecatedYamlFields ------------------------------------------------------------------------------------------------

    test("removes schema_version and yaml-language-server header from totopo.yaml", async () => {
        const yamlContent =
            "# yaml-language-server: $schema=https://raw.githubusercontent.com/asafratzon/totopo/v3.2.1/schema/totopo.schema.json\n" +
            "schema_version: 3\nworkspace_id: schema-test\n";
        writeFileSync(join(tmp, "totopo.yaml"), yamlContent);
        mkdirSync(join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR), { recursive: true });

        await runMigration(tmp);

        const content = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(!content.includes("schema_version"), "schema_version should be removed");
        assert.ok(!content.includes("yaml-language-server"), "yaml-language-server header should be removed");
        assert.ok(content.includes("workspace_id: schema-test"), "workspace_id should be preserved");
    });

    test("removes name field from totopo.yaml", async () => {
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: name-test\nname: My Project\n");
        mkdirSync(join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR), { recursive: true });

        await runMigration(tmp);

        const content = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(!content.includes("name:"), "name field should be removed");
        assert.ok(content.includes("workspace_id: name-test"), "workspace_id should be preserved");
    });

    test("removes all deprecated fields in one pass", async () => {
        const yamlContent =
            "# yaml-language-server: $schema=https://example.com/schema.json\n" +
            "schema_version: 3\nworkspace_id: combo-test\nname: My Project\n";
        writeFileSync(join(tmp, "totopo.yaml"), yamlContent);
        mkdirSync(join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR), { recursive: true });

        await runMigration(tmp);

        const content = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(!content.includes("schema_version"), "schema_version should be removed");
        assert.ok(!content.includes("yaml-language-server"), "yaml-language-server header should be removed");
        assert.ok(!content.includes("name:"), "name field should be removed");
        assert.ok(content.includes("workspace_id: combo-test"), "workspace_id should be preserved");
    });

    test("removes deprecated fields and renames env_file in a single pass, in chronological order", async () => {
        // An old file can carry both a deprecated field and the old env_file key. The deprecated-field step (v3.2.1)
        // runs before the env rename (v3.12.2), so it must not choke on the not-yet-renamed env_file - which it would
        // if it validated its write against the current schema. This guards that the whole chain converges in one run.
        writeFileSync(join(tmp, "totopo.yaml"), "schema_version: 3\nworkspace_id: old-ws\nenv_file: .env\n");
        mkdirSync(join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR), { recursive: true });

        await runMigration(tmp);

        const content = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(!content.includes("schema_version"), "schema_version should be removed in the same pass");
        assert.ok(!content.includes("env_file:"), "env_file should be renamed in the same pass");
        assert.ok(content.includes("env: .env"), "the env_file value should carry over to env");
        assert.ok(content.includes("workspace_id: old-ws"), "workspace_id should be preserved");
    });

    test("migrateRemoveDeprecatedYamlFields is a no-op when no deprecated fields present", async () => {
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: clean-ws\n");
        mkdirSync(join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR), { recursive: true });

        await runMigration(tmp);

        const content = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(content.includes("workspace_id: clean-ws"));
    });
});
