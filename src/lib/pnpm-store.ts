// =========================================================================================================================================
// src/lib/pnpm-store.ts - Per-workspace pnpm global store mount
// pnpm hardlinks from its global store into node_modules. Hardlinks cannot cross filesystems, so when the global store sits on the
// container overlay FS while /workspace is a host bind mount, pnpm falls back to creating a per-project .pnpm-store inside the project -
// which then ends up on the host repo. Mounting a host-side cache dir onto pnpm's default global store path puts the store on the same
// device as the workspace and node_modules shadow, eliminating the fallback.
// =========================================================================================================================================

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONTAINER_HOME, PNPM_STORE_DIR } from "./constants.js";

const CONTAINER_PNPM_STORE = `${CONTAINER_HOME}/.local/share/pnpm/store`;

/**
 * Lazily creates the host-side pnpm store directory under the workspace cache dir
 * and returns -v args mounting it onto pnpm's default global store path in the container.
 */
export function buildPnpmStoreMountArgs(workspaceCacheDir: string): string[] {
    const hostStore = join(workspaceCacheDir, PNPM_STORE_DIR);
    mkdirSync(hostStore, { recursive: true });
    return ["-v", `${hostStore}:${CONTAINER_PNPM_STORE}`];
}
