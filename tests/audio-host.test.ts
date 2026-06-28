import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ensureCookieFile, hostCookiePath } from "../src/lib/audio-host.js";
import { GLOBAL_DIR, PULSE_COOKIE_FILE, TOTOPO_DIR } from "../src/lib/constants.js";
import { cleanTempDir, createTempDir, overrideEnv } from "./helpers.js";

describe("audio-host dedicated cookie", () => {
    let home: string;
    let restoreHome: () => void;

    beforeEach(() => {
        home = createTempDir();
        restoreHome = overrideEnv("HOME", home);
    });

    afterEach(async () => {
        restoreHome();
        await cleanTempDir(home);
    });

    test("hostCookiePath points at the totopo-owned cookie under HOME", () => {
        assert.equal(hostCookiePath(), join(home, TOTOPO_DIR, GLOBAL_DIR, PULSE_COOKIE_FILE));
    });

    test("ensureCookieFile creates a 256-byte cookie not readable by group/other", () => {
        const path = ensureCookieFile();
        assert.equal(path, hostCookiePath());
        assert.equal(statSync(path).size, 256);
        assert.equal(statSync(path).mode & 0o077, 0, "cookie must not be group/other readable");
    });

    test("ensureCookieFile is create-if-missing: it does not rotate an existing cookie", () => {
        const path = ensureCookieFile();
        const first = readFileSync(path);
        const again = ensureCookieFile();
        assert.equal(again, path);
        assert.deepEqual(readFileSync(path), first, "existing cookie must be left untouched");
    });
});
