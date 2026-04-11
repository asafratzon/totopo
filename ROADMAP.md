## In Progress


## High Priority Backlog

### Parallel Profiles Support

Container and image per profile instead of per workspace: `totopo-<workspace_id>-<profile_name>`.
Allows running multiple parallel containers in the same workspace, each with a different profile.
Fastest to switch between profiles since switching does not require cleanup of the previous profile.

#### Naming and identity

- Container/image naming: `totopo-<workspace_id>-<profile_name>`
- Profile identity is tied to the profile name. Renaming a profile in totopo.yaml orphans the old container/image (handled by stale detection). This is acceptable since profile renames are rare.

#### Lock file changes

- Drop active profile from lock file. Derive running profiles from Docker via `docker ps --filter`.
- Lock file keeps only workspace root path (line 1). Docker is the source of truth for what's running.

#### Shadow paths become per-profile

- Currently: `~/.totopo/workspaces/<id>/shadows/`
- New: `~/.totopo/workspaces/<id>/shadows/<profile>/`
- Two parallel containers sharing the same shadow dirs would conflict (e.g. different node_modules for different profiles). Each profile needs its own shadow storage.

#### Profile switch teardown menu

When starting a profile while another profile's container is running, ask whether to stop it:
  - No (enables parallel work)
  - Yes, but keep image (quicker startup on next session)
  - Yes and clear image (frees space, slower startup on next session)

#### Main menu workspace visibility

Show per-profile status in the workspace status box:

```
  workspace-name
  |- node-dev    * running
  |- python-ml   o stopped
  |- rust        ~ image only
  '- go          . no image
```

Four profile states:
  - `* running` -- container is up
  - `o stopped` -- container exists but stopped (image necessarily exists too)
  - `~ image only` -- no container, image is cached (fast startup)
  - `. no image` -- nothing exists (full build required)

#### Stale detection on startup

Run on every startup, prompt for cleanup (never auto-delete).

| Resource | Stale when | Detection |
|---|---|---|
| Container | Profile removed from totopo.yaml, or workspace deleted/moved | Compare running/stopped container labels against current totopo.yaml profiles |
| Image | No container references it AND profile no longer in totopo.yaml | `docker image ls` filtered by totopo label, cross-ref with totopo.yaml |
| Workspace dir | Lock file points to a path that no longer contains totopo.yaml | Check lock file path on startup |

#### Image layering (optional, not required for v1)

Profiles sharing a common base (the Dockerfile template) could share a base image with profile hooks as a thin layer on top. Saves disk when users have many profiles.

#### Migration

Deterministic migration from current single-container model:
1. Rename existing container `totopo-<id>` to `totopo-<id>-<active_profile>` via `docker rename`
2. Relabel the existing image
3. Move existing shadow dir from `shadows/` to `shadows/<active_profile>/`
4. Update lock file format (remove profile line)

Active profile is known from the current lock file (line 2), so migration is deterministic.

#### Risks to address

- **Shared workspace mount (HIGH):** Parallel containers bind-mount the same workspace read-write. Concurrent agent edits on the same files = corruption. Need a clear stance: warn-only, read-only second mount, or git worktrees. Design decision required before building.
- **Shared agent context dirs (MEDIUM):** `agents/claude/` etc. are per-workspace. Two containers writing to the same `~/.claude/` concurrently corrupts settings/memory. Fix: move to `agents/<profile>/claude/` (same pattern as shadow paths).
- **Profile name validation (LOW-MEDIUM):** Docker container names allow `[a-zA-Z0-9_.-]` only. Profile names are unvalidated YAML keys. Add schema validation or sanitize when deriving container names.
- **Docker query latency (LOW):** `docker ps` (~100-300ms) replaces sub-ms lock file reads. Mitigate with a single `docker ps --filter label=totopo.managed=true` call parsed once for all workspaces/profiles.
- **Migration atomicity (LOW):** Four-step migration can be interrupted. Follow existing idempotent migration pattern — check preconditions, skip if already done.
- **CLI update throttle (RESOLVED):** Moved to per-container timestamp file (`/home/devuser/.ai-cli-updated`). Each container independently tracks when its AI CLIs were last updated.

#### Other

- Docs updates required
- Agent context injection needs to account for per-profile container names

### Local LLM Support

## Low Priority Backlog

- Voice to text support

- Support readonly mounts? (possibly to refer to dirs outside the workspace)

- Make the blocking git remote disableable via workspace settings and via the yaml (Default to on)
