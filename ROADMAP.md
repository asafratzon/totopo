# ROADMAP.md

Tracks current work in progress and upcoming planned items.

## In Progress

- see PROMPT.md

## Backlog

- Make project directory name a bit more readbale? 1f0be1b76af0f6de36967119ec460080abce476ce15de6e88a109f342f63dac4...

- Run 'npx totopo' when installed totopo version is older - discuss strategy and auto-upgrade option
    Version tracking and upgrade safety (possible directions)
    - On every run, totopo records its version in ~/.totopo/state.json ? perhaps just in totopo.yaml.
    - If a user runs an older major version of totopo after a newer major version has written to ~/.totopo/, totopo should block with a clear error telling them to upgrade.
    - If a user upgrades to a new major version, totopo should detect this and offer to reset ~/.totopo/ project configs for compatibility. The reset preserves ~/.totopo/.env (user API keys — never touched), agents/ dirs (AI memory), shadows/ dirs (container-local content) and meta.json. Everything else in each project dir gets wiped since its not needed anymore.
    - Once per day, totopo checks the npm registry for a newer published version and shows an update nudge if one is available. This check has a 2-second timeout and caches the result for 24 hours in state.json.

- Add Tests + pnpm test + update AGENTS.md + update pre-commit hook to run them
