# ROADMAP.md

Tracks current work in progress and upcoming planned items.

## Recently Completed

### v3.0.0 — Major simplification
- `totopo.yaml` is now the single project config (replaces settings.json, meta.json)
- `project_id` in totopo.yaml replaces SHA-256 hash-based directory naming
- `~/.totopo/projects/<project_id>/` contains only: `.lock` (project root + active profile), `agents/`, `shadows/`
- Single base Dockerfile + profile hooks (replaces host-mirror/full modes)
- Gitignore-style shadow path patterns (replaces explicit paths)
- `env_file` in totopo.yaml (replaces `~/.totopo/.env`)
- JSON Schema for totopo.yaml (IDE autocomplete/validation)
- Simplified onboarding (no mode/tool/scope selection)
- v2 → v3 automatic migration
- Non-git warning shown in menu status box (not persisted)

## Backlog

- Profile `extends` inheritance (e.g. `extends: default` to inherit and append dockerfile_hook)

- Make the blocking git remote disableable via project settings and via the yaml (Default to on)

- Run 'npx totopo' when installed totopo version is older - discuss strategy and auto-upgrade option
    Version tracking and upgrade safety (possible directions)
    - On every run, totopo records its version in totopo.yaml or a state file.
    - If a user runs an older major version after a newer one has written config, totopo should block with a clear error.
    - Once per day, totopo checks the npm registry for a newer published version and shows an update nudge.

- Add Tests + pnpm test + update AGENTS.md + update pre-commit hook to run them
