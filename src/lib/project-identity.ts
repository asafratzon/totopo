// =========================================================================================================================================
// src/lib/project-identity.ts - Project identity, registration, and lookup
// Uses project_id from totopo.yaml instead of path hashing. Lock files in ~/.totopo/projects/<project_id>/
// =========================================================================================================================================

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readTotopoYaml, TOTOPO_YAML } from "./totopo-yaml.js";

export { TOTOPO_YAML };

// --- Interfaces --------------------------------------------------------------------------------------------------------------------------

export interface ProjectContext {
    projectId: string;
    projectRoot: string;
    containerName: string;
    projectDir: string; // ~/.totopo/projects/<project_id>
    displayName: string;
}

// --- Path helpers ------------------------------------------------------------------------------------------------------------------------

/** Base directory for all project caches — ~/.totopo/projects/ */
export function getProjectsBaseDir(): string {
    return join(homedir(), ".totopo", "projects");
}

/** Cache directory for a specific project — ~/.totopo/projects/<project_id>/ */
export function getProjectDir(projectId: string): string {
    return join(getProjectsBaseDir(), projectId);
}

/** Derive container and image name from project ID */
export function deriveContainerName(projectId: string): string {
    return `totopo-${projectId}`;
}

// --- Lock file (stores project root path and active profile) -----------------------------------------------------------------------------
// Format: line 1 = absolute project root path, line 2 = active profile name

const LOCK_FILE = ".lock";

/** Parse a lock file into its two fields. */
function parseLockFile(projectId: string): { projectRoot: string; activeProfile: string } | null {
    const lockPath = join(getProjectDir(projectId), LOCK_FILE);
    if (!existsSync(lockPath)) return null;
    try {
        const lines = readFileSync(lockPath, "utf8").trimEnd().split("\n");
        const projectRoot = lines[0]?.trim();
        if (!projectRoot) return null;
        return { projectRoot, activeProfile: lines[1]?.trim() || "default" };
    } catch {
        return null;
    }
}

/** Write lock file with project root path and active profile. */
function writeLockFileInternal(projectId: string, projectRoot: string, activeProfile: string): void {
    const dir = getProjectDir(projectId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LOCK_FILE), `${projectRoot}\n${activeProfile}\n`);
}

/** Read a project's lock file. Returns the absolute project root path, or null if missing. */
export function readLockFile(projectId: string): string | null {
    return parseLockFile(projectId)?.projectRoot ?? null;
}

/** Write a project's lock file with the owning project root path. Preserves active profile if already set. */
export function writeLockFile(projectId: string, projectRoot: string): void {
    const existing = parseLockFile(projectId);
    writeLockFileInternal(projectId, projectRoot, existing?.activeProfile ?? "default");
}

/** Read the active profile name. Returns null if lock file is missing. */
export function readActiveProfile(projectId: string): string | null {
    return parseLockFile(projectId)?.activeProfile ?? null;
}

/** Write the active profile name. Preserves project root path. */
export function writeActiveProfile(projectId: string, profile: string): void {
    const existing = parseLockFile(projectId);
    if (!existing) return;
    writeLockFileInternal(projectId, existing.projectRoot, profile);
}

// --- Project directory initialization ----------------------------------------------------------------------------------------------------

/** Initialize ~/.totopo/projects/<project_id>/ with lock file and subdirs. */
export function initProjectDir(projectId: string, projectRoot: string, activeProfile = "default"): void {
    const dir = getProjectDir(projectId);
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "shadows"), { recursive: true });
    writeLockFileInternal(projectId, projectRoot, activeProfile);
}

// --- Listing -----------------------------------------------------------------------------------------------------------------------------

/** List all registered project IDs (directories with a .lock file) */
export function listProjectIds(): string[] {
    const base = getProjectsBaseDir();
    if (!existsSync(base)) return [];
    try {
        return readdirSync(base).filter((name) => existsSync(join(base, name, LOCK_FILE)));
    } catch {
        return [];
    }
}

/** List all registered projects as ProjectContext objects. Skips entries whose lock target has no totopo.yaml. */
export function listProjects(): ProjectContext[] {
    return listProjectIds()
        .map((projectId) => {
            const lockPath = readLockFile(projectId);
            if (!lockPath) return null;
            try {
                const yaml = readTotopoYaml(lockPath);
                if (!yaml || yaml.project_id !== projectId) return null;
                return {
                    projectId,
                    projectRoot: lockPath,
                    containerName: deriveContainerName(projectId),
                    projectDir: getProjectDir(projectId),
                    displayName: yaml.name || projectId,
                };
            } catch {
                return null;
            }
        })
        .filter((p): p is ProjectContext => p !== null);
}

// --- Resolution --------------------------------------------------------------------------------------------------------------------------

/**
 * Walk up from the given path looking for totopo.yaml. If found, read project_id,
 * verify lock file, and return ProjectContext. Returns null if no totopo.yaml found
 * or if the project dir is not initialized.
 */
export function resolveProject(fromPath: string): ProjectContext | null {
    let current = fromPath;
    while (true) {
        const yaml = readTotopoYaml(current);
        if (yaml) {
            const projectDir = getProjectDir(yaml.project_id);
            const lockPath = readLockFile(yaml.project_id);
            // Project dir exists and lock matches this path
            if (lockPath === current) {
                return {
                    projectId: yaml.project_id,
                    projectRoot: current,
                    containerName: deriveContainerName(yaml.project_id),
                    projectDir,
                    displayName: yaml.name || yaml.project_id,
                };
            }
            // totopo.yaml found but project not initialized or lock mismatch - return null
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

/** Check if a project_id's lock file points to a different path than expected. */
export function checkCollision(projectId: string, currentPath: string): "ok" | "collision" {
    const lockPath = readLockFile(projectId);
    if (lockPath === null) return "ok"; // no lock = no collision
    return lockPath === currentPath ? "ok" : "collision";
}

/**
 * Scan all project dirs for a lock file pointing to the given path.
 * Used when a project_id has changed and we need to find the orphaned dir.
 * Returns the orphan's project_id, or null.
 */
export function findOrphanProjectDir(currentPath: string): string | null {
    for (const id of listProjectIds()) {
        const lockPath = readLockFile(id);
        if (lockPath === currentPath) return id;
    }
    return null;
}
