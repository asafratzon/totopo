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
export const GLOBAL_DIR = "global"; // host-global state not tied to a workspace (the config file)

// Workspace cache subdirectories (under ~/.totopo/workspaces/<id>/)
export const AGENTS_DIR = "agents";
export const SHADOWS_DIR = "shadows";
export const PNPM_STORE_DIR = "pnpm-store";

// Filenames
export const TOTOPO_YAML = "totopo.yaml";
export const LOCK_FILE = ".lock";
export const GLOBAL_CONFIG_FILE = "config"; // ~/.totopo/global/config - key=value host-global settings

// The workspace shape this totopo writes, stamped into every .lock as `version=`. It is the shape's
// number, not the package version: it changes only when the on-disk layout does. A lock without it was
// written by a pre-v4 totopo, which is what legacy-check.ts keys the one surviving tidy-up off.
export const LOCK_VERSION = "4";

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
// pnpm's default global store path inside the container. Single source of truth for both the -v mount (pnpm-store.ts)
// and the store-dir env var (RUNTIME_ENV below) so the mount target and the env var can never drift apart.
export const CONTAINER_PNPM_STORE = `${CONTAINER_HOME}/.local/share/pnpm/store`;

// What the container runs as PID 1 so it stays up between sessions. It has to be a shell that traps TERM,
// not a bare `sleep infinity`: the kernel drops signals sent to PID 1 from inside its own PID namespace
// unless PID 1 installed a handler, and without a handler nothing in the container - including the web
// interface's "stop the container" button - can ever end it. `docker stop` from the host works either way,
// and gets cleaner with the trap: an immediate exit 0 instead of the 10s timeout and a SIGKILL.
export const CONTAINER_KEEP_ALIVE = ["bash", "-c", 'trap "exit 0" TERM INT; while :; do sleep 86400 & wait $!; done'] as const;

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
export const LABEL_AUTOSTART = "totopo.autostart";
export const LABEL_PORTS = "totopo.ports";
export const LABEL_ENV = "totopo.env";

// Fallback active-profile name - used for the container label and .lock file when a workspace defines no profiles of its own.
export const DEFAULT_PROFILE = "default";

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
// Suppress Claude Code features that are inapplicable or disruptive inside the container, tune session behavior,
// and pin container-isolation safeguards (e.g. pnpm's store path).
export const RUNTIME_ENV: Record<string, string> = {
    CLAUDE_AFK_TIMEOUT_MS: "2147483647", // Max 32-bit timer value (~24.8 days); avoids AFK timeouts in long unattended container sessions
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1", // Periodic feedback survey prompt is noise in ephemeral container sessions
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", // Suppress non-essential network calls (autoupdate checks, telemetry pings)
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1", // Skip automatic addition of the official plugin marketplace on first run
    DISABLE_AUTOUPDATER: "1", // In-process updater fails (root-owned prefix); startup.mjs handles updates
    DISABLE_ERROR_REPORTING: "1", // Container errors include sandbox paths not useful to Anthropic
    DISABLE_INSTALLATION_CHECKS: "1", // npm install is by design; native installer is not applicable
    DISABLE_TELEMETRY: "1", // Container sessions should not phone home
    DISABLE_UPGRADE_COMMAND: "1", // /upgrade is wrong path inside container; totopo manages CLI version
    DO_NOT_TRACK: "1", // Universal opt-out honored by many CLIs/tools running in the container
    // Force pnpm's store to the mounted host path so a per-project .pnpm-store never leaks to the host repo (see pnpm-store.ts).
    // This removes pnpm's store-dir auto-detection, which could otherwise pick a different path before the mount takes effect.
    // Both the pnpm-native and legacy npm-style keys are set so older pnpm versions honor it too.
    npm_config_store_dir: CONTAINER_PNPM_STORE,
    pnpm_config_store_dir: CONTAINER_PNPM_STORE,
};

// Auto-start agent (host-global, stored in ~/.totopo/global/config). When set to a supported agent, the
// container's login shell launches it automatically on session entry and drops to a shell when it exits.
// The string values are the actual shell commands (claude/opencode/codex); "off" disables it (the default).
// A user's favorite agent is a person-level preference, so this is global rather than per-workspace.
export const AUTO_START = { off: "off", claude: "claude", opencode: "opencode", codex: "codex" } as const;
export type AutoStartAgent = (typeof AUTO_START)[keyof typeof AUTO_START];
export const AUTO_START_AGENTS: readonly AutoStartAgent[] = Object.values(AUTO_START);

// Web agent interface (webterm). The server always binds this fixed container port; totopo publishes it
// loopback-only to a sticky per-workspace host port taken from web_range (host-global setting).
export const WEB_CONTAINER_PORT = 3899;
export const WEB_RANGE_DEFAULT = "3900-3999";

// Where the webterm server publishes the key its URL carries (`/?k=<key>`). A new key is minted every time
// that server starts and written here as soon as it has the port, so whoever prints the URL reads it back
// from this file rather than storing one: the container greeting, the `webterm` launcher, and totopo on the
// host before it probes /status. Container-side path - the host only ever reads it through `docker exec`.
export const WEB_KEY_FILE_PATH = "/tmp/webterm.key";

// Resume marker: a host-written container file whose content is the full command that resumes the most
// recent conversation. Planted by dev.ts on every container create/start when auto-start is on; consumed
// (rename-then-read, atomic) by exactly one of the webterm server or the .bashrc autostart hook, so the
// first session after a container start resumes and every later one starts fresh. Lives in the devuser
// home, not /tmp - consumers execute the file's content, so it must not sit in a world-writable dir.
export const RESUME_MARKER_PATH = `${CONTAINER_HOME}/.totopo-resume-pending`;

// Per-agent command that reopens the most recent conversation. Pinned against the real CLIs by the
// drift test in tests/webterm.test.ts, which checks each flag/subcommand against the CLI's own help.
export const AGENT_RESUME_COMMAND: Record<Exclude<AutoStartAgent, "off">, string> = {
    claude: "claude --continue",
    opencode: "opencode --continue",
    codex: "codex resume --last",
};
