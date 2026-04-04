# ROADMAP.md

Tracks current work in progress and upcoming planned items.

## Recently Completed

### v3.0.0 — Major simplification
- `totopo.yaml` is now the single workspace config (replaces settings.json, meta.json)
- `workspace_id` in totopo.yaml replaces SHA-256 hash-based directory naming
- `~/.totopo/workspaces/<workspace_id>/` contains only: `.lock` (workspace root + active profile), `agents/`, `shadows/`
- Single base Dockerfile + profile hooks (replaces host-mirror/full modes)
- Gitignore-style shadow path patterns (replaces explicit paths)
- `env_file` in totopo.yaml (replaces `~/.totopo/.env`)
- JSON Schema for totopo.yaml (IDE autocomplete/validation)
- Simplified onboarding (no mode/tool/scope selection)
- v2 → v3 automatic migration
- Non-git warning shown in menu status box (not persisted)

## Backlog

### High Priority / Must

- nothing for now

### Nice to have / Raw Ideas

- voice to text

- support readonly mounts? (possibly to refer to dirs outside the workspace)

- consider supporting Gemini CLI + pi.dev CLI

- Profile `extends` inheritance (e.g. `extends: default` to inherit and append dockerfile_hook)

- Make the blocking git remote disableable via workspace settings and via the yaml (Default to on)
