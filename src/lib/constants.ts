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
export const GLOBAL_DIR = "global"; // host-global state not tied to a workspace (config + pulse cookie)

// Workspace cache subdirectories (under ~/.totopo/workspaces/<id>/)
export const AGENTS_DIR = "agents";
export const SHADOWS_DIR = "shadows";
export const PNPM_STORE_DIR = "pnpm-store";

// Filenames
export const TOTOPO_YAML = "totopo.yaml";
export const LOCK_FILE = ".lock";
export const GLOBAL_ENV_FILE = ".env"; // legacy global key file; only referenced in migration
export const GLOBAL_CONFIG_FILE = "config"; // ~/.totopo/global/config - key=value host-global settings
export const PULSE_COOKIE_FILE = "pulse-cookie"; // ~/.totopo/global/pulse-cookie - dedicated PulseAudio TCP cookie

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
export const LABEL_BUILD_HASH = "totopo.build-hash";
export const LABEL_AUDIO = "totopo.audio";
export const LABEL_AUTOSTART = "totopo.autostart";

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
// Each flag suppresses a Claude Code feature that is inapplicable or disruptive inside the container.
export const RUNTIME_ENV: Record<string, string> = {
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1", // Periodic feedback survey prompt is noise in ephemeral container sessions
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", // Suppress non-essential network calls (autoupdate checks, telemetry pings)
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1", // Skip automatic addition of the official plugin marketplace on first run
    DISABLE_AUTOUPDATER: "1", // In-process updater fails (root-owned prefix); startup.mjs handles updates
    DISABLE_ERROR_REPORTING: "1", // Container errors include sandbox paths not useful to Anthropic
    DISABLE_INSTALLATION_CHECKS: "1", // npm install is by design; native installer is not applicable
    DISABLE_TELEMETRY: "1", // Container sessions should not phone home
    DISABLE_UPGRADE_COMMAND: "1", // /upgrade is wrong path inside container; totopo manages CLI version
    DO_NOT_TRACK: "1", // Universal opt-out honored by many CLIs/tools running in the container
};

// Audio bridge for Claude Code /voice (opt-in, per-workspace via the .lock audio flag).
// When enabled, dev.ts injects PULSE_SERVER + AUDIODRIVER and an --add-host so SoX 'rec'
// inside the container reaches a PulseAudio server running on the host.
// The host must be host.docker.internal, never 127.0.0.1 (which is the container itself).
export const AUDIO_TCP_PORT = 4713;
export const AUDIO_PULSE_SERVER = `tcp:host.docker.internal:${AUDIO_TCP_PORT}`;
export const AUDIODRIVER_VALUE = "pulseaudio";
// Where the host PulseAudio cookie is bind-mounted inside the container. PULSE_COOKIE points here so
// libpulse presents the shared secret; only containers totopo hands the cookie to can authenticate.
export const AUDIO_COOKIE_CONTAINER_PATH = `${CONTAINER_HOME}/.config/pulse/cookie`;

// Host audio server control mode (host-global, stored in ~/.totopo/global/config). manual: the user starts and stops
// the host server from the Voice/audio menu. automatic: totopo starts it when a session opens and stops
// it when the last connected session exits. Automation is macOS-only (the platform where totopo manages
// PulseAudio), so automatic mode is offered only there. Defaults to manual. Defined directly here (unlike
// GIT_MODE) because there is no container-side consumer that would need runtime-constants.mjs.
export const AUDIO_MODE = { manual: "manual", automatic: "automatic" } as const;
export type AudioMode = (typeof AUDIO_MODE)[keyof typeof AUDIO_MODE];
export const AUDIO_MODES: readonly AudioMode[] = Object.values(AUDIO_MODE);

// Auto-start agent (host-global, stored in ~/.totopo/global/config). When set to a supported agent, the
// container's login shell launches it automatically on session entry and drops to a shell when it exits.
// The string values are the actual shell commands (claude/opencode/codex); "off" disables it (the default).
// A user's favorite agent is a person-level preference, so this is global rather than per-workspace.
export const AUTO_START = { off: "off", claude: "claude", opencode: "opencode", codex: "codex" } as const;
export type AutoStartAgent = (typeof AUTO_START)[keyof typeof AUTO_START];
export const AUTO_START_AGENTS: readonly AutoStartAgent[] = Object.values(AUTO_START);
