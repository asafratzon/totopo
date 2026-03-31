// =========================================================================================================================================
// src/lib/migrate-v2.ts - Detect and migrate legacy ~/.totopo/ structures
// Legacy format used SHA-256 hash directories with meta.json. Current format uses project_id with .lock files.
// =========================================================================================================================================

import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { intro, log, outro } from "@clack/prompts";
import { load as loadYaml } from "js-yaml";
import { getProjectsBaseDir, initProjectDir } from "./project-identity.js";
import {
    buildDefaultTotopoYaml,
    readTotopoYaml,
    slugifyForProjectId,
    type TotopoYamlConfig,
    validateProjectId,
    writeTotopoYaml,
} from "./totopo-yaml.js";

interface V2Project {
    hashId: string;
    projectRoot: string;
    displayName: string;
    shadowPaths: string[];
}

/** Check if a directory looks like a v2 project (has meta.json) */
function isV2ProjectDir(dirPath: string): boolean {
    return existsSync(join(dirPath, "meta.json"));
}

/** Read v2 meta.json */
function readV2Meta(dirPath: string): { projectRoot: string; displayName: string } | null {
    try {
        const raw = JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf8"));
        if (typeof raw.projectRoot === "string" && typeof raw.displayName === "string") {
            return { projectRoot: raw.projectRoot, displayName: raw.displayName };
        }
        return null;
    } catch {
        return null;
    }
}

/** Read v2 settings.json for shadow paths */
function readV2ShadowPaths(dirPath: string): string[] {
    try {
        const raw = JSON.parse(readFileSync(join(dirPath, "settings.json"), "utf8"));
        if (Array.isArray(raw.shadowPaths)) return raw.shadowPaths;
        return [];
    } catch {
        return [];
    }
}

/** Read name and description from a v2-era totopo.yaml (no schema_version or project_id) */
function readV2YamlFields(projectRoot: string): { name?: string; description?: string } | null {
    try {
        const raw = loadYaml(readFileSync(join(projectRoot, "totopo.yaml"), "utf8"));
        if (typeof raw !== "object" || raw === null) return null;
        const obj = raw as Record<string, unknown>;
        const result: { name?: string; description?: string } = {};
        if (typeof obj.name === "string") result.name = obj.name;
        if (typeof obj.description === "string") result.description = obj.description;
        return result;
    } catch {
        return null;
    }
}

/** Detect all v2 projects in ~/.totopo/projects/ */
function detectV2Projects(): V2Project[] {
    const baseDir = getProjectsBaseDir();
    if (!existsSync(baseDir)) return [];

    const results: V2Project[] = [];
    try {
        for (const entry of readdirSync(baseDir)) {
            const dirPath = join(baseDir, entry);
            if (!isV2ProjectDir(dirPath)) continue;

            const meta = readV2Meta(dirPath);
            if (!meta) continue;

            results.push({
                hashId: entry,
                projectRoot: meta.projectRoot,
                displayName: meta.displayName,
                shadowPaths: readV2ShadowPaths(dirPath),
            });
        }
    } catch {
        // scan failure - skip migration
    }
    return results;
}

/** Generate a unique project_id, avoiding collisions with existing dirs */
function generateUniqueProjectId(displayName: string, existingIds: Set<string>): string {
    let candidate = slugifyForProjectId(displayName);
    const err = validateProjectId(candidate);
    if (err) candidate = "migrated-project";

    if (!existingIds.has(candidate)) return candidate;

    for (let i = 2; i <= 99; i++) {
        const suffixed = `${candidate}-${i}`;
        if (!existingIds.has(suffixed)) return suffixed;
    }

    return `${candidate}-${Date.now().toString(36).slice(-4)}`;
}

/** Migrate a single legacy project */
function migrateProject(v2: V2Project, existingIds: Set<string>): string | null {
    // Skip if project root no longer exists
    if (!existsSync(v2.projectRoot)) {
        log.warn(`Skipping "${v2.displayName}" — project root no longer exists: ${v2.projectRoot}`);
        return null;
    }

    // Check if a valid v3 totopo.yaml already exists at project root
    let yaml: TotopoYamlConfig | null = null;
    try {
        yaml = readTotopoYaml(v2.projectRoot);
    } catch {
        // Invalid or v2-era totopo.yaml - will be overwritten below
    }

    let projectId: string;

    if (yaml) {
        projectId = yaml.project_id;
    } else {
        // Read name/description from existing v2 totopo.yaml if present
        const v2Name = readV2YamlFields(v2.projectRoot);

        projectId = generateUniqueProjectId(v2.displayName, existingIds);
        yaml = buildDefaultTotopoYaml(projectId, v2Name?.name ?? v2.displayName, v2Name?.description);

        // Carry over shadow paths from v2
        if (v2.shadowPaths.length > 0) {
            yaml.shadow_paths = [...new Set([...(yaml.shadow_paths ?? []), ...v2.shadowPaths])];
        }

        writeTotopoYaml(v2.projectRoot, yaml);
        log.info(`Created totopo.yaml for "${v2.displayName}" (project_id: ${projectId})`);
    }

    // Initialize new project dir
    const newDir = join(getProjectsBaseDir(), projectId);
    initProjectDir(projectId, v2.projectRoot);

    // Move agents/ if present
    const oldAgents = join(getProjectsBaseDir(), v2.hashId, "agents");
    const newAgents = join(newDir, "agents");
    if (existsSync(oldAgents)) {
        // Copy contents (initProjectDir already created agents/)
        try {
            cpSync(oldAgents, newAgents, { recursive: true, force: true });
        } catch {
            log.warn(`Could not copy agent memory for "${v2.displayName}"`);
        }
    }

    // Move shadows/ if present
    const oldShadows = join(getProjectsBaseDir(), v2.hashId, "shadows");
    const newShadows = join(newDir, "shadows");
    if (existsSync(oldShadows)) {
        try {
            cpSync(oldShadows, newShadows, { recursive: true, force: true });
        } catch {
            log.warn(`Could not copy shadow data for "${v2.displayName}"`);
        }
    }

    // Remove old hash directory
    rmSync(join(getProjectsBaseDir(), v2.hashId), { recursive: true, force: true });

    existingIds.add(projectId);
    return projectId;
}

/** Run the full legacy migration. Called early in bin/totopo.js startup. */
export async function runMigration(): Promise<void> {
    const v2Projects = detectV2Projects();
    if (v2Projects.length === 0) return;

    process.stdout.write("\n");
    intro("totopo · migrating legacy projects");

    log.info(`Found ${v2Projects.length} v2 project(s) to migrate.`);

    // Collect existing project IDs to avoid collisions
    const baseDir = getProjectsBaseDir();
    const existingIds = new Set<string>();
    if (existsSync(baseDir)) {
        for (const entry of readdirSync(baseDir)) {
            if (existsSync(join(baseDir, entry, ".lock"))) {
                existingIds.add(entry);
            }
        }
    }

    let migrated = 0;
    for (const v2 of v2Projects) {
        const result = migrateProject(v2, existingIds);
        if (result) {
            log.success(`Migrated "${v2.displayName}" → project_id: ${result}`);
            migrated++;
        }
    }

    // Check for global .env file
    const globalEnv = join(homedir(), ".totopo", ".env");
    if (existsSync(globalEnv)) {
        log.warn(
            `Found ~/.totopo/.env (v2 API keys file).\n` +
                `  Use env_file in totopo.yaml to point to your project's .env file.\n` +
                `  Move your keys to a project-local .env and set env_file: .env in totopo.yaml.`,
        );
    }

    if (migrated > 0) {
        outro(`Migration complete — ${migrated} project(s) migrated.`);
    } else {
        outro("No projects could be migrated.");
    }
}
