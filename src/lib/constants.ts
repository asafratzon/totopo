// =========================================================================================================================================
// src/lib/constants.ts - Canonical constants used across the totopo codebase
// =========================================================================================================================================

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the package root (repo root in dev, npm package root when installed).
// All compiled lib modules sit at dist/lib/*.js, so dirname x3 from this file lands at the package root.
export const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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
export const CONTAINER_STARTUP = `${CONTAINER_HOME}/startup.mjs`;

// Claude Code default status line script - baked into the image, referenced from ~/.claude/settings.json
export const CLAUDE_STATUSLINE_PATH = "/usr/local/share/totopo/claude-statusline.sh";

// Docker container/image naming
export const CONTAINER_NAME_PREFIX = "totopo-";

// Docker label keys
export const LABEL_MANAGED = "totopo.managed";
export const LABEL_SHADOWS = "totopo.shadows";
export const LABEL_PROFILE = "totopo.profile";
export const LABEL_RUNTIME_ENV = "totopo.runtime-env";
export const LABEL_GIT_MODE = "totopo.git-mode";

// Built-in profile names (must match keys in buildDefaultTotopoYaml in totopo-yaml.ts)
export const PROFILE = {
    default: "default",
    extended: "extended",
} as const;
export type BuiltInProfile = (typeof PROFILE)[keyof typeof PROFILE];

// Git guardrails modes (per-workspace, stored in .lock).
// Single source of truth lives in templates/runtime-constants.mjs so container-side
// scripts (startup.mjs, startup-git-mode.mjs) and TS code can both reference the
// same values without drift. We re-export here so internal code keeps importing
// from "./constants.js" as before.
import { GIT_MODE, GIT_WRAPPER_PATH, GIT_WRAPPER_SOURCE } from "../../templates/runtime-constants.mjs";

export { GIT_MODE, GIT_WRAPPER_PATH, GIT_WRAPPER_SOURCE };
export type GitMode = (typeof GIT_MODE)[keyof typeof GIT_MODE];
export const GIT_MODES: readonly GitMode[] = Object.values(GIT_MODE);

// Runtime env vars injected into every container via docker run -e.
// DISABLE_AUTOUPDATER suppresses Claude Code's in-process auto-updater, which always fails inside
// the container (devuser can't write to the root-owned global npm prefix). totopo's startup script
// already keeps Claude on the latest version - see templates/startup.mjs.
export const RUNTIME_ENV: Record<string, string> = {
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    DISABLE_AUTOUPDATER: "1",
};
