// =========================================================================================================================================
// src/lib/safe-rm.ts - Safe wrapper around rmSync
// All deletions in totopo go through safeRmSync. A biome lint rule (noRestrictedImports) bans
// importing rmSync from node:fs everywhere else, enforcing this as the single deletion point.
// =========================================================================================================================================

// biome-ignore lint/style/noRestrictedImports: safeRmSync is the only approved user of rmSync
import { type RmOptions, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { CONTAINER_NAME_PREFIX, TOTOPO_DIR, TOTOPO_YAML } from "./constants.js";

const TOTOPO_HOME = resolve(join(homedir(), TOTOPO_DIR));
const TEST_TMP_PREFIX = join(tmpdir(), `${CONTAINER_NAME_PREFIX}test-`);

/**
 * Safe wrapper around rmSync. Throws if the path is outside a totopo-owned location:
 *   - ~/.totopo/            (workspace caches, agents, shadows, global config)
 *   - A file named totopo.yaml  (workspace config file in any user workspace root)
 *   - <tmpdir>/totopo-test-*   (test temp directories)
 */
export function safeRmSync(path: string, options?: RmOptions): void {
    const r = resolve(path);
    const ok = r === TOTOPO_HOME || r.startsWith(TOTOPO_HOME + sep) || basename(r) === TOTOPO_YAML || r.startsWith(TEST_TMP_PREFIX);

    if (!ok) {
        throw new Error(`safeRmSync: refusing to delete '${r}' — must be under ~/.totopo/, named totopo.yaml, or a test temp dir`);
    }

    rmSync(r, options);
}
