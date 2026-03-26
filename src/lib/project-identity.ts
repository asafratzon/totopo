// =========================================================================================================================================
// src/lib/project-identity.ts - Project identity, registration, and lookup
// Maps project root paths to stable IDs stored in ~/.totopo/projects/
// =========================================================================================================================================

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface ProjectMeta {
    projectRoot: string;
    displayName: string;
    containerName: string;
    gitRemoteUrl?: string;
    nonGitWarningAcknowledged?: boolean;
}

export interface ProjectContext {
    id: string;
    meta: ProjectMeta;
    projectDir: string; // ~/.totopo/projects/<id>
}

/** Stable SHA-256 hash of the absolute project root path */
export function hashProjectPath(absolutePath: string): string {
    return createHash("sha256").update(absolutePath).digest("hex");
}

/** First 8 characters of the hash — used in container/image names */
function truncateHash(id: string): string {
    return id.slice(0, 8);
}

/** Slugify a directory name for use in Docker container/image names (max 20 chars) */
function slugifyName(name: string): string {
    return (
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 20) || "workspace"
    );
}

/** Derive a human-readable container/image name from project ID and root directory name */
export function deriveContainerName(id: string, projectRoot: string): string {
    return `totopo-${truncateHash(id)}-${slugifyName(basename(projectRoot))}`;
}

/** Base directory for all project configs — ~/.totopo/projects/ */
export function getProjectsBaseDir(): string {
    return join(homedir(), ".totopo", "projects");
}

/** Config directory for a specific project — ~/.totopo/projects/<id>/ */
export function getProjectDir(id: string): string {
    return join(getProjectsBaseDir(), id);
}

/** Read a project's meta.json; returns null if missing or invalid */
export function readProjectMeta(id: string): ProjectMeta | null {
    const metaPath = join(getProjectDir(id), "meta.json");
    if (!existsSync(metaPath)) return null;
    try {
        const raw = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
        if (typeof raw.projectRoot !== "string" || typeof raw.displayName !== "string" || typeof raw.containerName !== "string") {
            return null;
        }
        const meta: ProjectMeta = {
            projectRoot: raw.projectRoot,
            displayName: raw.displayName,
            containerName: raw.containerName,
        };
        if (typeof raw.gitRemoteUrl === "string") meta.gitRemoteUrl = raw.gitRemoteUrl;
        if (typeof raw.nonGitWarningAcknowledged === "boolean") meta.nonGitWarningAcknowledged = raw.nonGitWarningAcknowledged;
        return meta;
    } catch {
        return null;
    }
}

/** Write a project's meta.json, creating the project directory if needed */
export function writeProjectMeta(id: string, meta: ProjectMeta): void {
    const dir = getProjectDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 4)}\n`);
}

/** List all registered project IDs (directories with a meta.json) */
export function listProjectIds(): string[] {
    const base = getProjectsBaseDir();
    if (!existsSync(base)) return [];
    try {
        return readdirSync(base).filter((name) => existsSync(join(base, name, "meta.json")));
    } catch {
        return [];
    }
}

/** List all registered projects as ProjectContext objects */
export function listProjects(): ProjectContext[] {
    return listProjectIds()
        .map((id) => {
            const meta = readProjectMeta(id);
            return meta ? { id, meta, projectDir: getProjectDir(id) } : null;
        })
        .filter((p): p is ProjectContext => p !== null);
}

/** Register a new project — creates the project dir and writes meta.json */
export function registerProject(projectRoot: string, gitRemoteUrl?: string): ProjectContext {
    const id = hashProjectPath(projectRoot);
    const containerName = deriveContainerName(id, projectRoot);
    const meta: ProjectMeta = {
        projectRoot,
        displayName: basename(projectRoot),
        containerName,
        ...(gitRemoteUrl !== undefined ? { gitRemoteUrl } : {}),
    };
    writeProjectMeta(id, meta);
    return { id, meta, projectDir: getProjectDir(id) };
}

/**
 * Walk up from the given path and return the first registered project whose root
 * is an ancestor of (or equal to) the given path. Returns null if none found.
 * Resolves the most-specific (deepest) ancestor when multiple projects could match.
 */
export function resolveProject(fromPath: string): ProjectContext | null {
    const projects = listProjects();
    if (projects.length === 0) return null;

    // Sort by path length descending - deepest root wins
    const sorted = [...projects].sort((a, b) => b.meta.projectRoot.length - a.meta.projectRoot.length);

    let current = fromPath;
    while (true) {
        const match = sorted.find((p) => p.meta.projectRoot === current);
        if (match) return match;
        const parent = dirname(current);
        if (parent === current) break; // reached filesystem root
        current = parent;
    }
    return null;
}

/**
 * Check if a given candidate root path conflicts with (is inside) any existing
 * registered project. Returns the conflicting project if found, null if safe.
 */
export function findConflictingProject(candidateRoot: string): ProjectContext | null {
    for (const p of listProjects()) {
        if (candidateRoot === p.meta.projectRoot || candidateRoot.startsWith(`${p.meta.projectRoot}/`)) {
            return p;
        }
    }
    return null;
}
