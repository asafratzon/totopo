import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { GLOBAL_CONFIG_FILE, GLOBAL_DIR, LOCK_FILE, LOCK_VERSION, TOTOPO_DIR, TOTOPO_YAML, WORKSPACES_DIR } from "../src/lib/constants.js";
import { globalConfigPath } from "../src/lib/global-config.js";
import { detectLegacyShape, tidyV3Leftovers } from "../src/lib/legacy-check.js";
import { getWorkspaceDir, LOCK_KEYS, readLockVersion } from "../src/lib/workspace-identity.js";
import { cleanTempDir, createTempDir, overrideEnv } from "./helpers.js";

// A .lock exactly as totopo v3.16 wrote it: the audio flag is present, the version marker is not.
// The key names are literals on purpose - v4 no longer has a constant for the audio key.
const V3_16_LOCK = (root: string) => `root=${root}\nprofile=default\ngit_mode=local\naudio=false\nweb_port=3900\n`;

describe("legacy-check", () => {
    let tmp: string;
    let fakeHome: string;
    let workspaceRoot: string;
    let restoreEnv: () => void;

    beforeEach(() => {
        tmp = createTempDir();
        fakeHome = join(tmp, "home");
        workspaceRoot = join(tmp, "project");
        mkdirSync(fakeHome, { recursive: true });
        mkdirSync(workspaceRoot, { recursive: true });
        // homedir() reads process.env.HOME at call time - redirect ~/.totopo/ to an isolated temp dir.
        restoreEnv = overrideEnv("HOME", fakeHome);
    });

    afterEach(async () => {
        restoreEnv();
        await cleanTempDir(tmp);
    });

    // Write a registered workspace cache dir with the given lock content, and return its lock path.
    function registerWorkspace(workspaceId: string, lockContent: string): string {
        const dir = join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR, workspaceId);
        mkdirSync(dir, { recursive: true });
        const lockPath = join(dir, LOCK_FILE);
        writeFileSync(lockPath, lockContent);
        return lockPath;
    }

    function writeWorkspaceYaml(content: string): void {
        writeFileSync(join(workspaceRoot, TOTOPO_YAML), content);
    }

    function writeGlobalConfig(content: string): void {
        mkdirSync(join(fakeHome, TOTOPO_DIR, GLOBAL_DIR), { recursive: true });
        writeFileSync(join(fakeHome, TOTOPO_DIR, GLOBAL_DIR, GLOBAL_CONFIG_FILE), content);
    }

    // ---- detectLegacyShape --------------------------------------------------------------------------------------------------------------

    describe("detectLegacyShape", () => {
        test("a fresh host with no ~/.totopo/ at all is not legacy", () => {
            assert.equal(detectLegacyShape(null), null);
            assert.equal(detectLegacyShape(workspaceRoot), null);
        });

        test("a current v3.16 workspace passes", () => {
            registerWorkspace("current-ws", V3_16_LOCK(workspaceRoot));
            writeWorkspaceYaml("workspace_id: current-ws\nshadow_paths:\n  - node_modules\n");
            assert.equal(detectLegacyShape(workspaceRoot), null);
        });

        test("a v4 workspace passes", () => {
            registerWorkspace("v4-ws", `root=${workspaceRoot}\nprofile=default\ngit_mode=local\nweb_port=\nversion=${LOCK_VERSION}\n`);
            writeWorkspaceYaml("workspace_id: v4-ws\n");
            assert.equal(detectLegacyShape(workspaceRoot), null);
        });

        test("a v2 ~/.totopo/projects/ directory is refused", () => {
            mkdirSync(join(fakeHome, TOTOPO_DIR, "projects", "some-hash"), { recursive: true });
            const found = detectLegacyShape(workspaceRoot);
            assert.ok(found, "a projects/ dir must be detected");
            assert.match(found.marker, /projects\/ directory/);
        });

        test("a v2 meta.json under the workspaces dir is refused", () => {
            const dir = join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR, "a1b2c3d4");
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "meta.json"), '{"root":"/some/path"}\n');
            const found = detectLegacyShape(workspaceRoot);
            assert.ok(found, "a meta.json must be detected");
            assert.match(found.marker, /meta\.json/);
        });

        test("an RC-era .lock whose first line has no = is refused", () => {
            registerWorkspace("rc-ws", `${workspaceRoot}\nprofile=default\n`);
            const found = detectLegacyShape(workspaceRoot);
            assert.ok(found, "a bare-path lock must be detected");
            assert.match(found.marker, /pre-v3 format/);
        });

        test("a comment or blank line before the first real line does not fool the .lock check", () => {
            registerWorkspace("ok-ws", `\n\n${LOCK_KEYS.workspaceRoot}=${workspaceRoot}\n`);
            assert.equal(detectLegacyShape(workspaceRoot), null);
        });

        for (const key of ["project_id", "env_file", "schema_version"]) {
            test(`a retired ${key}: key in totopo.yaml is refused`, () => {
                registerWorkspace("yaml-ws", V3_16_LOCK(workspaceRoot));
                writeWorkspaceYaml(`workspace_id: yaml-ws\n${key}: something\n`);
                const found = detectLegacyShape(workspaceRoot);
                assert.ok(found, `${key} must be detected`);
                assert.match(found.marker, new RegExp(key));
            });
        }

        test("a retired key is only looked for in the workspace this run resolved to", () => {
            registerWorkspace("yaml-ws", V3_16_LOCK(workspaceRoot));
            writeWorkspaceYaml("workspace_id: yaml-ws\nproject_id: old\n");
            assert.equal(detectLegacyShape(null), null, "outside a workspace there is no yaml to date");
        });

        test("a retired key inside a quoted value is not mistaken for a top-level key", () => {
            registerWorkspace("yaml-ws", V3_16_LOCK(workspaceRoot));
            writeWorkspaceYaml('workspace_id: yaml-ws\nenv:\n  - "NOTE=env_file: is gone"\n');
            assert.equal(detectLegacyShape(workspaceRoot), null);
        });

        test("the refusal names totopo 3.16.0 exactly, so the user installs the right version", () => {
            mkdirSync(join(fakeHome, TOTOPO_DIR, "projects"), { recursive: true });
            const found = detectLegacyShape(workspaceRoot);
            assert.ok(found);
            assert.match(found.message, /npx totopo@3\.16\.0/);
        });

        test("detection writes nothing - a refused run leaves the disk exactly as it was", () => {
            const lockPath = registerWorkspace("rc-ws", `${workspaceRoot}\nprofile=default\n`);
            const before = readFileSync(lockPath, "utf8");
            writeWorkspaceYaml("project_id: old-ws\n");
            const yamlBefore = readFileSync(join(workspaceRoot, TOTOPO_YAML), "utf8");

            assert.ok(detectLegacyShape(workspaceRoot), "this fixture is legacy");

            assert.equal(readFileSync(lockPath, "utf8"), before, "the lock must be untouched");
            assert.equal(readFileSync(join(workspaceRoot, TOTOPO_YAML), "utf8"), yamlBefore, "totopo.yaml must be untouched");
        });
    });

    // ---- tidyV3Leftovers ----------------------------------------------------------------------------------------------------------------

    describe("tidyV3Leftovers", () => {
        test("a v3.16 lock loses the audio key, gains the version, and keeps everything else", () => {
            const lockPath = registerWorkspace("ws-one", V3_16_LOCK(workspaceRoot));

            const result = tidyV3Leftovers();

            assert.deepEqual(result.tidiedWorkspaces, ["ws-one"]);
            const content = readFileSync(lockPath, "utf8");
            assert.ok(!content.includes("audio="), "the retired audio key must be gone");
            assert.ok(content.includes(`${LOCK_KEYS.version}=${LOCK_VERSION}`), "the version marker must be stamped");
            assert.ok(content.includes(`${LOCK_KEYS.workspaceRoot}=${workspaceRoot}`), "the root must survive");
            assert.ok(content.includes(`${LOCK_KEYS.activeProfile}=default`), "the profile must survive");
            assert.ok(content.includes(`${LOCK_KEYS.gitMode}=local`), "the git mode must survive");
            assert.ok(content.includes(`${LOCK_KEYS.webPort}=3900`), "the web port must survive");
        });

        test("every registered workspace is tidied in one run", () => {
            registerWorkspace("ws-one", V3_16_LOCK(workspaceRoot));
            registerWorkspace("ws-two", V3_16_LOCK(workspaceRoot));
            registerWorkspace("ws-three", V3_16_LOCK(workspaceRoot));

            assert.deepEqual(tidyV3Leftovers().tidiedWorkspaces.sort(), ["ws-one", "ws-three", "ws-two"]);
            for (const id of ["ws-one", "ws-two", "ws-three"]) {
                assert.equal(readLockVersion(id), LOCK_VERSION);
            }
        });

        test("the retired audio-mode key is dropped from the global config, other keys preserved", () => {
            writeGlobalConfig("audio_mode=automatic\nauto_start_agent=claude\nweb_range=3900-3999\n");

            assert.equal(tidyV3Leftovers().removedAudioMode, true);

            const content = readFileSync(globalConfigPath(), "utf8");
            assert.ok(!content.includes("audio_mode"), "the retired key must be gone");
            assert.ok(content.includes("auto_start_agent=claude"), "unrelated keys must be preserved");
            assert.ok(content.includes("web_range=3900-3999"), "unrelated keys must be preserved");
        });

        test("a second run changes nothing", () => {
            const lockPath = registerWorkspace("ws-one", V3_16_LOCK(workspaceRoot));
            writeGlobalConfig("audio_mode=automatic\nauto_start_agent=claude\n");

            tidyV3Leftovers();
            const lockAfterFirst = readFileSync(lockPath, "utf8");
            const configAfterFirst = readFileSync(globalConfigPath(), "utf8");

            const second = tidyV3Leftovers();

            assert.deepEqual(second.tidiedWorkspaces, [], "nothing left to tidy");
            assert.equal(second.removedAudioMode, false, "the key is already gone");
            assert.equal(readFileSync(lockPath, "utf8"), lockAfterFirst, "the lock must be byte-identical");
            assert.equal(readFileSync(globalConfigPath(), "utf8"), configAfterFirst, "the config must be byte-identical");
        });

        test("a host with nothing to tidy reports no changes and creates no config file", () => {
            const result = tidyV3Leftovers();
            assert.deepEqual(result.tidiedWorkspaces, []);
            assert.equal(result.removedAudioMode, false);
        });

        test("a lock without a root is left alone rather than rewritten into a broken one", () => {
            const lockPath = registerWorkspace("broken-ws", "profile=default\ngit_mode=local\n");
            const before = readFileSync(lockPath, "utf8");

            assert.deepEqual(tidyV3Leftovers().tidiedWorkspaces, []);
            assert.equal(readFileSync(lockPath, "utf8"), before);
        });
    });

    // ---- the version marker itself ------------------------------------------------------------------------------------------------------

    describe("the lock version marker", () => {
        test("readLockVersion reports the empty string for a pre-v4 lock and null when there is no lock", () => {
            registerWorkspace("v3-ws", V3_16_LOCK(workspaceRoot));
            assert.equal(readLockVersion("v3-ws"), "");
            assert.equal(readLockVersion("no-such-ws"), null);
        });

        test("the lock lives where getWorkspaceDir says it does", () => {
            registerWorkspace("v3-ws", V3_16_LOCK(workspaceRoot));
            assert.equal(join(getWorkspaceDir("v3-ws"), LOCK_FILE), join(fakeHome, TOTOPO_DIR, WORKSPACES_DIR, "v3-ws", LOCK_FILE));
        });
    });
});
