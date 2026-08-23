import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { safeRmSync } from "../src/lib/safe-rm.js";

const WEBTERM_CLIENT_DIR = join(import.meta.dirname, "..", "templates", "webterm", "public", "app");

/**
 * The webterm page's source, every module concatenated in filename order.
 *
 * The page is split into ES modules, and the drift tests below match its text rather than run it (it needs a
 * browser). Reading the whole client keeps those tests about what the page does instead of which file a
 * function happens to live in, so moving one between modules never fails a test on its own.
 */
export function readWebtermClient(): string {
    return readdirSync(WEBTERM_CLIENT_DIR)
        .filter((name) => name.endsWith(".js"))
        .sort()
        .map((name) => readFileSync(join(WEBTERM_CLIENT_DIR, name), "utf8"))
        .join("\n");
}

export function createTempDir(): string {
    return mkdtempSync(join(tmpdir(), "totopo-test-"));
}

const TEMP_PREFIX = join(tmpdir(), "totopo-test-");

export async function cleanTempDir(dir: string): Promise<void> {
    if (!resolve(dir).startsWith(TEMP_PREFIX)) {
        throw new Error(`cleanTempDir: refusing to delete '${dir}' - must be under ${TEMP_PREFIX}*`);
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
 * Initialize a fresh git repo in the given directory with a local-only identity.
 * Callers stage and commit themselves so each test controls what is tracked.
 */
export function initGitRepo(dir: string): void {
    const opts = { cwd: dir, stdio: "pipe" as const };
    const init = spawnSync("git", ["init", "-q", "-b", "main"], opts);
    if (init.status !== 0) throw new Error(`git init failed in ${dir}`);
    spawnSync("git", ["config", "user.email", "test@example.com"], opts);
    spawnSync("git", ["config", "user.name", "test"], opts);
    spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
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
