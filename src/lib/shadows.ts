// =========================================================================================================================================
// src/lib/shadows.ts - Gitignore-style shadow path expansion and sync
// Expands patterns like "node_modules", ".env*" into concrete paths, then syncs shadow directories.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import fg from "fast-glob";
import { CONTAINER_WORKSPACE, SHADOWS_DIR } from "./constants.js";
import { safeRmSync } from "./safe-rm.js";

// --- Pattern expansion -------------------------------------------------------------------------------------------------------------------

export interface ExpandShadowsResult {
    // Shadow paths to apply (post-filter)
    paths: string[];
    // Paths dropped because git tracks them (or content beneath them)
    skippedTracked: string[];
}

/**
 * Expand gitignore-style patterns into concrete relative paths.
 *
 * Patterns without a directory separator are treated as recursive (prepended with **&#47;)
 * following gitignore convention. Patterns with a / are matched relative to the workspace root.
 * Matched directories are not recursed into (e.g. node_modules matches once, not its children).
 *
 * Paths that git tracks (or whose descendants git tracks) are dropped from the result and
 * reported in skippedTracked. Shadowing tracked content is a no-op (agents can `git show` it)
 * and breaks `git stash`/`pop` workflows.
 */
export function expandShadowPatterns(patterns: string[], workspaceRoot: string): ExpandShadowsResult {
    if (patterns.length === 0) return { paths: [], skippedTracked: [] };

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

    const expanded = removeNestedPaths(results.sort());
    const { kept, dropped } = filterGitTrackedPaths(expanded, workspaceRoot);
    return { paths: kept, skippedTracked: dropped };
}

// --- Hit counting (for menu UX) ----------------------------------------------------------------------------------------------------------

/** Count how many paths a pattern would match in the workspace (post git-tracked filter). */
export function countPatternHits(pattern: string, workspaceRoot: string): number {
    return expandShadowPatterns([pattern], workspaceRoot).paths.length;
}

// --- Git-tracked filtering ---------------------------------------------------------------------------------------------------------------

/**
 * Partition expanded shadow paths into those safe to shadow and those tracked by git.
 * A path is dropped if it equals a tracked file, or (for directories) any tracked file
 * lives anywhere beneath it. Returns the input unchanged when no .git is present.
 */
function filterGitTrackedPaths(paths: string[], workspaceRoot: string): { kept: string[]; dropped: string[] } {
    if (paths.length === 0) return { kept: [], dropped: [] };
    // .git may be a file (worktrees) or a directory; existsSync handles both
    if (!existsSync(join(workspaceRoot, ".git"))) return { kept: paths, dropped: [] };

    // Pass shadow paths as pathspecs so git enumerates only tracked files within them.
    // Output then scales with shadow scope (typically tiny), not the size of the repo index.
    const result = spawnSync("git", ["-C", workspaceRoot, "ls-files", "-z", "--", ...paths], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) return { kept: paths, dropped: [] };

    const matched = result.stdout.split("\0").filter((s) => s.length > 0);
    if (matched.length === 0) return { kept: paths, dropped: [] };

    const matchedSet = new Set(matched);
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const p of paths) {
        const prefix = `${p}/`;
        if (matchedSet.has(p) || matched.some((f) => f.startsWith(prefix))) {
            dropped.push(p);
        } else {
            kept.push(p);
        }
    }
    return { kept, dropped };
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
    const shadowsDir = join(workspaceDir, SHADOWS_DIR);

    // Create shadows/ root if needed
    mkdirSync(shadowsDir, { recursive: true });

    // Remove stale entries
    removeStaleEntries(shadowsDir, shadowsDir, expected);

    // Create or refresh expected entries
    for (const relPath of expected) {
        const sourcePath = join(workspaceRoot, relPath);
        const shadowPath = join(shadowsDir, relPath);

        if (freshPaths?.has(relPath) && existsSync(shadowPath)) {
            safeRmSync(shadowPath, { recursive: true, force: true });
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
        args.push("-v", `${join(workspaceDir, SHADOWS_DIR, relPath)}:${CONTAINER_WORKSPACE}/${relPath}`);
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
            const hasExpectedChild = [...expected].some((p) => isDescendantOf(p, rel));
            if (hasExpectedChild) {
                // Recurse into the directory to clean stale children
                removeStaleEntries(baseDir, fullPath, expected);
            } else {
                // No expected paths under here - remove entirely
                safeRmSync(fullPath, { recursive: true, force: true });
            }
        } else {
            // Stale file - remove
            safeRmSync(fullPath, { force: true });
        }
    }

    // Prune if this directory is now empty (and is not the shadows root)
    if (currentDir !== baseDir && readdirSync(currentDir).length === 0) {
        safeRmSync(currentDir, { recursive: true, force: true });
    }
}

/**
 * Drop paths that descend from another path in the input (keeps only the outermost path per subtree),
 * so nested matches (e.g. node_modules inside a shadowed .next dir) don't become redundant bind mounts.
 */
function removeNestedPaths(paths: string[]): string[] {
    const unique = [...new Set(paths)];
    return unique.filter((p) => !unique.some((a) => a !== p && isDescendantOf(p, a)));
}

// Expects forward-slash paths (fast-glob output and shadows/ relative paths on POSIX).
function isDescendantOf(child: string, ancestor: string): boolean {
    return child.startsWith(`${ancestor}/`);
}
