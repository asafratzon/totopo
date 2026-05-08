import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildPnpmStoreMountArgs } from "../src/lib/pnpm-store.js";
import { cleanTempDir, createTempDir } from "./helpers.js";

describe("buildPnpmStoreMountArgs", () => {
    test("creates host store directory under cache dir", async () => {
        const cache = createTempDir();
        buildPnpmStoreMountArgs(cache);
        assert.ok(existsSync(join(cache, "pnpm-store")));
        await cleanTempDir(cache);
    });

    test("returns -v arg pointing at pnpm default global store path", async () => {
        const cache = createTempDir();
        const args = buildPnpmStoreMountArgs(cache);
        assert.equal(args.length, 2);
        assert.equal(args[0], "-v");
        assert.equal(args[1], `${cache}/pnpm-store:/home/devuser/.local/share/pnpm/store`);
        await cleanTempDir(cache);
    });

    test("idempotent when host dir already exists", async () => {
        const cache = createTempDir();
        mkdirSync(join(cache, "pnpm-store"), { recursive: true });
        const args = buildPnpmStoreMountArgs(cache);
        assert.equal(args[1], `${cache}/pnpm-store:/home/devuser/.local/share/pnpm/store`);
        await cleanTempDir(cache);
    });
});
