import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { audioStateLabel, resolveWorkdir } from "../src/commands/dev.js";

describe("audioStateLabel", () => {
    test("returns the plain false label when audio is off, regardless of cookie path", () => {
        assert.equal(audioStateLabel(false, undefined), "false");
        assert.equal(audioStateLabel(false, "/home/user/.totopo/global/pulse-cookie"), "false");
    });

    test("returns a true:<hash> label when audio is on", () => {
        const label = audioStateLabel(true, "/home/user/.totopo/global/pulse-cookie");
        assert.match(label, /^true:[0-9a-f]{12}$/);
    });

    test("the label differs between two different cookie paths", () => {
        const oldPath = audioStateLabel(true, "/home/user/.totopo/pulse-cookie");
        const newPath = audioStateLabel(true, "/home/user/.totopo/global/pulse-cookie");
        assert.notEqual(oldPath, newPath, "relocating the cookie must change the label so the container recreates");
    });

    test("the label is stable for the same cookie path", () => {
        const path = "/home/user/.totopo/global/pulse-cookie";
        assert.equal(audioStateLabel(true, path), audioStateLabel(true, path));
    });

    test("audio on is always distinct from audio off", () => {
        assert.notEqual(audioStateLabel(true, undefined), audioStateLabel(false, undefined));
    });
});

describe("resolveWorkdir", () => {
    test("returns the container workspace root when invoked at the workspace root", () => {
        assert.equal(resolveWorkdir("/home/user/proj", "/home/user/proj"), "/workspace");
    });

    test("maps a sub-directory to the matching path under the container workspace", () => {
        assert.equal(resolveWorkdir("/home/user/proj", "/home/user/proj/apps/orot-core"), "/workspace/apps/orot-core");
    });
});
