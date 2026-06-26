import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { AUDIO_MODE, GLOBAL_CONFIG_FILE, GLOBAL_DIR, TOTOPO_DIR } from "../src/lib/constants.js";
import { globalConfigPath, readAudioMode, writeAudioMode } from "../src/lib/global-config.js";
import { cleanTempDir, createTempDir, overrideEnv } from "./helpers.js";

describe("global-config", () => {
    let tmp: string;
    let fakeHome: string;
    let restoreEnv: () => void;

    beforeEach(() => {
        tmp = createTempDir();
        fakeHome = join(tmp, "home");
        mkdirSync(fakeHome, { recursive: true });
        // homedir() reads process.env.HOME at call time - redirect ~/.totopo/ to an isolated temp dir.
        restoreEnv = overrideEnv("HOME", fakeHome);
    });

    afterEach(async () => {
        restoreEnv();
        await cleanTempDir(tmp);
    });

    test("globalConfigPath points at ~/.totopo/global/config", () => {
        assert.equal(globalConfigPath(), join(fakeHome, TOTOPO_DIR, GLOBAL_DIR, GLOBAL_CONFIG_FILE));
    });

    test("readAudioMode defaults to manual when the config file is missing", () => {
        assert.equal(readAudioMode(), AUDIO_MODE.manual);
        assert.ok(!existsSync(globalConfigPath()), "reading should not create the file");
    });

    test("writeAudioMode creates the file on demand and round-trips", () => {
        writeAudioMode(AUDIO_MODE.automatic);
        assert.ok(existsSync(globalConfigPath()), "writing should create the config file");
        assert.equal(readAudioMode(), AUDIO_MODE.automatic);
        writeAudioMode(AUDIO_MODE.manual);
        assert.equal(readAudioMode(), AUDIO_MODE.manual);
    });

    test("readAudioMode coerces an unrecognized value to manual", () => {
        mkdirSync(join(fakeHome, TOTOPO_DIR, GLOBAL_DIR), { recursive: true });
        writeFileSync(globalConfigPath(), "audio_mode=bogus\n");
        assert.equal(readAudioMode(), AUDIO_MODE.manual);
    });

    test("writeAudioMode preserves other keys present in the config", () => {
        mkdirSync(join(fakeHome, TOTOPO_DIR, GLOBAL_DIR), { recursive: true });
        writeFileSync(globalConfigPath(), "audio_mode=manual\nfuture_key=keep-me\n");

        writeAudioMode(AUDIO_MODE.automatic);

        const content = readFileSync(globalConfigPath(), "utf8");
        assert.ok(content.includes("audio_mode=automatic"), "audio_mode should be updated");
        assert.ok(content.includes("future_key=keep-me"), "unrelated keys should be preserved");
    });
});
