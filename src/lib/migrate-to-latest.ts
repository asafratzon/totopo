// =========================================================================================================================================
// src/lib/migrate-to-latest.ts - Detect and migrate legacy ~/.totopo/ structures
//
// Legacy version layouts and what each migration converts to latest:
//
//   v2.x (~/.totopo/projects/<sha256-hash>/)
//     Each workspace stored as: meta.json, settings.json, agents/, shadows/
//     Global API keys in ~/.totopo/.env
//     Optional totopo.yaml with name field (no schema_version)
//
//   v3-rc-1/rc-2 (~/.totopo/workspaces/<workspace_id>/)
//     Renamed projects/ to workspaces/, hash dirs to workspace_id dirs
//     totopo.yaml required, used project_id key
//     Per-workspace env_file replaces global .env
//
//   v3-rc-3+ (latest)
//     project_id renamed to workspace_id in totopo.yaml
//
// All migrations are idempotent - each checks if needed and skips if not.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { load as loadYaml } from "js-yaml";
import {
    AGENTS_DIR,
    CONTAINER_NAME_PREFIX,
    GLOBAL_ENV_FILE,
    LOCK_FILE,
    PROJECTS_DIR,
    SHADOWS_DIR,
    TOTOPO_DIR,
    TOTOPO_YAML,
    WORKSPACES_DIR,
} from "./constants.js";
import { safeRmSync } from "./safe-rm.js";
import {
    buildDefaultTotopoYaml,
    readTotopoYaml,
    slugifyForWorkspaceId,
    type TotopoYamlConfig,
    validateWorkspaceId,
    writeTotopoYaml,
} from "./totopo-yaml.js";
import { findTotopoYamlDir, getWorkspacesBaseDir, initWorkspaceDir } from "./workspace-identity.js";

// =========================================================================================================================================
// v2 helpers
// =========================================================================================================================================

interface V2Project {
    hashId: string;
    projectRoot: string;
    displayName: string;
    shadowPaths: string[];
}

function isV2ProjectDir(dirPath: string): boolean {
    return existsSync(join(dirPath, "meta.json"));
}

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

function readV2ShadowPaths(dirPath: string): string[] {
    try {
        const raw = JSON.parse(readFileSync(join(dirPath, "settings.json"), "utf8"));
        if (Array.isArray(raw.shadowPaths)) return raw.shadowPaths;
        return [];
    } catch {
        return [];
    }
}

function readV2YamlName(workspaceRoot: string): string | null {
    try {
        const raw = loadYaml(readFileSync(join(workspaceRoot, TOTOPO_YAML), "utf8"));
        if (typeof raw !== "object" || raw === null) return null;
        const obj = raw as Record<string, unknown>;
        return typeof obj.name === "string" ? obj.name : null;
    } catch {
        return null;
    }
}

function detectV2Projects(): V2Project[] {
    const baseDir = getWorkspacesBaseDir();
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

function generateUniqueWorkspaceId(displayName: string, existingIds: Set<string>): string {
    let candidate = slugifyForWorkspaceId(displayName);
    const err = validateWorkspaceId(candidate);
    if (err) candidate = "migrated-workspace";

    if (!existingIds.has(candidate)) return candidate;

    for (let i = 2; i <= 99; i++) {
        const suffixed = `${candidate}-${i}`;
        if (!existingIds.has(suffixed)) return suffixed;
    }

    return `${candidate}-${Date.now().toString(36).slice(-4)}`;
}

function migrateSingleV2Workspace(v2: V2Project, existingIds: Set<string>): string | null {
    if (!existsSync(v2.projectRoot)) {
        log.warn(`Skipping "${v2.displayName}" - directory no longer exists: ${v2.projectRoot}`);
        return null;
    }

    let yaml: TotopoYamlConfig | null = null;
    try {
        yaml = readTotopoYaml(v2.projectRoot);
    } catch {
        // Invalid or v2-era totopo.yaml - will be overwritten below
    }

    let workspaceId: string;

    if (yaml) {
        workspaceId = yaml.workspace_id;
    } else {
        const v2Name = readV2YamlName(v2.projectRoot);

        workspaceId = generateUniqueWorkspaceId(v2.displayName, existingIds);
        yaml = buildDefaultTotopoYaml(workspaceId, v2Name ?? v2.displayName);

        if (v2.shadowPaths.length > 0) {
            yaml.shadow_paths = [...new Set([...(yaml.shadow_paths ?? []), ...v2.shadowPaths])];
        }

        writeTotopoYaml(v2.projectRoot, yaml);
        log.info(`Created totopo.yaml for "${v2.displayName}" (workspace_id: ${workspaceId})`);
    }

    const newDir = join(getWorkspacesBaseDir(), workspaceId);
    initWorkspaceDir(workspaceId, v2.projectRoot);

    const oldAgents = join(getWorkspacesBaseDir(), v2.hashId, AGENTS_DIR);
    const newAgents = join(newDir, AGENTS_DIR);
    if (existsSync(oldAgents)) {
        try {
            cpSync(oldAgents, newAgents, { recursive: true, force: true });
        } catch {
            log.warn(`Could not copy agent memory for "${v2.displayName}"`);
        }
    }

    const oldShadows = join(getWorkspacesBaseDir(), v2.hashId, SHADOWS_DIR);
    const newShadows = join(newDir, SHADOWS_DIR);
    if (existsSync(oldShadows)) {
        try {
            cpSync(oldShadows, newShadows, { recursive: true, force: true });
        } catch {
            log.warn(`Could not copy shadow data for "${v2.displayName}"`);
        }
    }

    safeRmSync(join(getWorkspacesBaseDir(), v2.hashId), { recursive: true, force: true });

    existingIds.add(workspaceId);
    return workspaceId;
}

// =========================================================================================================================================
// Migration steps - each is idempotent and checks if needed before acting
// =========================================================================================================================================

/**
 * v3-rc-1/rc-2 → latest: Rename ~/.totopo/projects/ → ~/.totopo/workspaces/.
 * Stops running containers first because they have bind mounts into the old path.
 */
function migrateProjectsDir(): void {
    const oldDir = join(homedir(), TOTOPO_DIR, PROJECTS_DIR);
    const newDir = join(homedir(), TOTOPO_DIR, WORKSPACES_DIR);

    if (!existsSync(oldDir)) return;

    const entries = readdirSync(oldDir);
    if (entries.length === 0) {
        safeRmSync(oldDir, { recursive: true });
        return;
    }

    const psResult = spawnSync("docker", ["ps", "--filter", `name=${CONTAINER_NAME_PREFIX}`, "--format", "{{.Names}}"], {
        encoding: "utf8",
        stdio: "pipe",
    });
    const projectContainerNames = new Set(entries.map((e) => `${CONTAINER_NAME_PREFIX}${e}`));
    const running = (psResult.stdout ?? "")
        .trim()
        .split("\n")
        .filter((n) => projectContainerNames.has(n));

    if (running.length > 0) {
        log.info(`Stopping ${running.length} running container(s) for directory migration...`);
        for (const name of running) {
            spawnSync("docker", ["stop", name], { stdio: "pipe" });
            spawnSync("docker", ["rm", name], { stdio: "pipe" });
        }
        log.info("Containers stopped - they will be recreated on next session.");
    }

    mkdirSync(newDir, { recursive: true });

    let moved = 0;
    for (const entry of entries) {
        const src = join(oldDir, entry);
        const dest = join(newDir, entry);
        if (existsSync(dest)) continue; // already migrated, skip
        renameSync(src, dest);
        moved++;
    }

    safeRmSync(oldDir, { recursive: true });

    if (moved > 0) {
        log.success("Migrated ~/.totopo/projects/ to ~/.totopo/workspaces/");
    }
}

/**
 * v2.x → latest: Convert hash-based workspace dirs to workspace_id dirs.
 * Detects meta.json in ~/.totopo/workspaces/, generates workspace_id, writes totopo.yaml,
 * copies agents/ and shadows/, removes old hash directory.
 */
function migrateV2Workspaces(): void {
    const v2Projects = detectV2Projects();
    if (v2Projects.length === 0) return;

    log.info(`Found ${v2Projects.length} v2 workspace(s) to migrate.`);

    const baseDir = getWorkspacesBaseDir();
    const existingIds = new Set<string>();
    if (existsSync(baseDir)) {
        for (const entry of readdirSync(baseDir)) {
            if (existsSync(join(baseDir, entry, LOCK_FILE))) {
                existingIds.add(entry);
            }
        }
    }

    let migrated = 0;
    for (const v2 of v2Projects) {
        const result = migrateSingleV2Workspace(v2, existingIds);
        if (result) {
            log.success(`Migrated "${v2.displayName}" to workspace_id: ${result}`);
            migrated++;
        }
    }

    if (migrated > 0) {
        log.info(`Migration complete - ${migrated} workspace(s) migrated.`);
    }
}

/**
 * v3-rc-1/rc-2 → latest: Rename project_id → workspace_id in totopo.yaml.
 * Only migrates the current workspace (found by walking up from cwd).
 * Other workspaces are migrated when totopo is invoked from their directory.
 */
function migrateTotopoYaml(cwd: string): void {
    const dir = findTotopoYamlDir(cwd);
    if (!dir) return;

    const filePath = join(dir, TOTOPO_YAML);
    try {
        const content = readFileSync(filePath, "utf8");
        const raw = loadYaml(content);
        if (typeof raw !== "object" || raw === null) return;
        const obj = raw as Record<string, unknown>;
        if (!("project_id" in obj) || "workspace_id" in obj) return;

        // Replace key in raw text to preserve comments and formatting
        writeFileSync(filePath, content.replace(/^project_id:/m, "workspace_id:"));
        log.success("Migrated totopo.yaml: project_id renamed to workspace_id");
    } catch {
        // Unreadable or invalid yaml - skip, will fail later with a clear error
    }
}

/**
 * v2.x → latest: Remove legacy ~/.totopo/.env global key file.
 * API keys are now declared per-workspace via env_file in totopo.yaml.
 */
function migrateGlobalEnv(): void {
    const globalEnv = join(homedir(), TOTOPO_DIR, GLOBAL_ENV_FILE);
    if (!existsSync(globalEnv)) return;

    log.warn(
        "Removed legacy ~/.totopo/.env - API keys are now declared per-workspace via env_file in totopo.yaml.\n" +
            "  Set env_file in totopo.yaml to point to an env file in your workspace.",
    );
    safeRmSync(globalEnv);
}

// =========================================================================================================================================
// Migration registry
// =========================================================================================================================================

interface Migration {
    from: string;
    description: string;
    run: (cwd: string) => void;
}

/**
 * v3-rc-6 and earlier: Upgrade .lock files from positional line format to key=value format.
 * Detects old format by absence of "=" on the first line. Idempotent — skips already-upgraded files.
 */
function migrateLockFileFormat(): void {
    const baseDir = getWorkspacesBaseDir();
    if (!existsSync(baseDir)) return;

    for (const entry of readdirSync(baseDir)) {
        const lockPath = join(baseDir, entry, LOCK_FILE);
        try {
            const lines = readFileSync(lockPath, "utf8")
                .trimEnd()
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
            const [firstLine, secondLine] = lines;
            if (!firstLine || firstLine.includes("=")) continue; // empty or already new format
            const activeProfile = secondLine ?? "default";
            writeFileSync(lockPath, `yaml=${firstLine}\nprofile=${activeProfile}\nlast-cli-update=\n`);
        } catch {
            // unreadable -- skip, will surface as a broken workspace elsewhere
        }
    }
}

// Order matters: migrateProjectsDir must run before migrateV2Workspaces because
// step 2 scans ~/.totopo/workspaces/ which only exists after step 1 renames projects/.
// Steps 3 and 4 are independent of each other and of steps 1-2.
// migrateLockFileFormat must run last so all workspace dirs are in their final location first.
const MIGRATIONS: Migration[] = [
    { from: "v3-rc-1/rc-2", description: "Rename ~/.totopo/projects/ to ~/.totopo/workspaces/", run: migrateProjectsDir },
    { from: "v2.x", description: "Hash-based dirs to workspace_id-based dirs + totopo.yaml", run: migrateV2Workspaces },
    { from: "v3-rc-1/rc-2", description: "Rename project_id to workspace_id in totopo.yaml", run: migrateTotopoYaml },
    { from: "v2.x", description: "Remove legacy ~/.totopo/.env global key file", run: migrateGlobalEnv },
    { from: "v3-rc-6", description: "Upgrade .lock files from positional to key=value format", run: migrateLockFileFormat },
];

/** Run all migrations in order. Called early in bin/totopo.js startup. */
export function runMigration(cwd: string): void {
    for (const migration of MIGRATIONS) {
        migration.run(cwd);
    }
}
