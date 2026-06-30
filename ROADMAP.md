## Backlog

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


## Ideas

- `npx totopo -q 'direct message to claude in running container'` --> to return the response to the user. 
    - support another command that will let claude run in auto-approve mode on, so i could do: `npx totopo -x 'please create file here bla bla'`

- Base image sharing - a shared `totopo-base:latest` built from `templates/Dockerfile`, with profile images layered on top (`FROM totopo-base` + hook). Saves disk when multiple profiles are defined, faster profile rebuilds since only the hook layer runs.

- Support readonly mounts? (possibly to refer to dirs outside the workspace)

- Local LLM Support?