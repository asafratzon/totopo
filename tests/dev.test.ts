import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveWorkdir } from "../src/commands/dev.js";

describe("resolveWorkdir", () => {
    test("returns the container workspace root when invoked at the workspace root", () => {
        assert.equal(resolveWorkdir("/home/user/proj", "/home/user/proj"), "/workspace");
    });

    test("maps a sub-directory to the matching path under the container workspace", () => {
        assert.equal(resolveWorkdir("/home/user/proj", "/home/user/proj/apps/orot-core"), "/workspace/apps/orot-core");
    });
});
