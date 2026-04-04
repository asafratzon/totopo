// =========================================================================================================================================
// src/lib/workspace-identity.ts - Workspace identity, registration, and lookup
// Uses workspace_id from totopo.yaml. Lock files in ~/.totopo/workspaces/<workspace_id>/
// =========================================================================================================================================

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readTotopoYaml, TOTOPO_YAML } from "./totopo-yaml.js";

export { TOTOPO_YAML };

// --- Interfaces --------------------------------------------------------------------------------------------------------------------------

export interface WorkspaceContext {
    workspaceId: string; // unique slug from totopo.yaml (e.g. "my-project")
    workspaceRoot: string; // absolute path to the repo/dir containing totopo.yaml
    containerName: string; // docker container and image name (e.g. "totopo-my-project")
    workspaceDir: string; // host cache dir: ~/.totopo/workspaces/<workspace_id>/
    displayName: string; // human-readable name from totopo.yaml, falls back to workspaceId
}

// --- Path helpers ------------------------------------------------------------------------------------------------------------------------

/** Base directory for all workspace caches — ~/.totopo/workspaces/ */
export function getWorkspacesBaseDir(): string {
    return join(homedir(), ".totopo", "workspaces");
}

/** Cache directory for a specific workspace — ~/.totopo/workspaces/<workspace_id>/ */
export function getWorkspaceDir(workspaceId: string): string {
    return join(getWorkspacesBaseDir(), workspaceId);
}

/** Derive container and image name from workspace ID */
export function deriveContainerName(workspaceId: string): string {
    return `totopo-${workspaceId}`;
}

// --- Lock file (stores workspace root path and active profile) ---------------------------------------------------------------------------
// Format: line 1 = absolute workspace root path, line 2 = active profile name

const LOCK_FILE = ".lock";

/** Parse a lock file into its two fields. */
function parseLockFile(workspaceId: string): { workspaceRoot: string; activeProfile: string } | null {
    const lockPath = join(getWorkspaceDir(workspaceId), LOCK_FILE);
    if (!existsSync(lockPath)) return null;
    try {
        const lines = readFileSync(lockPath, "utf8").trimEnd().split("\n");
        const workspaceRoot = lines[0]?.trim();
        if (!workspaceRoot) return null;
        return { workspaceRoot, activeProfile: lines[1]?.trim() || "default" };
    } catch {
        return null;
    }
}

/** Write lock file with workspace root path and active profile. */
function writeLockFileInternal(workspaceId: string, workspaceRoot: string, activeProfile: string): void {
    const dir = getWorkspaceDir(workspaceId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LOCK_FILE), `${workspaceRoot}\n${activeProfile}\n`);
}

/** Read a workspace's lock file. Returns the absolute workspace root path, or null if missing. */
export function readLockFile(workspaceId: string): string | null {
    return parseLockFile(workspaceId)?.workspaceRoot ?? null;
}

/** Write a workspace's lock file with the owning workspace root path. Preserves active profile if already set. */
export function writeLockFile(workspaceId: string, workspaceRoot: string): void {
    const existing = parseLockFile(workspaceId);
    writeLockFileInternal(workspaceId, workspaceRoot, existing?.activeProfile ?? "default");
}

/** Read the active profile name. Returns null if lock file is missing. */
export function readActiveProfile(workspaceId: string): string | null {
    return parseLockFile(workspaceId)?.activeProfile ?? null;
}

/** Write the active profile name. Preserves workspace root path. */
export function writeActiveProfile(workspaceId: string, profile: string): void {
    const existing = parseLockFile(workspaceId);
    if (!existing) return;
    writeLockFileInternal(workspaceId, existing.workspaceRoot, profile);
}

// --- Workspace directory initialization --------------------------------------------------------------------------------------------------

/** Initialize ~/.totopo/workspaces/<workspace_id>/ with lock file and subdirs. */
export function initWorkspaceDir(workspaceId: string, workspaceRoot: string, activeProfile = "default"): void {
    const dir = getWorkspaceDir(workspaceId);
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "shadows"), { recursive: true });
    writeLockFileInternal(workspaceId, workspaceRoot, activeProfile);
}

// --- Listing -----------------------------------------------------------------------------------------------------------------------------

/** List all registered workspace IDs (directories with a .lock file) */
export function listWorkspaceIds(): string[] {
    const base = getWorkspacesBaseDir();
    if (!existsSync(base)) return [];
    try {
        return readdirSync(base).filter((name) => existsSync(join(base, name, LOCK_FILE)));
    } catch {
        return [];
    }
}

/** List all registered workspaces as WorkspaceContext objects. Skips entries whose lock target has no totopo.yaml. */
export function listWorkspaces(): WorkspaceContext[] {
    return listWorkspaceIds()
        .map((workspaceId) => {
            const lockPath = readLockFile(workspaceId);
            if (!lockPath) return null;
            try {
                const yaml = readTotopoYaml(lockPath);
                if (!yaml || yaml.workspace_id !== workspaceId) return null;
                return {
                    workspaceId,
                    workspaceRoot: lockPath,
                    containerName: deriveContainerName(workspaceId),
                    workspaceDir: getWorkspaceDir(workspaceId),
                    displayName: yaml.name || workspaceId,
                };
            } catch {
                return null;
            }
        })
        .filter((w): w is WorkspaceContext => w !== null);
}

// --- Resolution --------------------------------------------------------------------------------------------------------------------------

/**
 * Walk up from the given path looking for totopo.yaml. If found, read workspace_id,
 * verify lock file, and return WorkspaceContext. Returns null if no totopo.yaml found
 * or if the workspace dir is not initialized.
 */
export function resolveWorkspace(fromPath: string): WorkspaceContext | null {
    let current = fromPath;
    while (true) {
        const yaml = readTotopoYaml(current);
        if (yaml) {
            const lockPath = readLockFile(yaml.workspace_id);
            // Workspace dir exists and lock matches this path
            if (lockPath === current) {
                return {
                    workspaceId: yaml.workspace_id,
                    workspaceRoot: current,
                    containerName: deriveContainerName(yaml.workspace_id),
                    workspaceDir: getWorkspaceDir(yaml.workspace_id),
                    displayName: yaml.name || yaml.workspace_id,
                };
            }
            // totopo.yaml found but workspace not initialized or lock mismatch - return null
            // (caller handles onboarding / collision)
            return null;
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

/**
 * Walk up from the given path looking for totopo.yaml. Returns the directory containing it, or null.
 */
export function findTotopoYamlDir(fromPath: string): string | null {
    let current = fromPath;
    while (true) {
        if (existsSync(join(current, TOTOPO_YAML))) return current;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

// --- Collision and orphan detection ------------------------------------------------------------------------------------------------------

/** Check if a workspace_id's lock file points to a different path than expected. */
export function checkCollision(workspaceId: string, currentPath: string): "ok" | "collision" {
    const lockPath = readLockFile(workspaceId);
    if (lockPath === null) return "ok"; // no lock = no collision
    return lockPath === currentPath ? "ok" : "collision";
}

/**
 * Scan all workspace dirs for a lock file pointing to the given path.
 * Used when a workspace_id has changed and we need to find the orphaned dir.
 * Returns the orphan's workspace_id, or null.
 */
export function findOrphanWorkspaceDir(currentPath: string): string | null {
    for (const id of listWorkspaceIds()) {
        const lockPath = readLockFile(id);
        if (lockPath === currentPath) return id;
    }
    return null;
}
