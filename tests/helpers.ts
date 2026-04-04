import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function createTempDir(): string {
    return mkdtempSync(join(tmpdir(), "totopo-test-"));
}

const TEMP_PREFIX = join(tmpdir(), "totopo-test-");

export function cleanTempDir(dir: string): void {
    if (!resolve(dir).startsWith(TEMP_PREFIX)) {
        throw new Error(`cleanTempDir: refusing to delete '${dir}' — must be under ${TEMP_PREFIX}*`);
    }
    rmSync(dir, { recursive: true, force: true });
}

/**
 * Override an environment variable for the duration of a test.
 * Returns a restore function to call in afterEach.
 */
export function overrideEnv(key: string, value: string): () => void {
    const original = process.env[key];
    process.env[key] = value;
    return () => {
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
    };
}
