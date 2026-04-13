// =========================================================================================================================================
// src/commands/workspace.ts - Manage Workspace submenu: shadow paths, rebuild, reset, stop, reset-image
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { cancel, confirm, isCancel, log, multiselect, note, outro, path, select, text } from "@clack/prompts";
import { countPatternHits } from "../lib/shadows.js";
import { buildDefaultTotopoYaml, readTotopoYaml, writeTotopoYaml } from "../lib/totopo-yaml.js";
import type { WorkspaceContext } from "../lib/workspace-identity.js";

// --- Shadow paths menu -------------------------------------------------------------------------------------------------------------------
async function shadowPathsMenu(ctx: WorkspaceContext): Promise<void> {
    const yaml = readTotopoYaml(ctx.workspaceRoot);
    if (!yaml) {
        log.error("totopo.yaml not found or invalid.");
        return;
    }

    const patterns = yaml.shadow_paths ?? [];

    if (patterns.length > 0) {
        const lines = patterns.map((p) => {
            const hits = countPatternHits(p, ctx.workspaceRoot);
            return `  ${p}  (${hits} ${hits === 1 ? "match" : "matches"})`;
        });
        note(lines.join("\n"), "Shadow patterns");
    } else {
        log.info("No shadow patterns configured.");
    }

    log.message(
        "Shadow patterns block the agent from seeing matching host paths —\n" +
            "the container gets an empty, isolated copy instead.\n" +
            "Supports gitignore-style patterns (e.g. node_modules, .env*).",
    );

    const options: { value: string; label: string }[] = [{ value: "add", label: "Add pattern or path" }];
    if (patterns.length > 0) {
        options.push({ value: "remove", label: "Remove patterns" });
    }
    options.push({ value: "back", label: "← Back" });

    const action = await select({ message: "Shadow paths:", options });

    if (isCancel(action) || action === "back") return;

    if (action === "add") {
        await addShadowPattern(ctx);
    } else if (action === "remove") {
        await removeShadowPatterns(ctx);
    }
}

async function addShadowPattern(ctx: WorkspaceContext): Promise<void> {
    const yaml = readTotopoYaml(ctx.workspaceRoot);
    if (!yaml) return;

    const patterns = [...(yaml.shadow_paths ?? [])];

    const typeChoice = await select({
        message: "Add:",
        options: [
            { value: "pattern", label: "Pattern", hint: "gitignore-style (e.g. .env*, *.log)" },
            { value: "path", label: "Specific path", hint: "pick a file or directory" },
        ],
    });

    if (isCancel(typeChoice)) return;

    if (typeChoice === "pattern") {
        const input = await text({
            message: "Pattern:",
            placeholder: "e.g. .env* or node_modules",
            validate: (v) => {
                const p = (v ?? "").trim();
                if (p.length === 0) return "Pattern cannot be empty";
                if (patterns.includes(p)) return "Pattern already exists";
                return undefined;
            },
        });
        if (isCancel(input)) return;

        const pattern = (input as string).trim();
        const hits = countPatternHits(pattern, ctx.workspaceRoot);
        patterns.push(pattern);
        log.info(`Added: ${pattern} (${hits} ${hits === 1 ? "match" : "matches"})`);
    } else {
        const selected = await path({
            message: "Path to shadow:",
            root: ctx.workspaceRoot,
            directory: true,
        });
        if (isCancel(selected)) return;

        const absPath = (selected as string).trim();
        const rel = relative(ctx.workspaceRoot, absPath);

        if (!rel || rel.startsWith("..")) {
            log.warn("Path must be inside the workspace directory. Skipped.");
            return;
        }

        if (patterns.includes(rel)) {
            log.warn(`"${rel}" is already in shadow patterns. Skipped.`);
            return;
        }

        patterns.push(rel);
        log.info(`Added: ${rel}`);
    }

    yaml.shadow_paths = patterns;
    writeTotopoYaml(ctx.workspaceRoot, yaml);
    await promptStopContainer(ctx);
}

async function removeShadowPatterns(ctx: WorkspaceContext): Promise<void> {
    const yaml = readTotopoYaml(ctx.workspaceRoot);
    if (!yaml?.shadow_paths?.length) return;

    const toRemove = await multiselect({
        message: "Select patterns to remove: (space to toggle, enter to confirm)",
        options: yaml.shadow_paths.map((p) => ({ value: p, label: p })),
    });

    if (isCancel(toRemove)) return;

    const removeSet = new Set(toRemove as string[]);
    yaml.shadow_paths = yaml.shadow_paths.filter((p) => !removeSet.has(p));
    writeTotopoYaml(ctx.workspaceRoot, yaml);
    log.success(`Removed ${removeSet.size} pattern(s).`);
    await promptStopContainer(ctx);
}

// --- Prompt to stop container ------------------------------------------------------------------------------------------------------------
async function promptStopContainer(ctx: WorkspaceContext): Promise<void> {
    const containerName = ctx.containerName;
    const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });
    const containerStatus = inspect.status === 0 ? inspect.stdout.trim() : null;

    if (containerStatus !== "running") {
        log.info("Changes will apply on next session.");
        return;
    }

    const shouldStop = await confirm({ message: "Stop the running container so changes apply on next session?" });
    if (isCancel(shouldStop) || !shouldStop) {
        log.warn("Container still running with old config — it will be recreated on next session.");
        return;
    }

    log.step("Stopping container...");
    spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
    spawnSync("docker", ["rm", containerName], { stdio: "pipe" });
    log.info("Container removed. Open a new session to apply changes.");
}

// --- Reset totopo.yaml -------------------------------------------------------------------------------------------------------------------
async function resetTotopoYaml(ctx: WorkspaceContext): Promise<void> {
    const yaml = readTotopoYaml(ctx.workspaceRoot);
    if (!yaml) {
        log.error("totopo.yaml not found or invalid.");
        return;
    }

    note(
        "This will reset totopo.yaml to factory defaults.\n" +
            "Your workspace_id will be preserved.\n" +
            "Shadow paths, profiles, and env_file will be reset to defaults.",
        "Reset totopo.yaml",
    );

    const confirmed = await confirm({ message: "Reset totopo.yaml to defaults?" });
    if (isCancel(confirmed) || !confirmed) return;

    const freshYaml = buildDefaultTotopoYaml(yaml.workspace_id);
    writeTotopoYaml(ctx.workspaceRoot, freshYaml);
    log.success("totopo.yaml reset to defaults.");

    await promptStopContainer(ctx);
}

// --- Manage Workspace submenu ------------------------------------------------------------------------------------------------------------
export async function run(ctx: WorkspaceContext): Promise<"back" | "rebuild" | "clean-rebuild" | undefined> {
    while (true) {
        const options: { value: string; label: string; hint?: string }[] = [
            { value: "shadow-paths", label: "Shadow paths", hint: "manage shadow patterns" },
            { value: "rebuild", label: "Rebuild container", hint: "force a fresh image build" },
            { value: "clean-rebuild", label: "Clean rebuild", hint: "fresh build, no cache" },
            { value: "reset", label: "Reset config", hint: "restore totopo.yaml to defaults" },
            { value: "back", label: "← Back" },
        ];

        const action = await select({ message: "Manage Workspace:", options });

        if (isCancel(action) || action === "back") {
            return "back";
        }

        switch (action) {
            case "shadow-paths":
                await shadowPathsMenu(ctx);
                break;
            case "rebuild":
                return "rebuild";
            case "clean-rebuild":
                return "clean-rebuild";
            case "reset":
                await resetTotopoYaml(ctx);
                break;
        }
    }
}

// --- Stop workspace container ------------------------------------------------------------------------------------------------------------
export async function stop(containerName: string): Promise<void> {
    const inspectResult = spawnSync("docker", ["inspect", "--type", "container", containerName], { encoding: "utf8" });

    if (inspectResult.status !== 0) {
        log.info(`Container ${containerName} is not running.`);
        return;
    }

    const confirmed = await confirm({ message: `Stop ${containerName}?` });
    if (isCancel(confirmed) || !confirmed) {
        cancel();
        return;
    }

    log.step(`Stopping ${containerName}...`);
    spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
    spawnSync("docker", ["rm", containerName], { stdio: "pipe" });

    outro(`${containerName} stopped and removed.`);
}

// --- Reset workspace image (stop container + remove image for fresh rebuild) -------------------------------------------------------------
export async function resetImage(containerName: string): Promise<void> {
    const inspectResult = spawnSync("docker", ["inspect", "--type", "container", containerName], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (inspectResult.status === 0) {
        log.step(`Stopping container ${containerName}...`);
        spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
        spawnSync("docker", ["rm", containerName], { stdio: "pipe" });
    }

    const imageResult = spawnSync("docker", ["images", "-q", containerName], { encoding: "utf8", stdio: "pipe" });
    if ((imageResult.stdout ?? "").trim().length > 0) {
        log.step(`Removing image ${containerName}...`);
        spawnSync("docker", ["rmi", containerName], { stdio: "pipe" });
    }

    log.info("Image removed — starting fresh build…");
}
