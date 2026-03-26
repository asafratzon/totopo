# AGENTS.md

## Project

totopo is a CLI (`npx totopo`) that runs AI coding agents in an isolated Docker container per project.

Key concepts:
- **Project** — any local directory registered once with totopo. Identity is a SHA-256 hash of the absolute path; all config lives in `~/.totopo/projects/<id>/` on the host. Nothing is written to the user's project directory unless they opt into a shared `totopo.yaml` anchor file.
- **Two-level menu** — when inside a registered project, totopo shows the project menu (Open session, Rebuild, Stop, Runtime mode, etc.). "Manage totopo" is a global submenu for cross-project actions (stop all containers, clear memory, remove images, uninstall).
- **Runtime modes** — `host-mirror` generates a Dockerfile pinned to the host's detected runtime versions; `full` uses the latest stable versions of everything. Mode is stored in `~/.totopo/projects/<id>/settings.json`.
- **Agent context injection** — on every session start, totopo writes context files directly to the agents dir on the host (e.g. `agents/claude/CLAUDE.md`), which are then mounted into the container. Do not edit these files inside the container.

## Structure

```
bin/
  totopo.js                    - Entry point (ESM). Resolves project from CWD, drives the menu loop.
                                 Imports compiled modules from dist/ — never imports from src/ directly.

src/commands/                  - Command modules (compiled to dist/commands/ by pnpm build)
  advanced.ts                  - "Manage totopo" menu: stop containers, clear memory, remove images,
                                 reset API keys, doctor, uninstall
  dev.ts                       - Scope picker, container lifecycle, agent context injection
  doctor.ts                    - Host readiness checks (Docker installed/running, Dockerfile present)
  menu.ts                      - Project menu (per-project actions)
  onboard.ts                   - First-time setup flow; also exports addProjectAnchor()
  rebuild.ts                   - Stop container + remove image to force a fresh build
  settings.ts                  - Runtime mode switcher (host-mirror / full)
  stop.ts                      - Stop and remove a project's container
  sync-dockerfile.ts           - Silent pre-flight: regenerate Dockerfile if host runtimes changed

src/lib/                       - Shared utilities (compiled to dist/lib/ by pnpm build)
  config.ts                    - Read/write ~/.totopo/projects/<id>/settings.json
  detect-host.ts               - Detect host runtime versions (node, python, go, rust, java, bun)
  generate-dockerfile.ts       - Generate Dockerfile content (full or host-mirror mode)
  project-identity.ts          - SHA-256 project registry, walk-up CWD resolution, container naming
  select-tools.ts              - Multiselect UI for runtime tool selection

scripts/                       - Release tooling (excluded from npm package, not compiled to dist/)
  check.ts                     - Pre-commit health checks: divider normalization, special char
                                 detection, changelog structure validation
  changelog.yaml               - Source of truth for all release notes; edit this, not CHANGELOG.md
  changelog-utils.ts           - Read/write/validate changelog.yaml
  generate-changelog.ts        - Regenerates CHANGELOG.md from changelog.yaml (pnpm generate-changelog)
  rc.ts                        - Publish a release candidate to npm (pnpm rc)
  release.ts                   - Promote rc to latest release (pnpm rc:promote)
  sync-github-releases.ts      - Sync GitHub releases with npm + changelog.yaml

templates/                     - Copied to ~/.totopo/projects/<id>/ during onboarding
  Dockerfile                   - Base image template (used in "full" mode; host-mirror generates its own)
  post-start.mjs               - Runs inside container after start; checks tool readiness
  env                          - API key template copied to ~/.totopo/.env on first onboard

docs/
  ROADMAP.md                   - Current work in progress and backlog; read at session start
  RELEASES.md                  - Release workflow and checklist

.githooks/pre-commit           - Runs pnpm check before every commit (auto-installed via pnpm prepare)
biome.json                     - Lint and format config (lineWidth: 140, indentWidth: 4)
tsconfig.json                  - Type-check config (includes src/ and scripts/)
tsconfig.build.json            - Compile config (src/ -> dist/; excludes scripts/)
totopo.yaml                    - Shared onboarding anchor for this repo (example of the feature)
CHANGELOG.md                   - Generated artifact — edit scripts/changelog.yaml instead,
                                 then run pnpm generate-changelog
CONTRIBUTING.md                - Contribution guidelines
```

## Global config layout (host machine, outside this repo)

```
~/.totopo/
  .env                          - API keys (injected into every container at runtime)
  projects/<id>/
    meta.json                   - projectRoot, displayName, containerName, gitRemoteUrl
    settings.json               - runtimeMode, selectedTools
    Dockerfile                  - generated at onboarding, re-synced on each run (host-mirror)
    post-start.mjs              - copied from templates/ at onboarding
    agents/
      claude/                   - mounted as ~/.claude/ inside container
      opencode/                 - mounted as ~/.config/opencode/ + ~/.local/share/opencode/
      codex/                    - mounted as ~/.codex/ inside container
```

## Commands

```bash
pnpm build          # Compile src/ -> dist/
pnpm re:build       # Clean dist/ then compile (use after structural or rename changes)
pnpm typecheck      # Type-check src/ and scripts/ without emitting
pnpm fix:all        # Auto-fix lint and formatting (run after any edits)
pnpm check          # Full pre-commit pass: typecheck + lint + checks in scripts/check.ts
```

Workflow after making changes: `pnpm fix:all` then `pnpm check`. If `pnpm check` auto-fixes divider lines it will fail — review the diff, re-stage, and run `pnpm check` again to confirm clean.

## Rules

- Never commit without explicit user instruction.
- After editing `src/`, run `pnpm build` to compile and verify, then ask the user to run `pnpm start` on the host — Docker is not available inside the container.
- Use `.js` extensions in all TypeScript imports (e.g. `import { x } from "./foo.js"`). The project uses ESM/nodenext module resolution which requires explicit extensions — `.ts` extensions will break the build.
- Use plain ASCII in comments only: `->` instead of Unicode arrows (`->`, `<-`), `-` instead of em dashes (`-`). `pnpm check` flags violations and blocks the commit.
- All comment lines must start with a capital letter.
- Security boundary is non-negotiable: container isolation, git remote block (`protocol.allow = never`), and non-root user (`devuser`) must never be weakened.
- Read `docs/ROADMAP.md` at session start to understand current state and open items.
- For release operations, follow `docs/RELEASES.md`.
- Never edit `scripts/changelog.yaml` without explicit user approval — changelog entries must be confirmed before writing.
