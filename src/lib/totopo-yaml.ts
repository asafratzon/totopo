// =========================================================================================================================================
// src/lib/totopo-yaml.ts - Read, write, and validate totopo.yaml
// =========================================================================================================================================

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AjvModule from "ajv";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";

export const TOTOPO_YAML = "totopo.yaml";

// --- Interfaces --------------------------------------------------------------------------------------------------------------------------

export interface ProfileConfig {
    dockerfile_hook?: string;
}

export interface TotopoYamlConfig {
    schema_version: 3;
    workspace_id: string;
    name?: string;
    env_file?: string;
    shadow_paths?: string[];
    profiles?: Record<string, ProfileConfig>;
}

// --- Validation --------------------------------------------------------------------------------------------------------------------------

// Must match the pattern, minLength, and maxLength in schema/totopo.schema.json
const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const WORKSPACE_ID_MIN = 2;
const WORKSPACE_ID_MAX = 48;

/** Returns error message if invalid, undefined if valid. Used for interactive input validation. */
export function validateWorkspaceId(id: string): string | undefined {
    if (id.length < WORKSPACE_ID_MIN) return `Workspace ID must be at least ${WORKSPACE_ID_MIN} characters`;
    if (id.length > WORKSPACE_ID_MAX) return `Workspace ID must be at most ${WORKSPACE_ID_MAX} characters`;
    if (!WORKSPACE_ID_PATTERN.test(id))
        return "Workspace ID must be lowercase alphanumeric with hyphens, not starting or ending with a hyphen";
    return undefined;
}

/** Slugify a directory name into a valid workspace_id candidate. */
export function slugifyForWorkspaceId(name: string): string {
    return (
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, WORKSPACE_ID_MAX) || "my-workspace"
    );
}

// --- Schema validation -------------------------------------------------------------------------------------------------------------------

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const schemaPath = join(packageRoot, "schema", "totopo.schema.json");

// ajv is a CJS module - under nodenext resolution the class is nested under .default
const Ajv = AjvModule.default ?? AjvModule;

let _validate: ReturnType<InstanceType<typeof Ajv>["compile"]> | null = null;

/** Lazily compile and cache the JSON Schema validator. */
function getValidator() {
    if (!_validate) {
        const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
        const ajv = new Ajv({ allErrors: true });
        _validate = ajv.compile(schema);
    }
    return _validate;
}

// --- Validation helpers ------------------------------------------------------------------------------------------------------------------

/** Format ajv validation errors into a human-readable string. */
// biome-ignore lint/suspicious/noExplicitAny: ajv error objects lack a stable exported type
function formatValidationErrors(errors: any[] | null | undefined): string {
    return (errors ?? [])
        .map((e) => {
            if (e.keyword === "additionalProperties" && e.params?.additionalProperty) {
                return `unknown property "${e.params.additionalProperty}"`;
            }
            const path = e.instancePath ? `"${e.instancePath.slice(1).replace(/\//g, ".")}"` : "";
            return path ? `${path} ${e.message}` : (e.message ?? "validation error");
        })
        .join("; ");
}

// --- Read --------------------------------------------------------------------------------------------------------------------------------

/** Read and validate totopo.yaml from a directory. Returns null if file missing. Throws if invalid. */
export function readTotopoYaml(dir: string): TotopoYamlConfig | null {
    const filePath = join(dir, TOTOPO_YAML);
    if (!existsSync(filePath)) return null;

    const raw = loadYaml(readFileSync(filePath, "utf8"));
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`${TOTOPO_YAML} is empty or not a valid YAML object`);
    }

    // Validate against JSON Schema
    const validate = getValidator();
    if (!validate(raw)) {
        throw new Error(`Invalid ${TOTOPO_YAML}: ${formatValidationErrors(validate.errors)}`);
    }

    return raw as TotopoYamlConfig;
}

// --- Write -------------------------------------------------------------------------------------------------------------------------------

// Every published version (rc or release) has a corresponding git tag created by pnpm rc / pnpm rc:promote.
// We rely on that tag existing so these URLs resolve correctly for every installed version.
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/asafratzon/totopo/v${version}`;

const YAML_HEADER = `# yaml-language-server: $schema=${GITHUB_RAW_BASE}/schema/totopo.schema.json
`;

// Inline comments injected before specific YAML keys (preceded by a blank line)
const YAML_COMMENTS: Partial<Record<keyof TotopoYamlConfig, string>> = {
    workspace_id:
        "# totopo workspace config — run 'npx totopo' from anywhere under this directory tree to start your dev container.\n" +
        "# Ask the AI agent inside the container to help you edit this file if needed.\n" +
        "# This file may be rewritten by totopo (repair, reset, settings changes). Custom comments will not be preserved.",
    shadow_paths: "# .gitignore-style patterns — agents see an empty, isolated copy instead of the real host data.",
    profiles:
        "# Dockerfile profiles — each adds on top of the totopo base image (Debian + Node.js + git + AI CLIs).\n" +
        `# Base Dockerfile: ${GITHUB_RAW_BASE}/templates/Dockerfile\n` +
        "# Switch profiles in the totopo settings menu, or ask the agent inside the container to help you add a new one.",
};

/** Write totopo.yaml to a directory with schema header and inline comments. */
export function writeTotopoYaml(dir: string, config: TotopoYamlConfig): void {
    const filePath = join(dir, TOTOPO_YAML);
    const yamlContent = dumpYaml(config, {
        lineWidth: -1,
        quotingType: '"',
        forceQuotes: false,
    });

    // Inject blank lines and comments before known keys
    const lines = yamlContent.split("\n");
    const output: string[] = [];
    for (const line of lines) {
        const key = line.match(/^(\w[\w_]*):/)?.[1] as keyof TotopoYamlConfig | undefined;
        const comment = key && YAML_COMMENTS[key];
        if (comment) {
            output.push(""); // blank line before section
            output.push(comment);
        }
        output.push(line);
    }

    const body = output.join("\n").trimEnd();
    writeFileSync(filePath, `${YAML_HEADER}${body}\n${PROFILES_FOOTER_COMMENT}\n`);
}

// --- Defaults ----------------------------------------------------------------------------------------------------------------------------

const DEFAULT_SHADOW_PATHS = ["node_modules", ".env*"];

const DEFAULT_PROFILE_HOOK = `# Installs Go and Java.
RUN apt-get update && apt-get install -y --no-install-recommends golang-go default-jdk-headless && rm -rf /var/lib/apt/lists/*
`;

const SLIM_PROFILE_HOOK = `# No extras — uses the base image only (Node.js + git + AI CLIs).
`;

const CUSTOM_PROFILE_HOOK = `# Add your own Dockerfile instructions below, or ask the agent inside the container to help.
# Install Bun:
#   RUN curl -fsSL https://bun.sh/install | bash
# Install Rust:
#   RUN curl -sSf https://sh.rustup.rs | sh -s -- -y
# Copy a local script into the image:
#   COPY my-tool.sh /usr/local/bin/my-tool.sh
`;

// Appended after the last profile to hint at adding more
const PROFILES_FOOTER_COMMENT = "  # Add more profiles here — or ask the agent inside the container to set one up for you.";

/** Create a default TotopoYamlConfig with sane defaults. */
export function buildDefaultTotopoYaml(workspaceId: string, name?: string): TotopoYamlConfig {
    const config: TotopoYamlConfig = {
        schema_version: 3,
        workspace_id: workspaceId,
        shadow_paths: [...DEFAULT_SHADOW_PATHS],
        profiles: {
            default: {
                dockerfile_hook: DEFAULT_PROFILE_HOOK,
            },
            slim: {
                dockerfile_hook: SLIM_PROFILE_HOOK,
            },
            custom: {
                dockerfile_hook: CUSTOM_PROFILE_HOOK,
            },
        },
    };
    if (name) config.name = name;

    // Reorder keys so name appears after workspace_id
    const { schema_version, workspace_id, name: n, ...rest } = config;
    const ordered: Record<string, unknown> = { schema_version, workspace_id };
    if (n !== undefined) ordered.name = n;
    return Object.assign(ordered, rest) as unknown as TotopoYamlConfig;
}

// --- Repair -------------------------------------------------------------------------------------------------------------------------------

/** Set of keys that TotopoYamlConfig allows (used to strip unknown fields). */
const KNOWN_KEYS = new Set<string>(["schema_version", "workspace_id", "name", "env_file", "shadow_paths", "profiles"]);

export interface RepairResult {
    repairedYaml: TotopoYamlConfig | null;
    message?: string;
    error?: string;
}

/**
 * Attempt to repair an invalid totopo.yaml on disk.
 * Strips unknown fields, fills missing required/optional fields from defaults,
 * and rewrites with canonical formatting. Returns a result describing what happened.
 */
export function repairTotopoYaml(dir: string): RepairResult {
    const filePath = join(dir, TOTOPO_YAML);
    if (!existsSync(filePath)) return { repairedYaml: null };

    try {
        const raw = loadYaml(readFileSync(filePath, "utf8"));
        if (typeof raw !== "object" || raw === null) return { repairedYaml: null };

        const obj = raw as Record<string, unknown>;
        const fixes: string[] = [];

        // Strip unknown fields
        for (const key of Object.keys(obj)) {
            if (!KNOWN_KEYS.has(key)) {
                delete obj[key];
                fixes.push(`removed unknown field "${key}"`);
            }
        }

        // Build defaults to fill from
        const fallbackId = slugifyForWorkspaceId(basename(dir));
        const defaults = buildDefaultTotopoYaml((obj.workspace_id as string) || fallbackId);

        // Fill missing required fields
        if (!("schema_version" in obj)) {
            obj.schema_version = defaults.schema_version;
            fixes.push("added missing schema_version");
        }
        if (!("workspace_id" in obj)) {
            obj.workspace_id = defaults.workspace_id;
            fixes.push(`added missing workspace_id ("${defaults.workspace_id}")`);
        }

        // Fill missing optional fields with defaults
        if (!("shadow_paths" in obj)) {
            obj.shadow_paths = defaults.shadow_paths;
            fixes.push("added default shadow_paths");
        }
        if (!("profiles" in obj)) {
            obj.profiles = defaults.profiles;
            fixes.push("added default profiles");
        }

        if (fixes.length === 0) return { repairedYaml: null };

        // Validate the repaired object
        const validate = getValidator();
        if (!validate(obj)) {
            return { repairedYaml: null, error: `${TOTOPO_YAML} could not be repaired: ${formatValidationErrors(validate.errors)}` };
        }

        const yaml = obj as unknown as TotopoYamlConfig;
        writeTotopoYaml(dir, yaml);
        return { repairedYaml: yaml, message: `Repaired ${TOTOPO_YAML}: ${fixes.join(", ")}` };
    } catch (err) {
        return { repairedYaml: null, error: `${TOTOPO_YAML} repair failed: ${err instanceof Error ? err.message : err}` };
    }
}
