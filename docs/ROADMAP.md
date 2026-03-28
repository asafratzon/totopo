# ROADMAP.md

Tracks current work in progress and upcoming planned items.

## In Progress

- **Automatic workspace shadow mounts** — `.claude/`, `.codex/`, `.opencode/` are automatically
  detected at container creation time. If the dir exists in the project, it passes through
  (user's real config). If it doesn't, totopo shadow-mounts it so AI CLIs write to
  `~/.totopo/` instead of creating dirs in the project. Implementation is in
  `src/lib/agent-context.ts`; needs host testing.

  **To test:**
  1. **Project without `.claude/`**: start a repo-scope session. Confirm `/workspace/.claude/`
     inside the container maps to `~/.totopo/projects/<id>/agents/workspace/.claude/` on the
     host. Agent context doc (check `~/.totopo/projects/<id>/agents/claude/CLAUDE.md`) should
     include the "Workspace config isolation" section listing `.claude/` as shadowed.
  2. **Project with `.claude/`**: create `.claude/` in the project root with a test file. Start
     a repo-scope session. Confirm the test file is visible at `/workspace/.claude/` inside the
     container. Agent context doc should NOT list `.claude/` as shadowed (or omit the section
     entirely if all three dirs exist).
  3. **Mixed**: project has `.claude/` but not `.opencode/`. Confirm `.claude/` passes through
     and `.opencode/` is shadowed. Agent context doc lists only `.opencode/` (and `.codex/`).
  4. **cwd scope in subdirectory**: start a cwd-scope session from a subdirectory. Confirm
     shadow mounts apply (subdirectory unlikely to have `.claude/`).
  5. **Shadow change on resume**: start a session (no `.claude/` in project — shadowed). Stop
     the container. Create `.claude/` in the project root. Start again — container should be
     recreated (not just resumed), and `.claude/` should now pass through.
  6. **Docker label**: inspect the container with
     `docker inspect --format '{{index .Config.Labels "totopo.shadows"}}'` — should show the
     comma-separated list of currently shadowed container paths.
  7. **Clear agent memory**: run "Manage totopo > Clear agent memory" and confirm
     `agents/workspace/` is also removed.
  8. Repeat key checks for `.codex/` and `.opencode/`.

## Backlog

- Add Tests

- Improve/standarize the container image used so AI agents have all the tools they need
    - The baseline image, should be overridable by the user, but how/where to locate it?
    - New totopo versions running should detect existing ~/.totopo dir and "upgrade them" on first run (some files should be re-written, like docker image etc).

- **Orphan recovery via git remote**: store git remote URL at onboarding; if a new path is onboarded and remote URL matches an existing orphaned config, offer to reclaim it. (v1 onboarding already stores `gitRemoteUrl` in `meta.json`)
