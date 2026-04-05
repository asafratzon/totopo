// =========================================================================================================================================
// src/lib/constants.ts - Canonical constants used across the totopo codebase
// =========================================================================================================================================

// ~/.totopo/ structure
export const TOTOPO_DIR = ".totopo";
export const WORKSPACES_DIR = "workspaces";
export const PROJECTS_DIR = "projects"; // legacy v3-rc-1/rc-2; only referenced in migration

// Workspace cache subdirectories (under ~/.totopo/workspaces/<id>/)
export const AGENTS_DIR = "agents";
export const SHADOWS_DIR = "shadows";

// Filenames
export const TOTOPO_YAML = "totopo.yaml";
export const LOCK_FILE = ".lock";
export const GLOBAL_ENV_FILE = ".env"; // legacy global key file; only referenced in migration

// Workspace ID constraints (must match schema/totopo.schema.json)
export const WORKSPACE_ID_MIN = 2;
export const WORKSPACE_ID_MAX = 48;

// Default shadow paths applied to new workspaces
export const DEFAULT_SHADOW_PATHS = ["node_modules", ".env*"] as const;

// Container filesystem
export const CONTAINER_USER = "devuser";
export const CONTAINER_HOME = `/home/${CONTAINER_USER}`;
export const CONTAINER_WORKSPACE = "/workspace";
export const CONTAINER_POST_START = `${CONTAINER_HOME}/post-start.mjs`;

// Docker container/image naming
export const CONTAINER_NAME_PREFIX = "totopo-";

// Docker label keys
export const LABEL_MANAGED = "totopo.managed";
export const LABEL_SHADOWS = "totopo.shadows";
export const LABEL_PROFILE = "totopo.profile";

// Built-in profile names (must match keys in buildDefaultTotopoYaml in totopo-yaml.ts)
export const PROFILE = {
    default: "default",
    slim: "slim",
    custom: "custom",
} as const;
export type BuiltInProfile = (typeof PROFILE)[keyof typeof PROFILE];
