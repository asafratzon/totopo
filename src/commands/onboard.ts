// =========================================================================================================================================
// src/commands/onboard.ts - First-time workspace setup
// Creates totopo.yaml, registers the workspace, and returns WorkspaceContext (or null if cancelled).
// =========================================================================================================================================

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cancel, confirm, intro, isCancel, log, outro, select, text } from "@clack/prompts";
import { TOTOPO_YAML } from "../lib/constants.js";
import { safeRmSync } from "../lib/safe-rm.js";
import {
    buildDefaultTotopoYaml,
    readTotopoYaml,
    slugifyForWorkspaceId,
    type TotopoYamlConfig,
    validateWorkspaceId,
    writeTotopoYaml,
} from "../lib/totopo-yaml.js";
import type { WorkspaceContext } from "../lib/workspace-identity.js";
import {
    checkCollision,
    deriveContainerName,
    findOrphanWorkspaceDir,
    findTotopoYamlDir,
    getWorkspaceDir,
    initWorkspaceDir,
    readLockFile,
} from "../lib/workspace-identity.js";

/** Derive a unique workspace_id, appending -2, -3, etc. if the base collides with another workspace. */
function deriveUniqueWorkspaceId(baseId: string, workspaceRoot: string): string {
    if (checkCollision(baseId, workspaceRoot) === "ok") return baseId;
    for (let i = 2; i <= 99; i++) {
        const candidate = `${baseId}-${i}`;
        if (checkCollision(candidate, workspaceRoot) === "ok") return candidate;
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

export async function run(cwd: string): Promise<WorkspaceContext | null> {
    const toTildePath = (p: string) => (p.startsWith(homedir()) ? p.replace(homedir(), "~") : p);

    // --- Detect context ------------------------------------------------------------------------------------------------------------------
    const gitRoot = tryGetGitRoot(cwd);
    const searchRoot = gitRoot ?? cwd;
    const yamlDir = findTotopoYamlDir(searchRoot);

    // --- Intro ---------------------------------------------------------------------------------------------------------------------------
    process.stdout.write("\n");
    intro("totopo · new workspace");
    process.stdout.write("\n");

    let workspaceRoot: string;
    let yaml: TotopoYamlConfig;

    if (yamlDir) {
        // --- totopo.yaml found: read and validate ----------------------------------------------------------------------------------------
        let existing: TotopoYamlConfig | null;
        try {
            existing = readTotopoYaml(yamlDir);
        } catch (err) {
            log.error(`Found ${join(yamlDir, TOTOPO_YAML)} but it is invalid: ${err instanceof Error ? err.message : err}`);
            cancel("Setup cancelled.");
            return null;
        }
        if (!existing) {
            log.error(`Could not read ${join(yamlDir, TOTOPO_YAML)}.`);
            cancel("Setup cancelled.");
            return null;
        }

        workspaceRoot = yamlDir;
        yaml = existing;

        // Show welcome message
        if (yaml.name) {
            log.info(yaml.name);
            process.stdout.write("\n");
        }

        const ok = await confirm({ message: `Set up totopo for: ${toTildePath(workspaceRoot)}?` });
        if (isCancel(ok) || !ok) {
            cancel("Setup cancelled.");
            return null;
        }
    } else {
        // --- No totopo.yaml: create one interactively ------------------------------------------------------------------------------------

        // Choose workspace root
        const suggestedRoot = gitRoot ?? cwd;
        type RootOption = { value: string; label: string; hint?: string };
        const options: RootOption[] = [
            { value: suggestedRoot, label: toTildePath(suggestedRoot), hint: gitRoot ? "git root" : "current directory" },
        ];
        if (gitRoot !== null && gitRoot !== cwd) {
            options.push({ value: cwd, label: toTildePath(cwd), hint: "current directory" });
        }
        options.push({ value: "__custom__", label: "Enter a different path…" });

        const rootChoice = await select({ message: "Workspace root:", options });
        if (isCancel(rootChoice)) {
            cancel("Setup cancelled.");
            return null;
        }

        if (rootChoice === "__custom__") {
            const customPath = await text({
                message: "Workspace root path:",
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
            workspaceRoot = (customPath as string).trim();
        } else {
            workspaceRoot = rootChoice as string;
        }

        // Ask for workspace name (used as display name, also derives workspace_id)
        const defaultName = basename(workspaceRoot);
        const nameInput = await text({
            message: "Workspace name:",
            placeholder: defaultName,
            defaultValue: defaultName,
        });
        if (isCancel(nameInput)) {
            cancel("Setup cancelled.");
            return null;
        }
        const workspaceName = (nameInput as string).trim() || defaultName;

        // Derive workspace_id from name, auto-resolve collisions with numeric suffix
        const workspaceId = deriveUniqueWorkspaceId(slugifyForWorkspaceId(workspaceName), workspaceRoot);

        // Build and write totopo.yaml
        yaml = buildDefaultTotopoYaml(workspaceId, workspaceName);
        writeTotopoYaml(workspaceRoot, yaml);
        log.success(`Created ${toTildePath(join(workspaceRoot, TOTOPO_YAML))}`);
    }

    // --- Non-git warning -----------------------------------------------------------------------------------------------------------------
    const isNonGit = tryGetGitRoot(workspaceRoot) === null;
    if (isNonGit) {
        log.warn("No version control detected. Agent changes won't be tracked.");
        const ack = await confirm({ message: "Continue without git?" });
        if (isCancel(ack) || !ack) {
            cancel("Setup cancelled.");
            return null;
        }
    }

    // --- Collision / orphan check --------------------------------------------------------------------------------------------------------
    const workspaceId = yaml.workspace_id;
    const collision = checkCollision(workspaceId, workspaceRoot);

    if (collision === "collision") {
        const existingLock = readLockFile(workspaceId);
        log.error(
            `Workspace ID "${workspaceId}" is already used by another workspace:\n` +
                `  ${existingLock}\n\n` +
                `Choose a different workspace_id in totopo.yaml.`,
        );

        const newId = await text({
            message: "New workspace ID:",
            validate: (v) => {
                const id = (v ?? "").trim();
                const err = validateWorkspaceId(id);
                if (err) return err;
                const c = checkCollision(id, workspaceRoot);
                if (c === "collision") return `"${id}" is also taken`;
                return undefined;
            },
        });
        if (isCancel(newId)) {
            cancel("Setup cancelled.");
            return null;
        }

        yaml.workspace_id = (newId as string).trim();
        writeTotopoYaml(workspaceRoot, yaml);
        log.info(`Updated workspace_id to "${yaml.workspace_id}"`);
    } else {
        // Check for orphan (workspace_id changed in yaml but old dir still points here)
        const orphanId = findOrphanWorkspaceDir(workspaceRoot);
        if (orphanId && orphanId !== workspaceId) {
            log.warn(`Found orphaned workspace cache "${orphanId}" pointing to this workspace.`);
            const action = await select({
                message: "How to handle the orphaned cache?",
                options: [
                    { value: "realign", label: `Revert workspace_id to "${orphanId}"`, hint: "keeps existing cache" },
                    { value: "clean", label: `Use "${workspaceId}" (clean slate)`, hint: "deletes old cache" },
                ],
            });

            if (isCancel(action)) {
                cancel("Setup cancelled.");
                return null;
            }

            if (action === "realign") {
                yaml.workspace_id = orphanId;
                writeTotopoYaml(workspaceRoot, yaml);
                log.info(`Reverted workspace_id to "${orphanId}"`);
            } else {
                // Clean slate - remove orphaned dir
                safeRmSync(getWorkspaceDir(orphanId), { recursive: true, force: true });
                log.info(`Removed orphaned cache for "${orphanId}"`);
            }
        }
    }

    // --- Initialize workspace dir --------------------------------------------------------------------------------------------------------
    const finalId = yaml.workspace_id;
    initWorkspaceDir(finalId, workspaceRoot);

    log.success(`Config written to ${toTildePath(getWorkspaceDir(finalId))}`);
    outro("Setup complete.");

    return {
        workspaceId: finalId,
        workspaceRoot,
        containerName: deriveContainerName(finalId),
        workspaceDir: getWorkspaceDir(finalId),
        displayName: yaml.name || finalId,
    };
}
