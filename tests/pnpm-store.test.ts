import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CONTAINER_PNPM_STORE, RUNTIME_ENV } from "../src/lib/constants.js";
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

    // The -v mount target and the injected store-dir env vars must resolve to the same container path, so
    // pnpm always writes into the mounted store and never leaves a stray .pnpm-store in the host repo.
    test("store-dir env vars match the mount target (single source of truth)", async () => {
        const cache = createTempDir();
        const args = buildPnpmStoreMountArgs(cache);
        assert.ok(args[1]?.endsWith(`:${CONTAINER_PNPM_STORE}`));
        assert.equal(RUNTIME_ENV.npm_config_store_dir, CONTAINER_PNPM_STORE);
        assert.equal(RUNTIME_ENV.pnpm_config_store_dir, CONTAINER_PNPM_STORE);
        await cleanTempDir(cache);
    });
});
