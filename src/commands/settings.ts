// =========================================================================================================================================
// src/commands/settings.ts - Settings submenu: profiles, shadow paths
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { confirm, isCancel, log, multiselect, note, path, select, text } from "@clack/prompts";
import type { ProjectContext } from "../lib/project-identity.js";
import { readActiveProfile, writeActiveProfile } from "../lib/project-identity.js";
import { countPatternHits } from "../lib/shadows.js";
import { readTotopoYaml, writeTotopoYaml } from "../lib/totopo-yaml.js";

// --- Profile menu ------------------------------------------------------------------------------------------------------------------------
async function profileMenu(ctx: ProjectContext): Promise<void> {
    const yaml = readTotopoYaml(ctx.projectRoot);
    if (!yaml) {
        log.error("totopo.yaml not found or invalid.");
        return;
    }

    const profiles = yaml.profiles ?? {};
    const profileNames = Object.keys(profiles);

    if (profileNames.length === 0) {
        log.info("No profiles defined in totopo.yaml.");
        return;
    }

    const currentProfile = readActiveProfile(ctx.projectId) ?? "default";
    note(`Active profile: ${currentProfile}`, "Profiles");

    if (profileNames.length <= 1) {
        log.info("Only one profile defined. Add more profiles in totopo.yaml to switch between them.");
        return;
    }

    const profileOptions: { value: string; label: string; hint?: string }[] = profileNames.map((name) => {
        const opt: { value: string; label: string; hint?: string } = { value: name, label: name };
        if (name === currentProfile) opt.hint = "current";
        return opt;
    });
    profileOptions.push({ value: "back", label: "← Back" });

    const choice = await select({
        message: "Switch active profile:",
        options: profileOptions,
    });

    if (isCancel(choice) || choice === "back") return;

    const selected = choice as string;
    if (selected === currentProfile) {
        log.info("Already on that profile.");
        return;
    }

    writeActiveProfile(ctx.projectId, selected);
    log.success(`Switched to profile "${selected}"`);
    log.info("Profile change requires a container rebuild. Stop and rebuild to apply.");

    await promptStopContainer(ctx);
}

// --- Shadow paths menu -------------------------------------------------------------------------------------------------------------------
async function shadowPathsMenu(ctx: ProjectContext): Promise<void> {
    const yaml = readTotopoYaml(ctx.projectRoot);
    if (!yaml) {
        log.error("totopo.yaml not found or invalid.");
        return;
    }

    const patterns = yaml.shadow_paths ?? [];

    if (patterns.length > 0) {
        const lines = patterns.map((p) => {
            const hits = countPatternHits(p, ctx.projectRoot);
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

async function addShadowPattern(ctx: ProjectContext): Promise<void> {
    const yaml = readTotopoYaml(ctx.projectRoot);
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
        const hits = countPatternHits(pattern, ctx.projectRoot);
        patterns.push(pattern);
        log.info(`Added: ${pattern} (${hits} ${hits === 1 ? "match" : "matches"})`);
    } else {
        const selected = await path({
            message: "Path to shadow:",
            root: ctx.projectRoot,
            directory: true,
        });
        if (isCancel(selected)) return;

        const absPath = (selected as string).trim();
        const rel = relative(ctx.projectRoot, absPath);

        if (!rel || rel.startsWith("..")) {
            log.warn("Path must be inside the project directory. Skipped.");
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
    writeTotopoYaml(ctx.projectRoot, yaml);
    await promptStopContainer(ctx);
}

async function removeShadowPatterns(ctx: ProjectContext): Promise<void> {
    const yaml = readTotopoYaml(ctx.projectRoot);
    if (!yaml || !yaml.shadow_paths?.length) return;

    const toRemove = await multiselect({
        message: "Select patterns to remove:",
        options: yaml.shadow_paths.map((p) => ({ value: p, label: p })),
    });

    if (isCancel(toRemove)) return;

    const removeSet = new Set(toRemove as string[]);
    yaml.shadow_paths = yaml.shadow_paths.filter((p) => !removeSet.has(p));
    writeTotopoYaml(ctx.projectRoot, yaml);
    log.success(`Removed ${removeSet.size} pattern(s).`);
    await promptStopContainer(ctx);
}

// --- Prompt to stop container ------------------------------------------------------------------------------------------------------------
async function promptStopContainer(ctx: ProjectContext): Promise<void> {
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

    const stop = await confirm({ message: "Stop the running container so changes apply on next session?" });
    if (isCancel(stop) || !stop) {
        log.warn("Container still running with old config — it will be recreated on next session.");
        return;
    }

    log.step("Stopping container...");
    spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
    spawnSync("docker", ["rm", containerName], { stdio: "pipe" });
    log.info("Container removed. Open a new session to apply changes.");
}

// --- Settings submenu (main entry point) -------------------------------------------------------------------------------------------------
export async function run(ctx: ProjectContext): Promise<"back" | undefined> {
    while (true) {
        const options: { value: string; label: string; hint?: string }[] = [
            { value: "profiles", label: "Profiles", hint: "switch active Dockerfile profile" },
            { value: "shadow-paths", label: "Shadow paths", hint: "manage shadow patterns" },
            { value: "back", label: "← Back" },
        ];

        const action = await select({ message: "Settings:", options });

        if (isCancel(action) || action === "back") {
            return "back";
        }

        switch (action) {
            case "profiles":
                await profileMenu(ctx);
                break;
            case "shadow-paths":
                await shadowPathsMenu(ctx);
                break;
        }
    }
}
