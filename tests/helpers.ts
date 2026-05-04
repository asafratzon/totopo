import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { safeRmSync } from "../src/lib/safe-rm.js";

export function createTempDir(): string {
    return mkdtempSync(join(tmpdir(), "totopo-test-"));
}

const TEMP_PREFIX = join(tmpdir(), "totopo-test-");

export async function cleanTempDir(dir: string): Promise<void> {
    if (!resolve(dir).startsWith(TEMP_PREFIX)) {
        throw new Error(`cleanTempDir: refusing to delete '${dir}' — must be under ${TEMP_PREFIX}*`);
    }
    // On macOS Docker Desktop, the host-side bind-mount target can briefly hold a
    // macOS indexing handle and a com.apple.provenance xattr after `docker rm -f`
    // returns. Retry with exponential backoff before surfacing EACCES.
    const delays = [0, 250, 500, 1000, 2000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt]) await sleep(delays[attempt]);
        try {
            safeRmSync(dir, { recursive: true, force: true });
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "EACCES" && code !== "ENOTEMPTY") throw err;
            if (attempt === delays.length - 1) throw err;
        }
    }
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
