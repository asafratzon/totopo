// =========================================================================================================================================
// src/lib/legacy-check.ts - First contact with a workspace that existed before this major
//
// totopo v4 carries no migration chain. Two cheap steps replace it, both run once at startup:
//
//   detectLegacyShape - recognizes a pre-v3.16 layout and refuses, telling the user to run the last v3
//                       once (it still has the full chain) and come back. It only reads.
//   tidyV3Leftovers   - the one surviving migration. A current v3.16 workspace opens with no manual
//                       step; its dead audio settings are dropped in place on the first v4 run.
//
// Every retired name below - the old directories, filenames and yaml keys these steps look for - is a
// hardcoded string literal, per the repo's migration convention: the source side of a migration must keep
// finding the old location even after the constant naming it is gone. The paths that still exist in v4
// (~/.totopo/ and its workspaces directory, the lock and yaml filenames) come from constants.ts, since
// those are destinations as much as sources.
// =========================================================================================================================================

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOCK_FILE, TOTOPO_DIR, TOTOPO_YAML, WORKSPACES_DIR } from "./constants.js";
import { removeGlobalConfigKey } from "./global-config.js";
import { getWorkspacesBaseDir, listWorkspaceIds, stampLockVersion } from "./workspace-identity.js";

// The last v3 release, which still ships every migration this major dropped. Named exactly, because the
// user has to install that one version - "run an older totopo" would leave them guessing which.
const LAST_V3_VERSION = "3.16.0";

// yaml keys that no totopo since v3.12.2 writes. Their presence dates the file more cheaply than parsing it.
const RETIRED_YAML_KEYS = ["project_id", "env_file", "schema_version"] as const;

/** What dated the workspace, in plain words, plus the message the CLI prints. */
export interface LegacyShape {
    marker: string;
    message: string;
}

// --- Detection ---------------------------------------------------------------------------------------------------------------------------

// v2 kept workspaces under ~/.totopo/projects/. The directory's existence is the marker.
function hasV2ProjectsDir(): boolean {
    return existsSync(join(homedir(), TOTOPO_DIR, "projects"));
}

// v2 named each workspace dir by a hash of its path and described it in meta.json. A meta.json anywhere
// under the workspaces dir means the rename to workspace_id dirs never ran.
function hasV2MetaJson(): boolean {
    const base = getWorkspacesBaseDir();
    let entries: string[];
    try {
        entries = readdirSync(base);
    } catch {
        return false; // No workspaces dir at all - a fresh host, nothing legacy about it.
    }
    return entries.some((name) => existsSync(join(base, name, "meta.json")));
}

// Before v3.0.0 a .lock was a bare path on its first line, not key=value. Any such lock is RC-era.
function hasRcEraLock(): boolean {
    const base = getWorkspacesBaseDir();
    let entries: string[];
    try {
        entries = readdirSync(base);
    } catch {
        return false;
    }
    for (const name of entries) {
        const lockPath = join(base, name, LOCK_FILE);
        let firstLine: string | undefined;
        try {
            if (!statSync(lockPath).isFile()) continue;
            firstLine = readFileSync(lockPath, "utf8")
                .split("\n")
                .map((line) => line.trim())
                .find(Boolean);
        } catch {
            continue; // Unreadable is not evidence of an old shape; leave it to the code that needs it.
        }
        if (firstLine !== undefined && !firstLine.includes("=")) return true;
    }
    return false;
}

// A retired key in the workspace's own totopo.yaml. Read as text, not parsed: the point is to date the
// file, and a shape old enough to carry these keys may not satisfy the current schema at all.
function retiredYamlKey(workspaceRoot: string): string | null {
    let content: string;
    try {
        content = readFileSync(join(workspaceRoot, TOTOPO_YAML), "utf8");
    } catch {
        return null;
    }
    for (const key of RETIRED_YAML_KEYS) {
        // Anchored at column 0, like the v3 migrations that removed these keys. An indented match would
        // fire on a nested key or on a line inside a dockerfile_hook block, and v3.16 would not clear it -
        // so the refusal would come back on every run with no way out through the product.
        if (new RegExp(`^${key}\\s*:`, "m").test(content)) return key;
    }
    return null;
}

/**
 * Look for a pre-v3.16 shape and describe it, or return null when there is nothing old here.
 *
 * `workspaceRoot` is the directory holding the totopo.yaml this run resolved to, or null when the run
 * is not inside a workspace. The host-wide markers are checked either way, because they date the whole
 * ~/.totopo/ tree and running v3 once fixes all of them at once.
 *
 * Reads only. A refused run must leave the disk exactly as it found it, so the user can go back to v3
 * and have its migrations see the state they expect.
 */
export function detectLegacyShape(workspaceRoot: string | null): LegacyShape | null {
    const marker = detectMarker(workspaceRoot);
    if (marker === null) return null;
    return {
        marker,
        message:
            `This setup predates totopo v4 - found ${marker}.\n` +
            `  v4 carries no migrations. Run the last v3 once to bring it up to date:\n\n` +
            `    npx totopo@${LAST_V3_VERSION}\n\n` +
            `  Run it from this same directory - one of the old shapes lives in ${TOTOPO_YAML}, and v3 only\n` +
            `  looks at the workspace it was started in. Open its menu, let it finish, quit, then run\n` +
            `  totopo again. Nothing here has been changed.`,
    };
}

function detectMarker(workspaceRoot: string | null): string | null {
    if (hasV2ProjectsDir()) return `a ~/${TOTOPO_DIR}/projects/ directory`;
    if (hasV2MetaJson()) return `a meta.json under ~/${TOTOPO_DIR}/${WORKSPACES_DIR}/`;
    if (hasRcEraLock()) return `a ${LOCK_FILE} file in the pre-v3 format`;
    if (workspaceRoot !== null) {
        const key = retiredYamlKey(workspaceRoot);
        if (key !== null) return `a retired ${key}: key in ${TOTOPO_YAML}`;
    }
    return null;
}

// --- The one surviving migration ---------------------------------------------------------------------------------------------------------

/** What the tidy-up changed, so the caller can report it once and stay silent when there was nothing to do. */
export interface TidyResult {
    tidiedWorkspaces: string[];
    removedAudioMode: boolean;
}

/**
 * Bring every v3.16-shape workspace on this host to the v4 shape: drop the dead audio settings and stamp
 * the version marker. This is the whole of what v4 migrates.
 *
 * Every registered workspace is swept rather than just the current one, so a user with several
 * workspaces gets them all tidied on the first v4 run instead of one per visit. Idempotent by
 * construction: a lock already carrying the current version is skipped, and a config without the
 * retired key is left alone.
 */
export function tidyV3Leftovers(): TidyResult {
    // stampLockVersion rewrites through the canonical writer, which is what drops `audio=` (retired from
    // LOCK_KEYS in v4) and adds `version=`. Every other key keeps its value and its place, and a lock
    // already at the current version is left alone - so it reports what it changed and nothing more.
    const tidiedWorkspaces = listWorkspaceIds().filter((workspaceId) => stampLockVersion(workspaceId));
    return { tidiedWorkspaces, removedAudioMode: removeGlobalConfigKey("audio_mode") };
}
