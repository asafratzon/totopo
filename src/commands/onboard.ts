// =========================================================================================================================================
// src/commands/onboard.ts - First-time project setup
// Creates totopo.yaml, registers the project, and returns ProjectContext (or null if cancelled).
// =========================================================================================================================================

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cancel, confirm, intro, isCancel, log, outro, select, text } from "@clack/prompts";
import type { ProjectContext } from "../lib/project-identity.js";
import {
    checkCollision,
    deriveContainerName,
    findOrphanProjectDir,
    findTotopoYamlDir,
    getProjectDir,
    initProjectDir,
    readLockFile,
} from "../lib/project-identity.js";
import {
    buildDefaultTotopoYaml,
    readTotopoYaml,
    slugifyForProjectId,
    type TotopoYamlConfig,
    validateProjectId,
    writeTotopoYaml,
} from "../lib/totopo-yaml.js";

/** Derive a unique project_id, appending -2, -3, etc. if the base collides with another project. */
function deriveUniqueProjectId(baseId: string, projectRoot: string): string {
    if (checkCollision(baseId, projectRoot) === "ok") return baseId;
    for (let i = 2; i <= 99; i++) {
        const candidate = `${baseId}-${i}`;
        if (checkCollision(candidate, projectRoot) === "ok") return candidate;
    }
    return baseId; // fallback (collision handled later in onboarding)
}

function tryGetGitRoot(cwd: string): string | null {
    try {
        return execSync("git rev-parse --show-toplevel", { encoding: "utf8", cwd, stdio: "pipe" }).trim();
    } catch {
        return null;
    }
}

export async function run(cwd: string): Promise<ProjectContext | null> {
    const toTildePath = (p: string) => (p.startsWith(homedir()) ? p.replace(homedir(), "~") : p);

    // --- Detect context ------------------------------------------------------------------------------------------------------------------
    const gitRoot = tryGetGitRoot(cwd);
    const searchRoot = gitRoot ?? cwd;
    const yamlDir = findTotopoYamlDir(searchRoot);

    // --- Intro ---------------------------------------------------------------------------------------------------------------------------
    process.stdout.write("\n");
    intro("totopo · new project");
    process.stdout.write("\n");

    let projectRoot: string;
    let yaml: TotopoYamlConfig;

    if (yamlDir) {
        // --- totopo.yaml found: read and validate ----------------------------------------------------------------------------------------
        let existing: TotopoYamlConfig | null;
        try {
            existing = readTotopoYaml(yamlDir);
        } catch (err) {
            log.error(`Found ${join(yamlDir, "totopo.yaml")} but it is invalid: ${err instanceof Error ? err.message : err}`);
            cancel("Setup cancelled.");
            return null;
        }
        if (!existing) {
            log.error(`Could not read ${join(yamlDir, "totopo.yaml")}.`);
            cancel("Setup cancelled.");
            return null;
        }

        projectRoot = yamlDir;
        yaml = existing;

        // Show welcome message
        if (yaml.name) {
            log.info(yaml.name);
            process.stdout.write("\n");
        }

        const ok = await confirm({ message: `Set up totopo for: ${toTildePath(projectRoot)}?` });
        if (isCancel(ok) || !ok) {
            cancel("Setup cancelled.");
            return null;
        }
    } else {
        // --- No totopo.yaml: create one interactively ------------------------------------------------------------------------------------

        // Choose project root
        const suggestedRoot = gitRoot ?? cwd;
        type RootOption = { value: string; label: string; hint?: string };
        const options: RootOption[] = [
            { value: suggestedRoot, label: toTildePath(suggestedRoot), hint: gitRoot ? "git root" : "current directory" },
        ];
        if (gitRoot !== null && gitRoot !== cwd) {
            options.push({ value: cwd, label: toTildePath(cwd), hint: "current directory" });
        }
        options.push({ value: "__custom__", label: "Enter a different path…" });

        const rootChoice = await select({ message: "Project root:", options });
        if (isCancel(rootChoice)) {
            cancel("Setup cancelled.");
            return null;
        }

        if (rootChoice === "__custom__") {
            const customPath = await text({
                message: "Project root path:",
                placeholder: `e.g. ${suggestedRoot}`,
                validate: (v) => {
                    const p = (v ?? "").trim();
                    if (p.length === 0) return "Path cannot be empty";
                    if (!existsSync(p)) return `Directory not found: ${p}`;
                    return undefined;
                },
            });
            if (isCancel(customPath)) {
                cancel("Setup cancelled.");
                return null;
            }
            projectRoot = (customPath as string).trim();
        } else {
            projectRoot = rootChoice as string;
        }

        // Ask for project name (used as display name, also derives project_id)
        const defaultName = basename(projectRoot);
        const nameInput = await text({
            message: "Project name:",
            placeholder: defaultName,
            defaultValue: defaultName,
        });
        if (isCancel(nameInput)) {
            cancel("Setup cancelled.");
            return null;
        }
        const projectName = (nameInput as string).trim() || defaultName;

        // Derive project_id from name, auto-resolve collisions with numeric suffix
        const projectId = deriveUniqueProjectId(slugifyForProjectId(projectName), projectRoot);

        // Build and write totopo.yaml
        yaml = buildDefaultTotopoYaml(projectId, projectName);
        writeTotopoYaml(projectRoot, yaml);
        log.success(`Created ${toTildePath(join(projectRoot, "totopo.yaml"))}`);
    }

    // --- Non-git warning -----------------------------------------------------------------------------------------------------------------
    const isNonGit = tryGetGitRoot(projectRoot) === null;
    if (isNonGit) {
        log.warn("No version control detected. Agent changes won't be tracked.");
        const ack = await confirm({ message: "Continue without git?" });
        if (isCancel(ack) || !ack) {
            cancel("Setup cancelled.");
            return null;
        }
    }

    // --- Collision / orphan check --------------------------------------------------------------------------------------------------------
    const projectId = yaml.project_id;
    const collision = checkCollision(projectId, projectRoot);

    if (collision === "collision") {
        const existingLock = readLockFile(projectId);
        log.error(
            `Project ID "${projectId}" is already used by another project:\n` +
                `  ${existingLock}\n\n` +
                `Choose a different project_id in totopo.yaml.`,
        );

        const newId = await text({
            message: "New project ID:",
            validate: (v) => {
                const id = (v ?? "").trim();
                const err = validateProjectId(id);
                if (err) return err;
                const c = checkCollision(id, projectRoot);
                if (c === "collision") return `"${id}" is also taken`;
                return undefined;
            },
        });
        if (isCancel(newId)) {
            cancel("Setup cancelled.");
            return null;
        }

        yaml.project_id = (newId as string).trim();
        writeTotopoYaml(projectRoot, yaml);
        log.info(`Updated project_id to "${yaml.project_id}"`);
    } else {
        // Check for orphan (project_id changed in yaml but old dir still points here)
        const orphanId = findOrphanProjectDir(projectRoot);
        if (orphanId && orphanId !== projectId) {
            log.warn(`Found orphaned project cache "${orphanId}" pointing to this project.`);
            const action = await select({
                message: "How to handle the orphaned cache?",
                options: [
                    { value: "realign", label: `Revert project_id to "${orphanId}"`, hint: "keeps existing cache" },
                    { value: "clean", label: `Use "${projectId}" (clean slate)`, hint: "deletes old cache" },
                ],
            });

            if (isCancel(action)) {
                cancel("Setup cancelled.");
                return null;
            }

            if (action === "realign") {
                yaml.project_id = orphanId;
                writeTotopoYaml(projectRoot, yaml);
                log.info(`Reverted project_id to "${orphanId}"`);
            } else {
                // Clean slate - remove orphaned dir
                const { rmSync } = await import("node:fs");
                rmSync(getProjectDir(orphanId), { recursive: true, force: true });
                log.info(`Removed orphaned cache for "${orphanId}"`);
            }
        }
    }

    // --- Initialize project dir ----------------------------------------------------------------------------------------------------------
    const finalId = yaml.project_id;
    initProjectDir(finalId, projectRoot);

    log.success(`Config written to ${toTildePath(getProjectDir(finalId))}`);
    outro("Setup complete.");

    return {
        projectId: finalId,
        projectRoot,
        containerName: deriveContainerName(finalId),
        projectDir: getProjectDir(finalId),
        displayName: yaml.name || finalId,
    };
}
