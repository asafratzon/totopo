// =========================================================================================================================================
// src/lib/migrate-to-latest.ts - Detect and migrate legacy ~/.totopo/ structures
//
// Legacy version layouts and what each migration converts to latest:
//
//   v2.x (~/.totopo/projects/<sha256-hash>/)
//     Each workspace stored as: meta.json, settings.json, agents/, shadows/
//     Global API keys in ~/.totopo/.env
//     Optional totopo.yaml with name field (removed in v3.3)
//
//   v3-rc-1/rc-2 (~/.totopo/workspaces/<workspace_id>/)
//     Renamed projects/ to workspaces/, hash dirs to workspace_id dirs
//     totopo.yaml required, used project_id key
//     Per-workspace env_file replaces global .env
//
//   v3-rc-3+ (latest)
//     project_id renamed to workspace_id in totopo.yaml
//
//   v3.2.1 and earlier
//     totopo.yaml had schema_version field and yaml-language-server header (both redundant)
//
// All migrations are idempotent - each checks if needed and skips if not.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { confirm, isCancel, log, note } from "@clack/prompts";
import { load as loadYaml } from "js-yaml";
import {
    AGENTS_DIR,
    GIT_MODE,
    LABEL_BUILD_HASH,
    LOCK_FILE,
    PROFILE,
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
import { findTotopoYamlDir, getWorkspacesBaseDir, initWorkspaceDir, LOCK_KEYS } from "./workspace-identity.js";

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
        workspaceId = generateUniqueWorkspaceId(v2.displayName, existingIds);
        yaml = buildDefaultTotopoYaml(workspaceId);

        if (v2.shadowPaths.length > 0) {
            yaml.shadow_paths = [...new Set([...(yaml.shadow_paths ?? []), ...v2.shadowPaths])];
        }

        writeTotopoYaml(v2.projectRoot, yaml, { includeExtendedTemplate: true });
        log.info(`Created totopo.yaml for "${v2.displayName}" (workspace_id: ${workspaceId})`);
    }

    const newDir = join(getWorkspacesBaseDir(), workspaceId);
    initWorkspaceDir(workspaceId, v2.projectRoot);

    const oldAgents = join(getWorkspacesBaseDir(), v2.hashId, "agents");
    const newAgents = join(newDir, AGENTS_DIR);
    if (existsSync(oldAgents)) {
        try {
            cpSync(oldAgents, newAgents, { recursive: true, force: true });
        } catch {
            log.warn(`Could not copy agent memory for "${v2.displayName}"`);
        }
    }

    const oldShadows = join(getWorkspacesBaseDir(), v2.hashId, "shadows");
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

const V1_WORKSPACE_FILES = ["Dockerfile", "README.md", "post-start.mjs", "settings.json"] as const;

function getCandidateWorkspaceRoots(cwd: string): string[] {
    const roots = [cwd];
    const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
    });

    const root = (gitRoot.stdout ?? "").trim();
    if (gitRoot.status === 0 && root.length > 0 && root !== cwd) roots.push(root);

    return roots;
}

function detectLegacyV1WorkspaceDir(cwd: string): string | null {
    for (const root of getCandidateWorkspaceRoots(cwd)) {
        const legacyDir = join(root, TOTOPO_DIR);
        try {
            if (!statSync(legacyDir).isDirectory()) continue;
        } catch {
            continue;
        }

        const hasLegacyFile = V1_WORKSPACE_FILES.some((file) => existsSync(join(legacyDir, file)));
        if (hasLegacyFile) return legacyDir;
    }

    return null;
}

/**
 * v1.0.3 -> latest: Remove workspace-local .totopo/ artifacts.
 * These files are now bundled in the totopo CLI package.
 */
async function migrateLegacyV1WorkspaceArtifacts(cwd: string, requireConfirmation = true): Promise<void> {
    const legacyDir = detectLegacyV1WorkspaceDir(cwd);
    if (!legacyDir) return;

    log.warn(
        `Found legacy v1 totopo artifacts at ${legacyDir}.\n` +
            "  Latest totopo bundles these files in the binary, so this directory can be safely removed.",
    );

    if (requireConfirmation) {
        const shouldRemove = await confirm({ message: "Remove legacy .totopo/ directory?", initialValue: true });
        if (isCancel(shouldRemove) || !shouldRemove) {
            log.info("Kept legacy .totopo/ directory.");
            return;
        }
    }

    safeRmSync(legacyDir, { recursive: true, force: true });
    log.success("Removed legacy .totopo/ directory.");
}

/**
 * v3-rc-1/rc-2 → latest: Rename ~/.totopo/projects/ → ~/.totopo/workspaces/.
 * Stops running containers first because they have bind mounts into the old path.
 */
function migrateProjectsDir(): void {
    const oldDir = join(homedir(), ".totopo", "projects");
    const newDir = join(homedir(), TOTOPO_DIR, WORKSPACES_DIR);

    if (!existsSync(oldDir)) return;

    const entries = readdirSync(oldDir);
    if (entries.length === 0) {
        safeRmSync(oldDir, { recursive: true });
        return;
    }

    const psResult = spawnSync("docker", ["ps", "--filter", "name=totopo-", "--format", "{{.Names}}"], {
        encoding: "utf8",
        stdio: "pipe",
    });
    const projectContainerNames = new Set(entries.map((e) => `totopo-${e}`));
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
    const globalEnv = join(homedir(), ".totopo", ".env");
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
    run: () => void | Promise<void>;
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
            const activeProfile = secondLine ?? PROFILE.default;
            writeFileSync(lockPath, `${LOCK_KEYS.workspaceRoot}=${firstLine}\n${LOCK_KEYS.activeProfile}=${activeProfile}\n`);
        } catch {
            // unreadable -- skip, will surface as a broken workspace elsewhere
        }
    }
}

/**
 * v3-rc-8 and earlier: Rename the "yaml" key to "root" in .lock files.
 * The "yaml" key name was misleading — it holds the workspace root path, not YAML content.
 * Detects old format by presence of a line starting with "yaml=". Idempotent.
 */
function migrateLockKeyYamlToRoot(): void {
    const baseDir = getWorkspacesBaseDir();
    if (!existsSync(baseDir)) return;

    for (const entry of readdirSync(baseDir)) {
        const lockPath = join(baseDir, entry, LOCK_FILE);
        try {
            const content = readFileSync(lockPath, "utf8");
            if (!content.includes("yaml=")) continue;
            writeFileSync(lockPath, content.replace(/^yaml=/m, `${LOCK_KEYS.workspaceRoot}=`));
        } catch {
            // unreadable -- skip, will surface as a broken workspace elsewhere
        }
    }
}

/**
 * v3.1.0 and earlier: Remove the "last-cli-update" key from .lock files.
 * CLI update timestamps are now managed inside the container via /home/devuser/.ai-cli-updated.
 * Detects old format by presence of "last-cli-update=" in the file content. Idempotent.
 */
function migrateRemoveLastCliUpdate(): void {
    const baseDir = getWorkspacesBaseDir();
    if (!existsSync(baseDir)) return;

    for (const entry of readdirSync(baseDir)) {
        const lockPath = join(baseDir, entry, LOCK_FILE);
        try {
            const content = readFileSync(lockPath, "utf8");
            if (!content.includes("last-cli-update=")) continue;
            const filtered = content
                .split("\n")
                .filter((line) => !line.startsWith("last-cli-update="))
                .join("\n");
            writeFileSync(lockPath, filtered);
        } catch {
            // unreadable -- skip, will surface as a broken workspace elsewhere
        }
    }
}

/**
 * Pre-v3.4.0: Add the git_mode=local field to .lock files. Local is the default, so this
 * is a cosmetic write that makes the field visible on disk; runtime behavior is unchanged
 * for existing workspaces. Idempotent - skips files that already have the field. Prints a
 * one-time clack note() when any workspace was newly migrated so users discover the new
 * feature. Returns the count for testing purposes; the registered Migration entry ignores it.
 */
export function migrateAddGitMode(): number {
    const baseDir = getWorkspacesBaseDir();
    if (!existsSync(baseDir)) return 0;

    let migrated = 0;
    for (const entry of readdirSync(baseDir)) {
        const lockPath = join(baseDir, entry, LOCK_FILE);
        try {
            const content = readFileSync(lockPath, "utf8");
            if (content.includes(`${LOCK_KEYS.gitMode}=`)) continue;
            const trimmed = content.endsWith("\n") ? content : `${content}\n`;
            writeFileSync(lockPath, `${trimmed}${LOCK_KEYS.gitMode}=${GIT_MODE.local}\n`);
            migrated++;
        } catch {
            // unreadable -- skip, will surface as a broken workspace elsewhere
        }
    }

    if (migrated > 0) {
        note(
            `totopo v3.4.0 introduces git modes for workspaces.\nDefault is 'local' (previous behavior — local commits allowed, remote blocked).\nTwo opt-in modes are available: 'strict' (read-only, all mutations blocked) and 'unrestricted' (no totopo-enforced restrictions).\nSwitch via the totopo menu > Manage Workspace > Git mode.`,
            "Git modes",
        );
    }
    return migrated;
}

/**
 * Pre-v3.9.0: Add the audio=false field to .lock files. False is the default, so this is a
 * cosmetic write that makes the field visible on disk; runtime behavior is unchanged for
 * existing workspaces (microphone bridging stays off until explicitly enabled). Idempotent -
 * skips files that already have the field. Prints a one-time clack note() when any workspace
 * was newly migrated so users discover the new feature. Returns the count for testing purposes;
 * the registered Migration entry ignores it.
 */
export function migrateAddAudio(): number {
    const baseDir = getWorkspacesBaseDir();
    if (!existsSync(baseDir)) return 0;

    let migrated = 0;
    for (const entry of readdirSync(baseDir)) {
        const lockPath = join(baseDir, entry, LOCK_FILE);
        try {
            const content = readFileSync(lockPath, "utf8");
            if (content.includes(`${LOCK_KEYS.audio}=`)) continue;
            const trimmed = content.endsWith("\n") ? content : `${content}\n`;
            writeFileSync(lockPath, `${trimmed}${LOCK_KEYS.audio}=false\n`);
            migrated++;
        } catch {
            // unreadable -- skip, will surface as a broken workspace elsewhere
        }
    }

    if (migrated > 0) {
        note(
            `totopo v3.9.0 adds opt-in microphone support for Claude Code's /voice.\nEnable it per workspace via the totopo menu > Manage Workspace > Voice / audio.\nOn macOS totopo can install and run the host audio bridge for you; on Linux/Windows you point it at your own PulseAudio server.`,
            "Voice / audio",
        );
    }
    return migrated;
}

/**
 * v3.2.1 and earlier: Remove deprecated fields from totopo.yaml.
 * - schema_version: redundant, totopo validates with the bundled JSON schema at runtime
 * - yaml-language-server header: created stale versioned URLs
 * - name: redundant, workspace_id serves as both identifier and display name
 * Only migrates the current workspace (found by walking up from cwd).
 */
function migrateRemoveDeprecatedYamlFields(cwd: string): void {
    const dir = findTotopoYamlDir(cwd);
    if (!dir) return;

    const filePath = join(dir, TOTOPO_YAML);
    try {
        const content = readFileSync(filePath, "utf8");

        const hasSchemaVersion = /^schema_version:\s/m.test(content);
        const hasYamlLsHeader = content.includes("# yaml-language-server:");
        const hasName = /^name:\s/m.test(content);
        if (!hasSchemaVersion && !hasYamlLsHeader && !hasName) return;

        const raw = loadYaml(content);
        if (typeof raw !== "object" || raw === null) return;
        const obj = raw as Record<string, unknown>;

        delete obj.schema_version;
        delete obj.name;

        try {
            writeTotopoYaml(dir, obj as unknown as TotopoYamlConfig);
            readTotopoYaml(dir);
        } catch {
            writeFileSync(filePath, content);
            return;
        }

        const removed: string[] = [];
        if (hasSchemaVersion) removed.push("schema_version");
        if (hasYamlLsHeader) removed.push("yaml-language-server header");
        if (hasName) removed.push("name");
        log.success(`Migrated totopo.yaml: removed ${removed.join(", ")}`);
    } catch {
        // Unreadable or invalid yaml - skip
    }
}

// Order matters: migrateProjectsDir must run before migrateV2Workspaces because
// step 2 scans ~/.totopo/workspaces/ which only exists after step 1 renames projects/.
// Steps 3 and 4 are independent of each other and of steps 1-2.
// migrateLockFileFormat and migrateLockKeyYamlToRoot must run last so all workspace
// dirs are in their final location first. migrateLockKeyYamlToRoot runs after
// migrateLockFileFormat so the latter always writes "root=" for freshly upgraded files.
function buildMigrations(cwd: string, skipAnyConfirmations: boolean): Migration[] {
    return [
        {
            from: "v1.0.3",
            description: "Remove workspace-local .totopo/ artifacts",
            run: () => migrateLegacyV1WorkspaceArtifacts(cwd, !skipAnyConfirmations),
        },
        { from: "v3-rc-1/rc-2", description: "Rename ~/.totopo/projects/ to ~/.totopo/workspaces/", run: migrateProjectsDir },
        { from: "v2.x", description: "Hash-based dirs to workspace_id-based dirs + totopo.yaml", run: migrateV2Workspaces },
        { from: "v3-rc-1/rc-2", description: "Rename project_id to workspace_id in totopo.yaml", run: () => migrateTotopoYaml(cwd) },
        { from: "v2.x", description: "Remove legacy ~/.totopo/.env global key file", run: migrateGlobalEnv },
        { from: "v3-rc-6", description: "Upgrade .lock files from positional to key=value format", run: migrateLockFileFormat },
        { from: "v3-rc-8", description: "Rename 'yaml' key to 'root' in .lock files", run: migrateLockKeyYamlToRoot },
        { from: "v3.1.0", description: "Remove last-cli-update key from .lock files", run: migrateRemoveLastCliUpdate },
        {
            from: "v3.2.1",
            description: "Remove deprecated fields (schema_version, name, yaml-language-server) from totopo.yaml",
            run: () => migrateRemoveDeprecatedYamlFields(cwd),
        },
        { from: "v3.4.0", description: "Add git_mode=local to .lock files (preserves pre-v3.4.0 behavior)", run: migrateAddGitMode },
        { from: "v3.9.0", description: "Add audio=false to .lock files (preserves pre-v3.9.0 behavior)", run: migrateAddAudio },
    ];
}

/** Run all migrations in order. Called early in bin/totopo.js startup. */
export async function runMigration(cwd: string, skipAnyConfirmations = true): Promise<void> {
    for (const migration of buildMigrations(cwd, skipAnyConfirmations)) {
        await migration.run();
    }
}

// =========================================================================================================================================
// Image staleness detection
//
// Called at session start; returns true if the running container's image is older than the current
// package and needs a rebuild prompt.
//
// Mechanism: at build time, dockerfile-builder.ts stamps every image with a totopo.build-hash label
// that fingerprints the assembled Dockerfile + every baked template file. At session start we
// recompute the expected hash from current package sources and compare. Any change to
// templates/Dockerfile, the active profile hook, or any baked template file produces a different
// hash -> rebuild prompt fires.
//
// When shipping a new bake-time artifact:
//   - Editing an existing template file or the Dockerfile -> auto-detected. No action.
//   - Adding a NEW templated COPY -> add the filename to BAKED_TEMPLATE_FILES in
//     dockerfile-builder.ts. The unit test in tests/dockerfile-builder.test.ts will fail until
//     you do.
//
// Cosmetic Dockerfile edits (comment-only, whitespace) DO trigger a rebuild for users on prior
// images. This is intentional: the Dockerfile and template files are rarely edited, so any change
// is treated as meaningful. The release skill warns when a release contains diffs to these files
// that look cosmetic, so the author can decide whether the rebuild cost is worth it.
// =========================================================================================================================================

/** Returns true if the container's stamped totopo.build-hash label does not match the expected hash. */
export function isImageStale(containerName: string, expectedBuildHash: string): boolean {
    const result = spawnSync("docker", ["inspect", "--format", `{{ index .Config.Labels "${LABEL_BUILD_HASH}" }}`, containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (result.status !== 0) return true;
    return result.stdout.trim() !== expectedBuildHash;
}
