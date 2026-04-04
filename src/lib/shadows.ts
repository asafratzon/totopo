// =========================================================================================================================================
// src/lib/shadows.ts - Gitignore-style shadow path expansion and sync
// Expands patterns like "node_modules", ".env*" into concrete paths, then syncs shadow directories.
// =========================================================================================================================================

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import fg from "fast-glob";

// --- Pattern expansion -------------------------------------------------------------------------------------------------------------------

/**
 * Expand gitignore-style patterns into concrete relative paths.
 *
 * Patterns without a directory separator are treated as recursive (prepended with **&#47;)
 * following gitignore convention. Patterns with a / are matched relative to the workspace root.
 * Matched directories are not recursed into (e.g. node_modules matches once, not its children).
 */
export function expandShadowPatterns(patterns: string[], workspaceRoot: string): string[] {
    if (patterns.length === 0) return [];

    // Convert gitignore-style patterns to fast-glob patterns
    const globPatterns = patterns.map((p) => (p.includes("/") ? p : `**/${p}`));

    // Build ignore list: skip .git and contents of any matched directory
    const ignorePatterns = ["**/.git", ...globPatterns.map((p) => `${p}/**/*`)];

    const results = fg.sync(globPatterns, {
        cwd: workspaceRoot,
        onlyFiles: false,
        dot: true,
        ignore: ignorePatterns,
    });

    return results.sort();
}

// --- Hit counting (for menu UX) ----------------------------------------------------------------------------------------------------------

/** Count how many paths a pattern would match in the workspace. */
export function countPatternHits(pattern: string, workspaceRoot: string): number {
    return expandShadowPatterns([pattern], workspaceRoot).length;
}

// --- Shadow sync -------------------------------------------------------------------------------------------------------------------------

/**
 * Ensures the shadows/ directory matches the given expanded paths.
 * - Creates missing shadow entries (empty dir or empty file, matching source path type)
 * - If `freshPaths` is provided, those entries are deleted and recreated (clean slate)
 * - Removes shadow entries not in the expanded set
 * - Cleans up empty parent directories
 */
export function ensureShadowsInSync(workspaceDir: string, expandedPaths: string[], workspaceRoot: string, freshPaths?: Set<string>): void {
    const expected = new Set(expandedPaths);
    const shadowsDir = join(workspaceDir, "shadows");

    // Create shadows/ root if needed
    mkdirSync(shadowsDir, { recursive: true });

    // Remove stale entries
    removeStaleEntries(shadowsDir, shadowsDir, expected);

    // Create or refresh expected entries
    for (const relPath of expected) {
        const sourcePath = join(workspaceRoot, relPath);
        const shadowPath = join(shadowsDir, relPath);

        if (freshPaths?.has(relPath) && existsSync(shadowPath)) {
            rmSync(shadowPath, { recursive: true, force: true });
        }

        if (!existsSync(shadowPath)) {
            createShadowEntry(sourcePath, shadowPath);
        }
    }
}

// --- Mount args --------------------------------------------------------------------------------------------------------------------------

/** Build -v args for shadow mounts from expanded paths. */
export function buildShadowMountArgs(workspaceDir: string, expandedPaths: string[]): string[] {
    const args: string[] = [];
    for (const relPath of expandedPaths) {
        args.push("-v", `${join(workspaceDir, "shadows", relPath)}:/workspace/${relPath}`);
    }
    return args;
}

// --- Helpers -----------------------------------------------------------------------------------------------------------------------------

function createShadowEntry(sourcePath: string, shadowPath: string): void {
    if (existsSync(sourcePath) && !lstatSync(sourcePath).isDirectory()) {
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
