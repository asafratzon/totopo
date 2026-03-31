// =========================================================================================================================================
// src/lib/totopo-yaml.ts - Read, write, and validate totopo.yaml
// =========================================================================================================================================

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
    project_id: string;
    name?: string;
    description?: string;
    env_file?: string;
    shadow_paths?: string[];
    profiles?: Record<string, ProfileConfig>;
}

// --- Validation --------------------------------------------------------------------------------------------------------------------------

// Must match the pattern, minLength, and maxLength in schema/totopo.schema.json
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const PROJECT_ID_MIN = 2;
const PROJECT_ID_MAX = 48;

/** Returns error message if invalid, undefined if valid. Used for interactive input validation. */
export function validateProjectId(id: string): string | undefined {
    if (id.length < PROJECT_ID_MIN) return `Project ID must be at least ${PROJECT_ID_MIN} characters`;
    if (id.length > PROJECT_ID_MAX) return `Project ID must be at most ${PROJECT_ID_MAX} characters`;
    if (!PROJECT_ID_PATTERN.test(id)) return "Project ID must be lowercase alphanumeric with hyphens, not starting or ending with a hyphen";
    return undefined;
}

/** Slugify a directory name into a valid project_id candidate. */
export function slugifyForProjectId(name: string): string {
    return (
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, PROJECT_ID_MAX) || "my-project"
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
        const messages = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
        throw new Error(`${TOTOPO_YAML}: ${messages}`);
    }

    return raw as TotopoYamlConfig;
}

// --- Write -------------------------------------------------------------------------------------------------------------------------------

// TODO: pin to release tag URL once published
const YAML_HEADER = `# yaml-language-server: $schema=https://raw.githubusercontent.com/asafratzon/totopo/main/schema/totopo.schema.json
`;

// Inline comments injected before specific YAML keys
const YAML_COMMENTS: Record<string, string> = {
    shadow_paths: [
        "# Shadow patterns hide matching host paths from the agent.",
        "# The container gets an empty, isolated copy instead.",
        "# Patterns without '/' match at any depth (like .gitignore).",
        "# Supports globs: * (any chars), ? (single char), {a,b} (alternatives).",
    ].join("\n"),
    profiles: "# Dockerfile profiles. Each profile's dockerfile_hook is appended to the base image.",
};

/** Write totopo.yaml to a directory with schema header and inline comments. */
export function writeTotopoYaml(dir: string, config: TotopoYamlConfig): void {
    const filePath = join(dir, TOTOPO_YAML);
    const yamlContent = dumpYaml(config, {
        lineWidth: -1,
        quotingType: '"',
        forceQuotes: false,
    });

    // Inject comments before known keys
    const lines = yamlContent.split("\n");
    const output: string[] = [];
    for (const line of lines) {
        const key = line.match(/^(\w[\w_]*):/)?.[1];
        if (key && YAML_COMMENTS[key]) {
            output.push(YAML_COMMENTS[key]);
        }
        output.push(line);
    }

    writeFileSync(filePath, YAML_HEADER + output.join("\n"));
}

// --- Defaults ----------------------------------------------------------------------------------------------------------------------------

const DEFAULT_SHADOW_PATHS = ["node_modules", ".env*"];

const DEFAULT_PROFILE_HOOK = `# Add Dockerfile instructions here to install additional tools.
# These are appended to the base image (Debian bookworm + Node.js + git + AI CLIs).
# Examples:
#   RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
#   RUN curl -fsSL https://bun.sh/install | bash
`;

/** Create a default TotopoYamlConfig with sane defaults. */
export function buildDefaultTotopoYaml(projectId: string, name?: string, description?: string): TotopoYamlConfig {
    const config: TotopoYamlConfig = {
        schema_version: 3,
        project_id: projectId,
        shadow_paths: [...DEFAULT_SHADOW_PATHS],
        profiles: {
            default: {
                dockerfile_hook: DEFAULT_PROFILE_HOOK,
            },
        },
    };
    if (name) config.name = name;
    if (description) config.description = description;

    // Reorder keys so name/description appear after project_id
    const { schema_version, project_id, name: n, description: d, ...rest } = config;
    const ordered: Record<string, unknown> = { schema_version, project_id };
    if (n !== undefined) ordered.name = n;
    if (d !== undefined) ordered.description = d;
    return Object.assign(ordered, rest) as unknown as TotopoYamlConfig;
}
