# AGENTS.md

This file provides guidance to AI agents working with code in this repository.

## What is totopo

totopo is a CLI (`npx totopo`) that runs AI coding agents in an isolated Docker container per workspace. It manages workspace lifecycle: onboarding, container builds, profile selection, shadow path isolation, agent context injection, and persistent agent memory.

Key concepts:
- **Workspace** — a directory containing `totopo.yaml`. The `workspace_id` field drives container naming (`totopo-<id>`) and the cache directory (`~/.totopo/workspaces/<id>/`).
- **Profiles** — named Dockerfile variants in `totopo.yaml`. Each has a `dockerfile_hook` appended to the base image. One profile is active per session.
- **Shadow paths** — gitignore-style patterns in `totopo.yaml`. Matching paths are overlaid with empty container-local copies so agents never see or modify those host files.
- **Agent context injection** — on every session start, totopo writes markdown context files into the agent dirs on the host, which are bind-mounted into the container. Do not edit these files manually.

## Commands

```bash
pnpm build          # Compile src/ -> dist/
pnpm re:build       # Clean dist/ then rebuild
pnpm typecheck      # Type-check without emit
pnpm lint           # Biome check (format + lint)
pnpm lint:fix       # Auto-fix formatting and lint issues
pnpm test           # Run unit tests via tsx (no compile step needed)
pnpm test:docker    # Run Docker integration tests (requires Docker, host-only)
pnpm test:all       # Run both unit and Docker integration tests
pnpm validate       # Fast check: typecheck + lint + scripts/check.ts + test
pnpm check          # Full pre-release check: validate + re:build
pnpm start          # Run totopo (host only - Docker not available inside container)
```

Workflow after edits: `pnpm lint:fix` then `pnpm check`. If `pnpm check` auto-fixes divider lines it will fail - review the diff, re-stage, and run again.

## Structure

```
bin/
  totopo.js                    - Entry point (ESM). Migration, repair, workspace resolution, menu loop.
                                 Imports compiled modules from dist/ - never imports from src/ directly.

src/commands/                  - Command modules (compiled to dist/commands/ by pnpm build)
  dev.ts                       - Session start: profile selection, shadow sync, container lifecycle, agent context
                                 Exports: StartContainerOpts, ContainerStartResult, startContainer()
  doctor.ts                    - Host readiness checks (Docker installed and running)
  global.ts                    - "Manage totopo" menu: stop containers, clear memory, remove images, uninstall
  menu.ts                      - Workspace menu (per-workspace actions and status display)
  onboard.ts                   - First-time setup: workspace root, name, workspace_id, totopo.yaml creation
  workspace.ts                 - "Manage Workspace" submenu: shadow paths, rebuild, reset config
                                 Exports: stop(), resetImage() for workspace container lifecycle

src/lib/                       - Shared utilities (compiled to dist/lib/ by pnpm build)
  agent-context.ts             - AGENT_MOUNTS, buildAgentMountArgs, buildAgentContextDocs, injectAgentContext
  constants.ts                 - Canonical constants: paths, filenames, container names, Docker labels
  dockerfile-builder.ts        - Compose final Dockerfile from base template + profile hook
  migrate-to-latest.ts         - Startup migration: projects/ rename, v2 hash dirs, lock file format upgrade
  safe-rm.ts                   - safeRmSync: path-allowlist guard wrapping rmSync (only deletes under ~/.totopo/ or totopo.yaml)
  shadows.ts                   - Pattern expansion, shadow sync, Docker mount args for shadow paths
  totopo-yaml.ts               - Read, write, validate, repair totopo.yaml; schema validation via ajv
  workspace-identity.ts        - Workspace registry: lock files, WorkspaceContext, resolveWorkspace

scripts/                       - Release tooling (excluded from npm package, not compiled to dist/)
  build.ts                     - Build script: runs tsc and prints clack success/failure output (pnpm build)
  check.ts                     - Pre-commit health checks: divider normalization, special char detection,
                                 changelog structure validation
  changelog.yaml               - Source of truth for all release notes; edit this, not CHANGELOG.md
  changelog-utils.ts           - Read/write/validate changelog.yaml
  generate-changelog.ts        - Regenerate CHANGELOG.md from changelog.yaml (pnpm generate-changelog)
  rc.ts                        - Publish a release candidate to npm (pnpm rc)
  release.ts                   - Promote rc to latest release (pnpm rc:promote)
  sync-github-releases.ts      - Sync GitHub releases with npm + changelog.yaml

templates/                     - Bundled assets (included in npm package)
  Dockerfile                   - Base image (debian:bookworm-slim + Node.js + git + AI CLIs)
  startup.mjs                  - Runs inside container as root on every session; AI CLI updates + readiness checks
  context/                     - Markdown templates for agent context injection ({{var}} placeholders)

tests/                         - Unit test suite (run via tsx, not compiled to dist/)
  helpers.ts                   - Shared test utilities: createTempDir, cleanTempDir, overrideEnv
  agent-context.test.ts        - Agent context template rendering and mount args
  changelog-utils.test.ts      - Version bumping, changelog validation, git tag checks
  dockerfile-builder.test.ts   - Dockerfile assembly and profile hook ordering
  global.test.ts               - removeWorkspaceFiles: removes workspace dir and optional totopo.yaml
  migrate-to-latest.test.ts    - All migration steps with isolated HOME and DOCKER_HOST
  safe-rm.test.ts              - safeRmSync: allowlist guard, path traversal, and temp dir coverage
  shadows.test.ts              - Shadow pattern expansion, sync, and Docker mount args
  totopo-yaml.test.ts          - YAML read/write/validate/repair and workspace ID slug
  workspace-identity.test.ts   - Container naming, lock files, collision and orphan detection

tests/docker/                  - Docker integration tests (pnpm test:docker, requires Docker, host-only)
  docker-helpers.ts            - uniqueName, dockerContainerStatus/Label/Exec, forceRemove*, cleanupAllTestArtifacts
  image-lifecycle.test.ts      - buildImageWithTempfile: build, label, noCache, invalid Dockerfile, removal
  session-lifecycle.test.ts    - startContainer(): lifecycle (created/resumed/connected), labels, mounts,
                                 mismatch detection, shadow overlays, profile hooks

schema/
  totopo.schema.json           - JSON Schema for totopo.yaml (bundled; used by ajv at runtime)
```

### Host-side data (outside this repo)

```
~/.totopo/
  workspaces/
    <workspace_id>/
      .lock                    - Line 1: absolute workspace root path. Line 2: active profile name.
      agents/
        claude/                - Mounted as ~/.claude/ inside the container
          .claude.json         - Mounted as ~/.claude.json (file mount - persists Claude Code settings)
        opencode/
          config/              - Mounted as ~/.config/opencode/ inside the container
          data/                - Mounted as ~/.local/share/opencode/ inside the container
        codex/                 - Mounted as ~/.codex/ inside the container
      shadows/                 - Container-local shadow path storage (persists across sessions)
```

## Architecture

**Entry point:** `bin/totopo.js` imports from `dist/`, runs migration, resolves workspace, enters interactive menu loop.

**Command flow:** Menu selection dispatches to command modules in `src/commands/`. Each command is a standalone async `run()` export. The menu loops until the user quits or starts a session.

**Session start (`dev.ts`):**
1. Read `totopo.yaml` -> select profile -> expand shadow patterns
2. Build Dockerfile in memory (base template + profile hook + USER devuser)
3. Write to temp file -> `docker build` -> clean up temp file
4. Create container with bind mounts (workspace + shadows + agent dirs)
5. Run startup script via `docker exec -u root` (AI CLI updates + readiness checks)
6. Connect via `docker exec -it bash`

**Agent context (`agent-context.ts`):** Markdown templates from `templates/context/*.md` are assembled with `{{variable}}` substitution, then written to agent dirs on the host (bind-mounted into container).

**Migration (`migrate-to-latest.ts`):** Ordered registry of idempotent migrations that run on every startup. Each handles a specific legacy structure (v2 hash dirs, rc-era renames, etc.).

**Migration path rule:** Every migration transforms an old structure (A) into the current one (B).
- **A paths** (source, being migrated away from) — hardcode as string literals. If a constant changes later, the migration must still find the old location unchanged.
- **B paths** (destination, current structure) — use constants from `constants.ts`, so they stay in sync if the structure evolves.

Example: `migrateProjectsDir` uses `".totopo"` and `"projects"` for the old dir (A), and `TOTOPO_DIR`/`WORKSPACES_DIR` for the new dir (B).

**Shadow paths (`shadows.ts`):** Patterns expanded via fast-glob. Matched paths get overlaid with empty container-local directories via Docker bind mounts.

## Coding conventions

- **ESM with `.js` extensions** in all TypeScript imports (Node.js nodenext resolution requirement)
- **Plain ASCII in comments** - no Unicode arrows, em dashes, or special characters. Use `->` not the Unicode arrow, `-` not em dash
- **Comment lines start with a capital letter**
- **Biome formatting:** 140 char line width, 4-space indent, double quotes
- **TypeScript strict mode** with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- **Comment divider lines** must be exactly 141 chars (prefix `// ` + 138 `=` or `-`). `scripts/check.ts` enforces this

## Security boundaries (non-negotiable)

The container isolation model is the core value proposition. Never weaken:
- Git remote block (`protocol.allow = never` in `/etc/gitconfig`)
- Non-root user (`devuser` uid 1001)
- `no-new-privileges:true` security opt
- No host credentials inside container
- Only the workspace directory is mounted

## Rules

- Never commit without explicit user instruction
- Never edit `scripts/changelog.yaml` without explicit user approval
- After editing `src/`, run `pnpm check` to verify. Ask the user to run `pnpm start` on the host - Docker is not available inside the container
- Read `ROADMAP.md` at session start to understand current state and open items

## Skills

Skills live in `.claude/skills/`. The `.agents/skills/` directory contains symlinks to the same files — edit only the `.claude/skills/` versions.

## Release process

RC development happens on a dedicated branch (e.g. `v3.1.0-rc-development`), not on `main`. This keeps `main` pointing to the latest stable release at all times. When `pnpm rc:promote` runs, it squash merges the RC branch into `main` automatically.

Use the `/release` skill to prepare an RC. The source of truth for release notes is `scripts/changelog.yaml` - `CHANGELOG.md` is generated from it. RC entries follow a cumulative convention (describe the full release, not delta from previous RC). Publishing and git push happen on the host via `pnpm rc`.
