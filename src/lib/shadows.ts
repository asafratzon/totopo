// =========================================================================================================================================
// src/lib/shadows.ts - Sync shadows/ directory on disk with shadowPaths in settings.json
// =========================================================================================================================================

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readSettings } from "./config.js";

/**
 * Ensures the shadows/ directory matches the shadowPaths in settings.json.
 *
 * - Creates missing shadow entries (empty dir or empty file, matching the project path type)
 * - If `freshPaths` is provided, those entries are deleted and recreated (clean slate for new additions)
 * - Removes shadow entries not listed in settings
 * - Cleans up empty parent directories left behind after removals
 */
export function ensureShadowsInSync(projectDir: string, projectRoot: string, freshPaths?: Set<string>): void {
    const settings = readSettings(projectDir);
    const expected = new Set(settings.shadowPaths);
    const shadowsDir = join(projectDir, "shadows");

    // Create shadows/ root if needed
    mkdirSync(shadowsDir, { recursive: true });

    // Remove entries on disk that are no longer in settings
    removeStaleEntries(shadowsDir, shadowsDir, expected);

    // Create or refresh expected entries
    for (const relPath of expected) {
        const projectPath = join(projectRoot, relPath);
        const shadowPath = join(shadowsDir, relPath);

        if (freshPaths?.has(relPath) && existsSync(shadowPath)) {
            rmSync(shadowPath, { recursive: true, force: true });
        }

        if (!existsSync(shadowPath)) {
            createShadowEntry(projectPath, shadowPath);
        }
    }
}

// --- Helpers -----------------------------------------------------------------------------------------------------------------------------

function createShadowEntry(projectPath: string, shadowPath: string): void {
    if (existsSync(projectPath) && !lstatSync(projectPath).isDirectory()) {
        mkdirSync(dirname(shadowPath), { recursive: true });
        writeFileSync(shadowPath, "");
    } else {
        mkdirSync(shadowPath, { recursive: true });
    }
}

/**
 * Walk the shadows/ tree and remove any entry whose relative path is not in the expected set.
 * After removing leaf entries, prunes empty parent directories.
 */
function removeStaleEntries(baseDir: string, currentDir: string, expected: Set<string>): void {
    if (!existsSync(currentDir)) return;

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
        const fullPath = join(currentDir, entry.name);
        const rel = relative(baseDir, fullPath);

        if (expected.has(rel)) {
            // This path is expected - keep it
            continue;
        }

        if (entry.isDirectory()) {
            // Check if any expected path is nested under this directory
            const hasExpectedChild = [...expected].some((p) => p.startsWith(`${rel}/`));
            if (hasExpectedChild) {
                // Recurse into the directory to clean stale children
                removeStaleEntries(baseDir, fullPath, expected);
            } else {
                // No expected paths under here - remove entirely
                rmSync(fullPath, { recursive: true, force: true });
            }
        } else {
            // Stale file - remove
            rmSync(fullPath, { force: true });
        }
    }

    // Prune if this directory is now empty (and is not the shadows root)
    if (currentDir !== baseDir && readdirSync(currentDir).length === 0) {
        rmSync(currentDir, { recursive: true, force: true });
    }
}
